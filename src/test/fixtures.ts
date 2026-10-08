import { type Cached, cached } from '../cache.ts'
import { parseConfig } from '../config/parse.ts'
import type { Config } from '../config/types.ts'
import type { GitHubScope } from '../domain/types.ts'

/** Shared test data. Not a test file itself, and not part of the bundle. */

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const queueArn = (name: string): string => `arn:aws:sqs:eu-west-1:123456789012:${name}`
/** A runner config's queues as the Terraform module writes them: the main one, and a dead letter. */
export const queuesOf = (main: string, deadLetter?: string) => ({
  main: queueArn(main),
  dead_letter: deadLetter ? queueArn(deadLetter) : null,
})
export const ORG: GitHubScope = { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' }
export const signal = new AbortController().signal

/**
 * A signal that fires after `ms`. Unlike AbortSignal.timeout, its timer keeps the test process
 * alive, so a test awaiting something that never settles sees the abort rather than an exit.
 */
export function abortsAfter(ms: number): AbortSignal {
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`aborted after ${ms}ms`)), ms)
  return controller.signal
}

/** A cache over `read`, on a clock that never moves: only invalidate() makes it read again. */
export const cachedForTest = <T>(read: () => T | undefined): Cached<T> =>
  cached(
    async () => read(),
    60_000,
    () => 0,
  )

type Document = Record<string, unknown>

/**
 * CONFIG as the Terraform module renders it with its defaults, with one runner config ("ci"),
 * overridable field by field (snake_case). `github`, `remote_write` and each runner config are
 * merged one level deep, so a test names only what it is about; `undefined` leaves a field out.
 */
export function renderedConfig(overrides: Document = {}): Document {
  const { runner_configs, github, remote_write, ...rest } = overrides
  const runnerConfigs = (runner_configs as Document[] | undefined) ?? [
    { name: 'ci', environment: 'ci', max_runners: 10, queues: queuesOf('ci-queued-builds') },
  ]
  return {
    version: 1,
    runner_configs: runnerConfigs.map(c => ({
      max_runners: -1,
      runner_name_prefix: '',
      github_api_url: 'https://api.github.com',
      labels: {},
      ...c,
    })),
    github: { credentials: { type: 'none' }, owners: [], ...(github as Document | undefined) },
    remote_write: {
      url: 'http://localhost:9090/api/v1/write',
      auth: { type: 'none' },
      headers: {},
      timeout_seconds: 10,
      ...(remote_write as Document | undefined),
    },
    labels: {},
    boot_grace_seconds: 30,
    source_timeout_seconds: 10,
    ...rest,
  }
}

/** renderedConfig, parsed. */
export const testConfig = (overrides: Document = {}): Config =>
  parseConfig(JSON.stringify(renderedConfig(overrides)))
