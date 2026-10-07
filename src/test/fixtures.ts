import { parseConfig } from '../config/parse.ts'
import type { Config } from '../config/types.ts'
import type { GitHubScope } from '../domain/types.ts'

/** Shared test data. Not a test file itself, and not part of the bundle. */

export const NOW = Date.parse('2026-10-07T12:00:00Z')
export const queueArn = (name: string): string => `arn:aws:sqs:eu-west-1:123456789012:${name}`
export const ORG: GitHubScope = { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' }
export const signal = new AbortController().signal

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
          queue_arns: [queueArn('ci-queued-builds')],
        },
      ],
      remote_write: { url: 'http://localhost:9090/api/v1/write' },
      ...overrides,
    }),
  )
}
