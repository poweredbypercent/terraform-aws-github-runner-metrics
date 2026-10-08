import { invalidLabelName } from '../domain/labels.ts'
import { err, ok, type Result } from '../domain/result.ts'
import type { QueueKind, QueueRef, RunnerConfig } from '../domain/types.ts'
import { LIMITS, PATTERNS, RESERVED_HEADER_PREFIX, RESERVED_HEADERS } from './rules.ts'
import type { Config, GitHubCredentials, RemoteWriteAuth, RemoteWriteConfig } from './types.ts'

/**
 * Parses the CONFIG environment variable the Terraform module writes (JSON, snake_case).
 *
 * Every problem is collected and reported together, so a misconfiguration is fixed in one
 * deploy rather than one error per cold start. The module refuses the same values first (see
 * rules.ts); this is the Lambda's own guard, since the variable can also be set by hand. Every
 * field the module renders is required here: its defaults live in the module alone.
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

  /** A string that may be empty, such as a runner name prefix. */
  text(value: Json, at: string): string {
    if (typeof value === 'string') return value
    this.problems.push(`${at} must be a string`)
    return ''
  }

  number(value: Json, at: string, { min, max }: { min: number; max: number }): number {
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
    valuePattern?: RegExp,
  ): Record<string, string> {
    const map: Record<string, string> = {}
    for (const [key, item] of Object.entries(this.object(value, at))) {
      const problem = check(key)
      if (problem) this.problems.push(`${at}.${key} ${problem}`)
      else map[key] = this.string(item, `${at}.${key}`, valuePattern)
    }
    return map
  }
}

const pattern = (name: keyof typeof PATTERNS) => new RegExp(PATTERNS[name])
const RUNNER_CONFIG_NAME = pattern('runnerConfigName')
const ENVIRONMENT = pattern('environment')
const SQS_QUEUE_ARN = pattern('sqsQueueArn')
const SECRET_ARN = pattern('secretArn')
const ROLE_ARN = pattern('roleArn')
const ENDPOINT_URL = pattern('endpointUrl')
const OWNER = pattern('owner')
const HEADER_NAME = pattern('headerName')
const CREDENTIAL_HEADER = pattern('credentialHeader')
const HEADER_VALUE = pattern('headerValue')
const AWS_NAME = pattern('awsName')
const EXTERNAL_ID = pattern('externalId')

/** A queue the Terraform module named, with its kind; the ARN gives the name CloudWatch uses. */
export function queueFromArn(arn: string, kind: QueueKind): Result<QueueRef> {
  const match = arn.match(SQS_QUEUE_ARN)
  if (!match) return err(`${arn} is not an SQS queue ARN`)
  return ok({ arn, name: match[1] ?? '', kind })
}

/** The main queue, and the dead-letter queue when there is one. */
function queues(r: Reader, value: Json, at: string): QueueRef[] {
  const o = r.object(value, at)
  const named: [QueueKind, string | undefined][] = [
    ['main', r.string(o.main, `${at}.main`)],
    ['dead_letter', r.optionalString(o.dead_letter, `${at}.dead_letter`)],
  ]
  const refs: QueueRef[] = []
  for (const [kind, arn] of named) {
    if (!arn) continue
    const queue = queueFromArn(arn, kind)
    if (queue.ok) refs.push(queue.value)
    else r.problems.push(`${at}.${kind}: ${queue.error}`)
  }
  return refs
}

/**
 * An endpoint URL, without credentials, a query string or a fragment in it: those would end up in
 * logs and error messages. https is required wherever a credential travels; plain http stays
 * possible for an unauthenticated receiver on a private network (and for the end-to-end test).
 */
function endpointUrl(r: Reader, value: Json, at: string, requireHttps: boolean): string {
  if (typeof value !== 'string' || !ENDPOINT_URL.test(value)) {
    r.problems.push(
      `${at} must be an http(s) URL without credentials, a query string or a fragment`,
    )
    return ''
  }
  if (requireHttps && !value.startsWith('https://')) r.problems.push(`${at} must use https`)
  return value.replace(/\/+$/, '')
}

