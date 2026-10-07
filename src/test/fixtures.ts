import { type Cached, cached } from '../cache.ts'
import { parseConfig } from '../config/parse.ts'
import type { Config } from '../config/types.ts'
import type { GitHubScope } from '../domain/types.ts'

/** Shared test data. Not a test file itself, and not part of the bundle. */

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const queueArn = (name: string): string => `arn:aws:sqs:eu-west-1:123456789012:${name}`
/** A runner config's queues as the Terraform module writes them: the main one, and a dead letter. */
export const queuesOf = (main: string, deadLetter?: string) => [
  { arn: queueArn(main), kind: 'main' },
  ...(deadLetter ? [{ arn: queueArn(deadLetter), kind: 'dead_letter' }] : []),
]
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

/** A parsed config with one runner config ("ci"), overridable field by field (snake_case). */
export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig(
    JSON.stringify({
      version: 1,
      runner_configs: [
        {
          name: 'ci',
          environment: 'ci',
          max_runners: 10,
          queues: queuesOf('ci-queued-builds'),
        },
      ],
      remote_write: { url: 'http://localhost:9090/api/v1/write' },
      ...overrides,
    }),
  )
}
