import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scopeKey } from './domain/scope.ts'
import type { RunnerInstance } from './domain/types.ts'
import type { Logger } from './log.ts'
import { PREFIX, type Sample } from './model/catalogue.ts'
import { createVanishTracker } from './model/vanish.ts'
import type { GitHubSource, Sink, Sources } from './ports.ts'
import { type Deps, sampleOnce } from './run.ts'
import { NOW, ORG, queueArn, testConfig } from './test/fixtures.ts'

const ARN = queueArn('ci-queued-builds')
const config = testConfig({ labels: { stack: 'ci' }, source_timeout_seconds: 1 })
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

const github = (overrides: Partial<GitHubSource> = {}): GitHubSource => ({
  isConfigured: async () => true,
  registeredRunners: async scopes => ({
    values: new Map(
      scopes.map(s => [
        scopeKey(s),
        [{ name: `ci-${instance.id}`, status: 'online' as const, busy: true, scope: s }],
      ]),
    ),
    failed: [],
  }),
  ...overrides,
})

const healthy = (): Sources => ({
  queueDepths: async () => ({
    values: new Map([[ARN, { visible: 2, inFlight: 0, delayed: 0 }]]),
    failed: [],
  }),
  queueAges: async () => new Map([[ARN, 30]]),
  instances: async () => [instance],
  github: github(),
})

const failing = async (): Promise<never> => {
  throw new Error('UnauthorizedOperation')
}

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
  (samples ?? []).filter(s => s.name === `${PREFIX}${suffix}`)

describe('sampleOnce', () => {
  it('pushes every family, the sampler series, and the global labels on all of them', async () => {
    const { deps, pushed } = harness(healthy())
    const outcome = await sampleOnce(deps)
    assert.deepEqual(outcome.up, { sqs: true, cloudwatch: true, ec2: true, github: true })
    const [batch] = pushed
    assert.equal(named(batch, 'busy_runners')[0]?.value, 1)
    assert.equal(named(batch, 'booting_runners')[0]?.value, 0)
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
    const { deps, pushed, logs } = harness({ ...healthy(), queueAges: failing })
    const outcome = await sampleOnce(deps)
    assert.equal(outcome.up.cloudwatch, false)
    const [batch] = pushed
    assert.equal(named(batch, 'scale_up_queue_oldest_message_age_seconds').length, 0)
    assert.equal(named(batch, 'scale_up_queue_messages').length, 3)
    assert.ok(
      logs.some(
        ([level, message, fields]) =>
          level === 'warn' && message === 'source failed' && fields?.source === 'cloudwatch',
      ),
    )
  })

  it('fails GitHub too when EC2 fails, so its series are not zeroed', async () => {
    let ec2Up = true
    const { deps, pushed } = harness({
      ...healthy(),
      instances: async () => (ec2Up ? [instance] : failing()),
    })
    await sampleOnce(deps)
    ec2Up = false
    const outcome = await sampleOnce(deps)
    assert.deepEqual(outcome.up, { sqs: true, cloudwatch: true, ec2: false, github: false })
    const batch = pushed[1]
    assert.equal(named(batch, 'busy_runners').length, 0, 'no zeros: unknown is not none')
    assert.equal(named(batch, 'instances').length, 0)
    assert.equal(named(batch, 'booting_runners').length, 0)
  })

  it('does not attempt or report GitHub when it is not deployed or not filled in', async () => {
    const notDeployed = harness({ ...healthy(), github: undefined })
    assert.equal((await sampleOnce(notDeployed.deps)).up.github, undefined)
    let asked = false
    const notFilled = harness({
      ...healthy(),
      github: github({
        isConfigured: async () => false,
        registeredRunners: async () => {
          asked = true
          return { values: new Map(), failed: [] }
        },
      }),
    })
    assert.equal((await sampleOnce(notFilled.deps)).up.github, undefined)
    assert.equal(asked, false)
    assert.equal(named(notFilled.pushed[0], 'source_up').length, 3)
    assert.ok(
      notFilled.logs.some(([level, message]) => level === 'warn' && /filled in/.test(message)),
    )
  })

  it('reports GitHub as failed when its credentials cannot be read', async () => {
    const { deps } = harness({ ...healthy(), github: github({ isConfigured: failing }) })
    assert.equal((await sampleOnce(deps)).up.github, false)
  })

  it('reports a source that outruns its budget as failed', async () => {
    const { deps } = harness({ ...healthy(), queueAges: () => new Promise(() => {}) })
    assert.equal((await sampleOnce(deps)).up.cloudwatch, false)
  })

  it('fails the invocation when the push fails, keeping the vanish state for the retry', async () => {
    let types = ['c7g.large', 'm7g.large']
    const { deps } = harness({
      ...healthy(),
      instances: async () => types.map(instanceType => ({ ...instance, instanceType })),
    })
    await sampleOnce(deps)
    types = ['c7g.large']
    const rejecting: Sink = {
      push: async () => {
        throw new Error('remote_write: 503')
      },
    }
    await assert.rejects(sampleOnce({ ...deps, sink: rejecting }), /503/)
    const pushed: Sample[][] = []
    await sampleOnce({ ...deps, sink: { push: async s => void pushed.push([...s]) } })
    const zeroed = named(pushed[0], 'instances').find(s => s.labels.instance_type === 'm7g.large')
    assert.equal(zeroed?.value, 0, 'the vanished type still gets its zero')
  })
})
