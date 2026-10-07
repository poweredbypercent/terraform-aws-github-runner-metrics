import { invalidLabelName } from '../domain/labels.ts'
import { err, ok, type Result } from '../domain/result.ts'
import type { QueueKind, QueueRef } from '../domain/types.ts'
import type {
  Config,
  GitHubCredentials,
  RemoteWriteAuth,
  RemoteWriteConfig,
  RunnerConfig,
} from './types.ts'

/**
 * Parses the CONFIG environment variable the Terraform module writes (JSON, snake_case).
 *
 * Every problem is collected and reported together, so a misconfiguration is fixed in one
 * deploy rather than one error per cold start. The module validates its inputs too; this is the
 * Lambda's own guard, since the variable can also be set by hand.
 */

export const CONFIG_VERSION = 1

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`invalid CONFIG:\n  - ${problems.join('\n  - ')}`)
    this.problems = problems
  }
}

type Json = unknown

class Reader {
  readonly problems: string[] = []

  object(value: Json, at: string): Record<string, Json> {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, Json>
    }
    this.problems.push(`${at} must be an object`)
    return {}
  }

  array(value: Json, at: string): Json[] {
    if (Array.isArray(value)) return value
    this.problems.push(`${at} must be an array`)
    return []
  }

  string(value: Json, at: string, pattern?: RegExp): string {
    if (typeof value === 'string' && value.length > 0 && (!pattern || pattern.test(value))) {
      return value
    }
    this.problems.push(`${at} must be a non-empty string${pattern ? ` matching ${pattern}` : ''}`)
    return ''
  }

  optionalString(value: Json, at: string, pattern?: RegExp): string | undefined {
    return value === undefined || value === null ? undefined : this.string(value, at, pattern)
  }

  number(value: Json, at: string, min: number, max: number): number {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) {
      return value
    }
    this.problems.push(`${at} must be a number from ${min} to ${max}`)
    return min
  }

  stringMap(
    value: Json,
    at: string,
    check: (key: string) => string | undefined,
  ): Record<string, string> {
    if (value === undefined || value === null) return {}
    const map: Record<string, string> = {}
    for (const [key, item] of Object.entries(this.object(value, at))) {
      const problem = check(key)
      if (problem) this.problems.push(`${at}.${key} ${problem}`)
      else map[key] = this.string(item, `${at}.${key}`)
    }
    return map
  }
}

/** Standard or FIFO (`.fifo`) queues. */
const ARN_SQS = /^arn:(aws[a-z-]*):sqs:([a-z0-9-]+):(\d{12}):([A-Za-z0-9_-]{1,75}(?:\.fifo)?)$/
/** One secret, never a wildcard: the role's grant is scoped to exactly what is named here. */
const ARN_SECRET = /^arn:aws[a-z-]*:secretsmanager:[a-z0-9-]+:\d{12}:secret:[A-Za-z0-9/_+=.@-]+$/
const ARN_ROLE = /^arn:aws[a-z-]*:iam::\d{12}:role\/[A-Za-z0-9/_+=,.@-]+$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const RESERVED_HEADERS = [
  'authorization',
  'content-encoding',
  'content-type',
  'content-length',
  'host',
  'user-agent',
  'x-prometheus-remote-write-version',
]
/** SigV4's own headers (x-amz-date, x-amz-security-token, ...) are the signer's to set. */
const isReservedHeader = (name: string): boolean =>
  RESERVED_HEADERS.includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-amz-')
/** An organisation, or "owner/repo", as GitHub names them. */
const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\/[A-Za-z0-9._-]{1,100})?$/

/** SQS endpoints by partition; the URL is derived from the ARN so the config stays small. */
const DNS_SUFFIX: Record<string, string> = {
  aws: 'amazonaws.com',
  'aws-us-gov': 'amazonaws.com',
  'aws-cn': 'amazonaws.com.cn',
}

