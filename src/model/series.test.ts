import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scopeKey } from '../domain/scope.ts'
import type { GitHubScope, RegisteredRunner, RunnerInstance, Snapshot } from '../domain/types.ts'
import { queueArn as ARN, NOW, ORG, testConfig } from '../test/fixtures.ts'
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
      queue_arns: [ARN('ci-linux-queued-builds'), ARN('ci-linux-queued-builds_dead_letter')],
      labels: { team: 'platform' },
    },
    {
      name: 'gpu',
      environment: 'ci-gpu',
      max_runners: -1,
      runner_name_prefix: 'gpu',
      queue_arns: [ARN('ci-gpu-queued-builds')],
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
          failed: [ARN('ci-gpu-queued-builds')],
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

  it('counts instances that have not registered, past the grace period', () => {
    const series = buildSeries(
      config,
      snapshot({
        instances: [
          instance('i-0aaaaaaaa'), // registered
          instance('i-0bbbbbbbb'), // booting
          instance('i-0cccccccc', { launchTime: NOW - 10_000 }), // too young to count
          instance('i-0dddddddd', { orphan: true }), // scale-down's problem
        ],
        runners: { values: new Map([[scopeKey(ORG), [runner('linuxi-0aaaaaaaa')]]]), failed: [] },
      }),
    )
    assert.equal(value(series, 'booting_runners', { runner_config: 'linux' }), 1)
    assert.equal(value(series, 'booting_runners', { runner_config: 'gpu' }), 0)
    // A scope that was read but has no runners yet still reports zeros.
    assert.equal(value(series, 'idle_runners', { runner_config: 'linux', runner_type: 'org' }), 0)
  })

  it('leaves booting out where a scope could not be read or an instance has no owner tag', () => {
    const failedScope = buildSeries(
      config,
      snapshot({
        instances: [instance('i-0aaaaaaaa', { scope: REPO })],
        runners: { values: new Map(), failed: [scopeKey(REPO)] },
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