function runnerConfig(r: Reader, value: Json, at: string): RunnerConfig {
  const o = r.object(value, at)
  return {
    name: r.string(o.name, `${at}.name`, RUNNER_CONFIG_NAME),
    environment: r.string(o.environment, `${at}.environment`, ENVIRONMENT),
    maxRunners:
      o.max_runners === -1 ? null : r.number(o.max_runners, `${at}.max_runners`, LIMITS.maxRunners),
    runnerNamePrefix: r.text(o.runner_name_prefix, `${at}.runner_name_prefix`),
    // Always https: the App's installation tokens are sent there.
    githubApiUrl: endpointUrl(r, o.github_api_url, `${at}.github_api_url`, true),
    queues: queues(r, o.queues, `${at}.queues`),
    labels: r.stringMap(o.labels, `${at}.labels`, invalidLabelName),
  }
}

function githubCredentials(r: Reader, value: Json, at: string): GitHubCredentials {
  const o = r.object(value, at)
  switch (o.type) {
    case 'none':
      return { type: 'none' }
    case 'secret':
      return { type: 'secret', secretArn: r.string(o.secret_arn, `${at}.secret_arn`, SECRET_ARN) }
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
  const o = r.object(value, at)
  switch (o.type) {
    case 'none':
      return { type: 'none' }
    case 'sigv4': {
      const roleArn = r.optionalString(o.role_arn, `${at}.role_arn`, ROLE_ARN)
      const externalId = r.optionalString(o.external_id, `${at}.external_id`, EXTERNAL_ID)
      if (externalId && !roleArn) r.problems.push(`${at}.external_id needs role_arn`)
      const { min, max } = LIMITS.externalIdLength
      if (externalId && (externalId.length < min || externalId.length > max)) {
        r.problems.push(`${at}.external_id must be ${min}-${max} characters`)
      }
      return {
        type: 'sigv4',
        region: r.string(o.region, `${at}.region`, AWS_NAME),
        service: r.string(o.service, `${at}.service`, AWS_NAME),
        roleArn,
        externalId,
        // STS: 2-64 characters of [\w+=,.@-]. The module names it, so this only guards a hand edit.
        sessionName: r.string(o.session_name, `${at}.session_name`, /^[\w+=,.@-]{2,64}$/),
      }
    }
    case 'basic':
    case 'bearer':
      return { type: o.type, secretArn: r.string(o.secret_arn, `${at}.secret_arn`, SECRET_ARN) }
    default:
      r.problems.push(`${at}.type must be one of none, sigv4, basic, bearer`)
      return { type: 'none' }
  }
}

const isReservedHeader = (name: string): boolean =>
  RESERVED_HEADERS.includes(name.toLowerCase()) ||
  name.toLowerCase().startsWith(RESERVED_HEADER_PREFIX)

function remoteWrite(r: Reader, value: Json, at: string): RemoteWriteConfig {
  const o = r.object(value, at)
  const auth = remoteWriteAuth(r, o.auth, `${at}.auth`)
  return {
    url: endpointUrl(r, o.url, `${at}.url`, auth.type !== 'none'),
    auth,
    headers: r.stringMap(
      o.headers,
      `${at}.headers`,
      name =>
        !HEADER_NAME.test(name)
          ? 'is not a valid header name'
          : isReservedHeader(name)
            ? 'is set by the remote-write client and cannot be overridden'
            : CREDENTIAL_HEADER.test(name.toLowerCase())
              ? 'looks like a credential: use remote_write basic or bearer auth, which keeps it in a secret'
              : undefined,
      HEADER_VALUE,
    ),
    timeoutMs: r.number(o.timeout_seconds, `${at}.timeout_seconds`, LIMITS.timeoutSeconds) * 1000,
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
  const github = r.object(o.github, 'github')
  const credentials = githubCredentials(r, github.credentials, 'github.credentials')
  const owners = r
    .array(github.owners, 'github.owners')
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
    bootGraceSeconds: r.number(o.boot_grace_seconds, 'boot_grace_seconds', LIMITS.bootGraceSeconds),
    sourceTimeoutMs:
      r.number(o.source_timeout_seconds, 'source_timeout_seconds', LIMITS.timeoutSeconds) * 1000,
  }
  if (r.problems.length > 0) throw new ConfigError(r.problems)
  return config
}