export function queueFromArn(arn: string): Result<QueueRef> {
  const match = arn.match(ARN_SQS)
  if (!match) return err(`${arn} is not an SQS queue ARN`)
  const [, partition = '', region = '', account = '', name = ''] = match
  const suffix = DNS_SUFFIX[partition]
  if (!suffix) return err(`${arn} is in partition ${partition}, which is not supported`)
  const kind: QueueKind = /_dead_letter(\.fifo)?$/.test(name) ? 'dead_letter' : 'main'
  return ok({ arn, name, url: `https://sqs.${region}.${suffix}/${account}/${name}`, kind })
}

/**
 * An endpoint URL, without credentials or a query string in it: those would end up in logs and
 * error messages. https is required wherever a credential travels; plain http stays possible for
 * an unauthenticated receiver on a private network (and for the end-to-end test).
 */
function endpointUrl(r: Reader, value: Json, at: string, requireHttps: boolean): string {
  const text = r.string(value, at)
  if (!text) return ''
  let url: URL
  try {
    url = new URL(text)
  } catch {
    r.problems.push(`${at} must be an absolute URL`)
    return ''
  }
  const allowed = requireHttps ? ['https:'] : ['https:', 'http:']
  if (!allowed.includes(url.protocol)) {
    r.problems.push(`${at} must use ${requireHttps ? 'https' : 'http or https'}`)
  }
  if (url.username || url.password) r.problems.push(`${at} must not contain credentials`)
  if (url.search || url.hash) r.problems.push(`${at} must not contain a query string or fragment`)
  return text.replace(/\/+$/, '')
}

function runnerConfig(r: Reader, value: Json, at: string): RunnerConfig {
  const o = r.object(value, at)
  const queues: QueueRef[] = []
  for (const [i, arn] of r.array(o.queue_arns, `${at}.queue_arns`).entries()) {
    const queue = queueFromArn(r.string(arn, `${at}.queue_arns[${i}]`))
    if (queue.ok) queues.push(queue.value)
    else r.problems.push(`${at}.queue_arns[${i}]: ${queue.error}`)
  }
  const max = o.max_runners
  return {
    name: r.string(o.name, `${at}.name`, /^[A-Za-z0-9_.-]+$/),
    environment: r.string(o.environment, `${at}.environment`, /^[A-Za-z0-9_-]+$/),
    maxRunners:
      max === null || max === undefined || max === -1
        ? null
        : r.number(max, `${at}.max_runners`, 0, 100_000),
    runnerNamePrefix: typeof o.runner_name_prefix === 'string' ? o.runner_name_prefix : '',
    // Always https: the App's installation tokens are sent there.
    githubApiUrl: endpointUrl(
      r,
      o.github_api_url ?? 'https://api.github.com',
      `${at}.github_api_url`,
      true,
    ),
    queues,
    labels: r.stringMap(o.labels, `${at}.labels`, invalidLabelName),
  }
}

function githubCredentials(r: Reader, value: Json, at: string): GitHubCredentials {
  const o = r.object(value ?? { type: 'none' }, at)
  switch (o.type) {
    case 'none':
      return { type: 'none' }
    case 'secret':
      return { type: 'secret', secretArn: r.string(o.secret_arn, `${at}.secret_arn`, ARN_SECRET) }
    case 'ssm':
      return {
        type: 'ssm',
        appIdParameter: r.string(o.app_id_parameter, `${at}.app_id_parameter`),
        privateKeyParameter: r.string(o.private_key_parameter, `${at}.private_key_parameter`),
      }
    default:
      r.problems.push(`${at}.type must be one of none, secret, ssm`)
      return { type: 'none' }
  }
}

