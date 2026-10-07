import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseConfig } from './config/parse.ts'
import { scopeKey } from './domain/scope.ts'
import type { GitHubScope, RunnerInstance } from './domain/types.ts'
import type { Logger } from './log.ts'
import type { Sample } from './model/catalogue.ts'
import { createVanishTracker } from './model/vanish.ts'
import { type Deps, type Sources, sampleOnce } from './run.ts'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const ARN = 'arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds'
const ORG: GitHubScope = { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' }
const config = parseConfig(
  JSON.stringify({
    version: 1,
    runner_configs: [{ name: 'ci', environment: 'ci', max_runners: 10, queue_arns: [ARN] }],
    remote_write: { url: 'http://localhost:9090/api/v1/write' },
    labels: { stack: 'ci' },
    source_timeout_seconds: 1,
  }),
)
const instance: RunnerInstance = {
  id: 'i-0aaaaaaaa',
  environment: 'ci',
  instanceType: 'c7g.large',
  lifecycle: 'spot',
  state: 'running',
  launchTime: NOW - 600_000,
  orphan: false,
  scope: ORG,
}

const healthy = (): Sources => ({
  queueDepths: async () => ({
    values: new Map([[ARN, { visible: 2, inFlight: 0, delayed: 0 }]]),
    failed: [],
  }),
  queueAges: async () => new Map([[ARN, 30]]),
  instances: async () => [instance],
  registeredRunners: async scopes => ({
    values: new Map(scopes.map(s => [scopeKey(s), []])),
    failed: [],
  }),
})

function harness(sources: Sources) {
  const pushed: Sample[][] = []
  const logs: Parameters<Logger>[] = []
  const deps: Deps = {
    config,
    sources,
    sink: { push: async samples => void pushed.push([...samples]) },
    vanish: createVanishTracker(),
    now: () => NOW,
    log: (...args) => void logs.push(args),
  }
  return { deps, pushed, logs }
}

const named = (samples: readonly Sample[] | undefined, suffix: string) =>
  (samples ?? []).filter(s => s.name === `github_aws_runners_${suffix}`)

describe('sampleOnce', () => {
  it('pushes every family, the sampler series, and the global labels on all of them', async () => {
    const { deps, pushed } = harness(healthy())
    const outcome = await sampleOnce(deps)
    assert.deepEqual(outcome.up, { sqs: true, cloudwatch: true, ec2: true, github: true })
    const [batch] = pushed
    assert.equal(named(batch, 'booting_runners')[0]?.value, 1)
    assert.deepEqual(
      named(batch, 'source_up').map(s => [s.labels.source, s.value]),
      [
        ['sqs', 1],
        ['cloudwatch', 1],
        ['ec2', 1],
        ['github', 1],
      ],
    )
    assert.equal(named(batch, 'last_sample_timestamp_seconds')[0]?.value, NOW / 1000)
    assert.ok(batch?.every(s => s.labels.stack === 'ci' && s.timestamp === NOW))
  })

  it('pushes what it has when a source fails, and says which failed', async () => {
    const { deps, pushed, logs } = harness({
      ...healthy(),
      instances: async () => {
        throw new Error('UnauthorizedOperation')
      },
    })
    const outcome = await sampleOnce(deps)
    assert.equal(outcome.up.ec2, false)
    const [batch] = pushed
    assert.equal(named(batch, 'instances').length, 0)
    assert.equal(named(batch, 'booting_runners').length, 0)
    assert.equal(named(batch, 'scale_up_queue_messages').length, 3)
    assert.ok(
      logs.some(
        ([level, message, fields]) =>
          level === 'warn' && message === 'source failed' && fields?.source === 'ec2',
      ),
    )
  })

  it('does not attempt or report GitHub when it is not configured', async () => {
    const notConfigured = harness({ ...healthy(), registeredRunners: undefined })
    assert.equal((await sampleOnce(notConfigured.deps)).up.github, undefined)
    const noCredentials = harness({ ...healthy(), registeredRunners: async () => undefined })
    assert.equal((await sampleOnce(noCredentials.deps)).up.github, undefined)
    assert.equal(named(noCredentials.pushed[0], 'source_up').length, 3)
  })

  it('reports a source that outruns its budget as failed', async () => {
    const { deps } = harness({ ...healthy(), queueAges: () => new Promise(() => {}) })
    assert.equal((await sampleOnce(deps)).up.cloudwatch, false)
  })

  it('fails the invocation when the push fails', async () => {
    const { deps } = harness(healthy())
    await assert.rejects(
      sampleOnce({
        ...deps,
        sink: {
          push: async () => {
            throw new Error('remote_write: 403')
          },
        },
      }),
      /403/,
    )
  })
})
