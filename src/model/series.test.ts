import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scopeKey } from '../domain/scope.ts'
import type { GitHubScope, RegisteredRunner, RunnerInstance, Snapshot } from '../domain/types.ts'
import { queueArn as ARN, NOW, ORG, queuesOf, testConfig } from '../test/fixtures.ts'
import { PREFIX, type Sample } from './catalogue.ts'
import { buildSeries } from './series.ts'

const REPO: GitHubScope = { type: 'repo', owner: 'acme', repo: 'widgets', apiUrl: ORG.apiUrl }

const config = testConfig({
  runner_configs: [
    {
      name: 'linux',
      environment: 'ci-linux',
      max_runners: 64,
      runner_name_prefix: 'linux',
      queues: queuesOf('ci-linux-queued-builds', 'ci-linux-queued-builds_dead_letter'),
      labels: { team: 'platform' },
    },
    {
      name: 'gpu',
      environment: 'ci-gpu',
      max_runners: -1,
      runner_name_prefix: 'gpu',
      queues: queuesOf('ci-gpu-queued-builds'),
    },
  ],
  labels: { stack: 'ci' },
})

const instance = (id: string, overrides: Partial<RunnerInstance> = {}): RunnerInstance => ({
  id,
  environment: 'ci-linux',
  instanceType: 'c7g.xlarge',
  lifecycle: 'spot',
  state: 'running',
  launchTime: NOW - 5 * 60_000,
  orphan: false,
  scope: ORG,
  ...overrides,
})

const runner = (name: string, overrides: Partial<RegisteredRunner> = {}): RegisteredRunner => ({
  name,
  status: 'online',
  busy: true,
  scope: ORG,
  ...overrides,
})

const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  now: NOW,
  depths: undefined,
  ages: undefined,
  instances: undefined,
  runners: undefined,
  ...overrides,
})

const find = (series: readonly Sample[], name: string, labels: Record<string, string> = {}) =>
  series.filter(
    s =>
      s.name === `${PREFIX}${name}` && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  )
const value = (series: readonly Sample[], name: string, labels: Record<string, string> = {}) => {
  const matches = find(series, name, labels)
  assert.equal(
    matches.length,
    1,
    `expected one ${name} ${JSON.stringify(labels)}, got ${matches.length}`,
  )
  return matches[0]?.value
}

