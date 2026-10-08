import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BUILT_IN_LABELS, LABEL_NAME } from '../domain/labels.ts'
import { LIMITS, PATTERNS, RESERVED_HEADER_PREFIX, RESERVED_HEADERS } from './rules.ts'

/**
 * The Terraform module refuses what the Lambda would reject before it deploys, so its rules have
 * to be the Lambda's. They are written twice, in two languages; this holds the copies to each
 * other. Every regex() in the module is one of the Lambda's patterns, character for character, or
 * one the module alone needs (below, with why); every pattern of the Lambda's is used there; and
 * the limits and reserved names match. A copy loosened on either side fails here.
 */
const root = new URL('../../', import.meta.url)
const terraform = readdirSync(root)
  .filter(name => name.endsWith('.tf'))
  .map(name => readFileSync(new URL(name, root), 'utf8'))
  .join('\n')

/** The pattern of every regex("...") in the module, with HCL's string escapes undone. */
const modulePatterns = [...terraform.matchAll(/regex\("((?:[^"\\]|\\.)*)"/g)].map(
  ([, quoted = '']) => quoted.replace(/\\(.)/g, '$1'),
)

const lambdaPatterns = new Map<string, string>([
  ...Object.entries(PATTERNS).map(([name, source]) => [source, name] as const),
  [LABEL_NAME.source, 'labelName'],
])

/** Patterns for values the Lambda never sees, or that the module reads rather than checks. */
const MODULE_ONLY: Readonly<Record<string, string>> = {
  '^ec2\\.([a-z0-9-]+)\\.': "reads the region from the provider's EC2 endpoint",
  '^https://[^/]*\\.([a-z]{2}(?:-[a-z]+)+-[0-9]+)\\.(?:[a-z0-9-]+\\.)*amazonaws\\.com(?:\\.cn)?(?:[:/]|$)':
    'reads the SigV4 region from an AWS hostname, and requires one when it finds none',
  '^https://[^/]+\\.ghe\\.com/?$': 'recognises GHE.com, whose API is on an api. subdomain',
  '^https://[A-Za-z0-9_.-]+(:[0-9]{1,5})?/?$':
    'github_enterprise_server_url, a base URL; the API URL derived from it is an endpointUrl',
  '^/?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$': "SSM parameter names, for the role's policy",
  '^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:key/[A-Za-z0-9-]+$': "KMS keys, for the role's policy",
  '^\\S+$': 'the S3 object version of the zip',
  '^[A-Za-z0-9_-]{1,40}$': 'name_prefix, within the AWS name limits',
  '^(rate\\(1 (minute|hour)\\)|rate\\(([2-9]|[1-9][0-9]+) (minutes|hours)\\)|cron\\(.+\\))$':
    'the schedule, as EventBridge accepts it',
  '^/([^/]+/)*$': 'the IAM role path',
}

/** Where the module bounds each limited value. */
const MODULE_LIMITS: readonly [string, { min: number; max: number }][] = [
  ['c.max_runners', LIMITS.maxRunners],
  ['var.remote_write.timeout_seconds', LIMITS.timeoutSeconds],
  ['var.source_timeout_seconds', LIMITS.timeoutSeconds],
  ['var.boot_grace_seconds', LIMITS.bootGraceSeconds],
  ['length(var.remote_write.auth.sigv4.external_id)', LIMITS.externalIdLength],
]

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const moduleList = (pattern: RegExp, what: string): string[] => {
  const list = terraform.match(pattern)?.[1]
  assert.ok(list, `${what} not found in the Terraform module`)
  return JSON.parse(list) as string[]
}

describe('the Terraform module and the Lambda', () => {
  it("check with the Lambda's own patterns, or ones only the module needs", () => {
    const unknown = modulePatterns.filter(p => !lambdaPatterns.has(p) && !(p in MODULE_ONLY))
    assert.deepEqual(
      unknown,
      [],
      "a regex() in the module's .tf files is not one of src/config/rules.ts's patterns: a copy that drifted, or one to list in MODULE_ONLY with why",
    )
  })

  it("use every one of the Lambda's patterns, and every module-only one", () => {
    const used = new Set(modulePatterns)
    const unused = [...lambdaPatterns.keys(), ...Object.keys(MODULE_ONLY)].filter(p => !used.has(p))
    assert.deepEqual(
      unused,
      [],
      'the module would accept what the Lambda rejects, or a listed pattern is gone',
    )
  })

  it('bound the same values the same way', () => {
    for (const [subject, { min, max }] of MODULE_LIMITS) {
      // Every bound the module puts on it, so a second copy or a changed digit shows.
      const written = new RegExp(`${escapeRegExp(subject)} (>=|<=) ([0-9]+)`, 'g')
      const bounds = new Set([...terraform.matchAll(written)].map(([, op, n]) => `${op} ${n}`))
      assert.deepEqual([...bounds].sort(), [`<= ${max}`, `>= ${min}`].sort(), subject)
    }
  })

  it('reserve the same headers', () => {
    assert.deepEqual(
      moduleList(/!contains\((\[[^\]]*\]), lower\(name\)\)/, 'The reserved headers (variables.tf)'),
      [...RESERVED_HEADERS],
    )
    assert.ok(terraform.includes(`!startswith(lower(name), "${RESERVED_HEADER_PREFIX}")`))
  })

  it('reserve the same built-in labels', () => {
    assert.deepEqual(
      moduleList(/built_in_labels\s*=\s*(\[[^\]]*\])/, 'local.built_in_labels (validation.tf)'),
      [...BUILT_IN_LABELS],
    )
  })
})