function remoteWriteAuth(r: Reader, value: Json, at: string): RemoteWriteAuth {
  const o = r.object(value ?? { type: 'none' }, at)
  switch (o.type) {
    case 'none':
      return { type: 'none' }
    case 'sigv4': {
      const roleArn = r.optionalString(o.role_arn, `${at}.role_arn`, ARN_ROLE)
      const externalId = r.optionalString(o.external_id, `${at}.external_id`)
      if (externalId && !roleArn) r.problems.push(`${at}.external_id needs role_arn`)
      return {
        type: 'sigv4',
        region: r.string(o.region, `${at}.region`, /^[a-z0-9-]+$/),
        service: r.string(o.service ?? 'aps', `${at}.service`),
        roleArn,
        externalId,
        // STS: 2-64 characters of [\w+=,.@-].
        sessionName: r.string(
          o.session_name ?? 'github-runner-metrics',
          `${at}.session_name`,
          /^[\w+=,.@-]{2,64}$/,
        ),
      }
    }
    case 'basic':
    case 'bearer':
      return { type: o.type, secretArn: r.string(o.secret_arn, `${at}.secret_arn`, ARN_SECRET) }
    default:
      r.problems.push(`${at}.type must be one of none, sigv4, basic, bearer`)
      return { type: 'none' }
  }
}

function remoteWrite(r: Reader, value: Json, at: string): RemoteWriteConfig {
  const o = r.object(value, at)
  const auth = remoteWriteAuth(r, o.auth, `${at}.auth`)
  return {
    url: endpointUrl(r, o.url, `${at}.url`, auth.type !== 'none'),
    auth,
    headers: r.stringMap(o.headers, `${at}.headers`, name =>
      !HEADER_NAME.test(name)
        ? 'is not a valid header name'
        : isReservedHeader(name)
          ? 'is set by the remote-write client and cannot be overridden'
          : undefined,
    ),
    timeoutMs: r.number(o.timeout_seconds ?? 10, `${at}.timeout_seconds`, 1, 60) * 1000,
  }
}

export function parseConfig(raw: string | undefined): Config {
  const r = new Reader()
  let json: Json
  try {
    json = JSON.parse(raw ?? '')
  } catch {
    throw new ConfigError(['CONFIG must be set to the JSON the Terraform module generates'])
  }
  const o = r.object(json, 'CONFIG')
  if (o.version !== CONFIG_VERSION) {
    r.problems.push(
      `CONFIG.version must be ${CONFIG_VERSION} (this Lambda reads version ${CONFIG_VERSION})`,
    )
  }
  const runnerConfigs = r
    .array(o.runner_configs, 'runner_configs')
    .map((item, i) => runnerConfig(r, item, `runner_configs[${i}]`))
  if (runnerConfigs.length === 0)
    r.problems.push('runner_configs must list at least one runner config')
  for (const key of ['name', 'environment'] as const) {
    const seen = runnerConfigs.map(c => c[key])
    const duplicate = seen.find((v, i) => v && seen.indexOf(v) !== i)
    if (duplicate) r.problems.push(`runner_configs: ${key} "${duplicate}" appears more than once`)
  }
  const github = r.object(o.github ?? {}, 'github')
  const credentials = githubCredentials(r, github.credentials, 'github.credentials')
  const owners = r
    .array(github.owners ?? [], 'github.owners')
    // GitHub names are case-insensitive; compared lower-cased (runners.ts).
    .map((owner, i) => r.string(owner, `github.owners[${i}]`, OWNER).toLowerCase())
  // The instances' tags name the scopes, and a job may be able to set its own instance's tags:
  // without an allowlist it could point the App at any organisation the App is installed on.
  if (credentials.type !== 'none' && owners.length === 0) {
    r.problems.push('github.owners must list the organisations or "owner/repo" targets to query')
  }
  const config: Config = {
    runnerConfigs,
    github: { credentials, owners },
    remoteWrite: remoteWrite(r, o.remote_write, 'remote_write'),
    labels: r.stringMap(o.labels, 'labels', invalidLabelName),
    bootGraceSeconds: r.number(o.boot_grace_seconds ?? 30, 'boot_grace_seconds', 0, 3600),
    sourceTimeoutMs:
      r.number(o.source_timeout_seconds ?? 10, 'source_timeout_seconds', 1, 60) * 1000,
  }
  if (r.problems.length > 0) throw new ConfigError(r.problems)
  return config
}