describe('buildSeries', () => {
  it('reports capacity, except for an unlimited runner config', () => {
    const series = buildSeries(config, snapshot())
    assert.equal(value(series, 'capacity', { runner_config: 'linux' }), 64)
    assert.equal(find(series, 'capacity', { runner_config: 'gpu' }).length, 0)
  })

  it('reports each configured queue by kind and visibility, and its age', () => {
    const series = buildSeries(
      config,
      snapshot({
        depths: {
          values: new Map([
            [ARN('ci-linux-queued-builds'), { visible: 3, inFlight: 1, delayed: 0 }],
            [ARN('ci-linux-queued-builds_dead_letter'), { visible: 2, inFlight: 0, delayed: 0 }],
          ]),
          failed: [{ key: ARN('ci-gpu-queued-builds'), error: 'AccessDenied' }],
        },
        ages: new Map([[ARN('ci-linux-queued-builds'), 140]]),
      }),
    )
    const linux = { runner_config: 'linux' }
    assert.equal(
      value(series, 'scale_up_queue_messages', { ...linux, queue: 'main', visibility: 'visible' }),
      3,
    )
    assert.equal(
      value(series, 'scale_up_queue_messages', {
        ...linux,
        queue: 'main',
        visibility: 'in_flight',
      }),
      1,
    )
    assert.equal(
      value(series, 'scale_up_queue_messages', {
        ...linux,
        queue: 'dead_letter',
        visibility: 'visible',
      }),
      2,
    )
    // The gpu queue failed to read: no series rather than a zero.
    assert.equal(find(series, 'scale_up_queue_messages', { runner_config: 'gpu' }).length, 0)
    assert.equal(
      value(series, 'scale_up_queue_oldest_message_age_seconds', { ...linux, queue: 'main' }),
      140,
    )
  })

  it('checks the age against what SQS saw: empty is 0, missing has none, unread keeps it', () => {
    const age = (labels: Record<string, string>, series: readonly Sample[]) =>
      find(series, 'scale_up_queue_oldest_message_age_seconds', labels).map(s => s.value)
    const series = buildSeries(
      config,
      snapshot({
        depths: {
          // The linux main queue has drained; its dead-letter queue does not exist.
          values: new Map([
            [ARN('ci-linux-queued-builds'), { visible: 0, inFlight: 0, delayed: 0 }],
          ]),
          failed: [{ key: ARN('ci-gpu-queued-builds'), error: 'AccessDenied' }],
        },
        // CloudWatch still has the last datapoint from before the queue drained.
        ages: new Map([
          [ARN('ci-linux-queued-builds'), 900],
          [ARN('ci-linux-queued-builds_dead_letter'), 0],
          [ARN('ci-gpu-queued-builds'), 45],
        ]),
      }),
    )
    assert.deepEqual(age({ runner_config: 'linux', queue: 'main' }, series), [0])
    assert.deepEqual(age({ runner_config: 'linux', queue: 'dead_letter' }, series), [])
    assert.deepEqual(age({ runner_config: 'gpu' }, series), [45])
  })

  it('reports no age it does not know, rather than zero', () => {
    const age = (labels: Record<string, string>, series: readonly Sample[]) =>
      find(series, 'scale_up_queue_oldest_message_age_seconds', labels).map(s => s.value)
    const series = buildSeries(
      config,
      snapshot({
        depths: {
          // Messages waiting on linux that CloudWatch has not published yet; gpu's main queue
          // was deleted, so SQS failed it and CloudWatch has nothing for it.
          values: new Map([
            [ARN('ci-linux-queued-builds'), { visible: 2, inFlight: 0, delayed: 0 }],
          ]),
          failed: [
            {
              key: ARN('ci-gpu-queued-builds'),
              error: 'queue ci-gpu-queued-builds does not exist',
            },
          ],
        },
        ages: new Map(),
      }),
    )
    assert.deepEqual(age({ runner_config: 'linux' }, series), [])
    assert.deepEqual(age({ runner_config: 'gpu' }, series), [])

    // With SQS down altogether, CloudWatch's datapoint is all there is, and no datapoint is unknown.
    const unread = buildSeries(
      config,
      snapshot({ ages: new Map([[ARN('ci-gpu-queued-builds'), 45]]) }),
    )
    assert.deepEqual(age({ runner_config: 'gpu' }, unread), [45])
    assert.deepEqual(age({ runner_config: 'linux' }, unread), [])
  })

  it('counts live instances by type, lifecycle and state, and orphans apart', () => {
    const series = buildSeries(
      config,
      snapshot({
        instances: [
          instance('i-0aaaaaaaa'),
          instance('i-0bbbbbbbb'),
          instance('i-0cccccccc', { lifecycle: 'on-demand', state: 'pending' }),
          instance('i-0dddddddd', { orphan: true }),
          instance('i-0eeeeeeee', { environment: 'someone-else' }),
        ],
      }),
    )
    assert.equal(
      value(series, 'instances', {
        instance_type: 'c7g.xlarge',
        lifecycle: 'spot',
        state: 'running',
      }),
      2,
    )
    assert.equal(value(series, 'instances', { lifecycle: 'on-demand', state: 'pending' }), 1)
    assert.equal(value(series, 'orphan_instances', { runner_config: 'linux' }), 1)
    assert.equal(value(series, 'orphan_instances', { runner_config: 'gpu' }), 0)
    assert.equal(find(series, 'instances', { environment: 'someone-else' }).length, 0)
  })

  it('places runners through their instance, or by an unambiguous name prefix', () => {
    const series = buildSeries(
      config,
      snapshot({
        instances: [instance('i-0aaaaaaaa'), instance('i-0bbbbbbbb', { scope: REPO })],
        runners: {
          values: new Map([
            [
              scopeKey(ORG),
              [
                runner('linuxi-0aaaaaaaa'),
                runner('linuxi-0ffffffff', { status: 'offline', busy: false }), // instance gone
                runner('laptop'), // not ours
              ],
            ],
            [scopeKey(REPO), [runner('linuxi-0bbbbbbbb', { scope: REPO, busy: false })]],
          ]),
          failed: [],
        },
      }),
    )
    const org = { runner_config: 'linux', runner_type: 'org', organization: 'acme' }
    assert.equal(value(series, 'busy_runners', org), 1)
    assert.equal(value(series, 'offline_runners', org), 1)
    assert.equal(value(series, 'registered_runners', org), 2)
    const repo = { runner_config: 'linux', runner_type: 'repo', repository: 'widgets' }
    assert.equal(value(series, 'idle_runners', repo), 1)
  })

  it('cannot place a runner whose instance has gone when its config has no name prefix', () => {
    const unprefixed = testConfig({
      runner_configs: [{ name: 'linux', environment: 'ci-linux', queues: queuesOf('q') }],
    })
    const series = buildSeries(
      unprefixed,
      snapshot({
        instances: [instance('i-0aaaaaaaa')],
        runners: {
          values: new Map([
            [
              scopeKey(ORG),
              [runner('i-0aaaaaaaa'), runner('i-0ffffffff', { status: 'offline', busy: false })],
            ],
          ]),
          failed: [],
        },
      }),
    )
    // Documented in offline_runners: the gone instance's runner belongs to no known config.
    assert.equal(value(series, 'offline_runners', { runner_config: 'linux' }), 0)
    assert.equal(value(series, 'busy_runners', { runner_config: 'linux' }), 1)
  })

  it('counts instances whose runner is not online yet, past the grace period', () => {
    const series = buildSeries(
      config,
      snapshot({
        instances: [
          instance('i-0aaaaaaaa'), // online
          instance('i-0bbbbbbbb'), // no runner yet
          instance('i-0eeeeeeee'), // JIT: registered before boot, offline until it connects
          instance('i-0cccccccc', { launchTime: NOW - 10_000 }), // too young to count
          instance('i-0dddddddd', { orphan: true }), // scale-down's problem
        ],
        runners: {
          values: new Map([
            [
              scopeKey(ORG),
              [
                runner('linuxi-0aaaaaaaa'),
                runner('linuxi-0eeeeeeee', { status: 'offline', busy: false }),
              ],
            ],
          ]),
          failed: [],
        },
      }),
    )
    assert.equal(value(series, 'booting_runners', { runner_config: 'linux' }), 2)
    assert.equal(value(series, 'booting_runners', { runner_config: 'gpu' }), 0)
    // A scope that was read but has no runners yet still reports zeros.
    assert.equal(value(series, 'idle_runners', { runner_config: 'linux', runner_type: 'org' }), 0)
  })

  it('leaves booting out where a scope could not be read or an instance has no owner tag', () => {
    const failedScope = buildSeries(
      config,
      snapshot({
        instances: [instance('i-0aaaaaaaa', { scope: REPO })],
        runners: { values: new Map(), failed: [{ key: scopeKey(REPO), error: '404' }] },
      }),
    )
    assert.equal(find(failedScope, 'booting_runners', { runner_config: 'linux' }).length, 0)
    const untagged = buildSeries(
      config,
      snapshot({
        instances: [instance('i-0aaaaaaaa', { scope: undefined })],
        runners: { values: new Map(), failed: [] },
      }),
    )
    assert.equal(find(untagged, 'booting_runners', { runner_config: 'linux' }).length, 0)
  })

  it('leaves every source-backed family out when its source failed', () => {
    const series = buildSeries(config, snapshot())
    for (const name of [
      'scale_up_queue_messages',
      'instances',
      'orphan_instances',
      'busy_runners',
      'booting_runners',
    ]) {
      assert.equal(find(series, name).length, 0, name)
    }
  })

  it('adds the runner config constant labels (run() adds the global ones)', () => {
    const [capacity] = find(buildSeries(config, snapshot()), 'capacity', { runner_config: 'linux' })
    assert.deepEqual(capacity?.labels, {
      team: 'platform',
      environment: 'ci-linux',
      runner_config: 'linux',
    })
  })
})
