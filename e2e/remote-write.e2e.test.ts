/**
 * The sampler end to end against a real Prometheus remote-write receiver: the real model,
 * encoding, auth headers and transport, with only the AWS and GitHub sources faked. This is the
 * test that catches a protobuf or snappy regression, which no unit test can.
 *
 *   scripts/e2e.sh   (starts Prometheus in Docker, runs this, stops it)
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseConfig } from '../src/config/parse.ts'
import { scopeKey } from '../src/domain/scope.ts'
import type { GitHubScope, RunnerInstance } from '../src/domain/types.ts'
import { createVanishTracker } from '../src/model/vanish.ts'
import type { Sources } from '../src/ports.ts'
import { type Deps, sampleOnce } from '../src/run.ts'
import { noAuth } from '../src/sinks/auth.ts'
import { remoteWriteSink } from '../src/sinks/remote-write/sink.ts'

const PROMETHEUS = process.env.E2E_PROMETHEUS_URL
if (!PROMETHEUS) {
  throw new Error('E2E_PROMETHEUS_URL is not set: run scripts/e2e.sh, which starts Prometheus')
}

// A run-unique label, so repeated runs against the same Prometheus never see each other's series.
const RUN = `e2e-${Date.now()}`
const ARN = 'arn:aws:sqs:eu-west-1:123456789012:e2e-queued-builds'
const ORG: GitHubScope = { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' }

const config = parseConfig(
  JSON.stringify({
    version: 1,
    runner_configs: [
      {
        name: 'linux',
        environment: 'e2e',
        max_runners: 8,
        runner_name_prefix: 'linux',
        queues: [{ arn: ARN, kind: 'main' }],
      },
    ],
    remote_write: { url: `${PROMETHEUS}/api/v1/write` },
    labels: { e2e_run: RUN },
  }),
)

async function query(
  promql: string,
): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  const response = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent(promql)}`)
  const body = (await response.json()) as {
    data: { result: { metric: Record<string, string>; value: [number, string] }[] }
  }
  return body.data.result
}

const one = async (promql: string): Promise<number> => {
  const result = await query(promql)
  assert.equal(result.length, 1, `${promql} returned ${result.length} series`)
  return Number(result[0]?.value[1])
}

function deps(sources: Sources, now: () => number): Deps {
  return {
    config,
    sources,
    now,
    vanish: createVanishTracker(2),
    log: () => {},
    sink: remoteWriteSink({
      url: config.remoteWrite.url,
      auth: noAuth,
      headers: config.remoteWrite.headers,
      timeoutMs: 5000,
      userAgent: 'terraform-aws-github-runner-metrics/e2e',
      fetch,
    }),
  }
}

const instance = (id: string, instanceType: string, now: number): RunnerInstance => ({
  id,
  environment: 'e2e',
  instanceType,
  lifecycle: 'spot',
  state: 'running',
  launchTime: now - 10 * 60_000,
  orphan: false,
  scope: ORG,
})

describe('remote write to Prometheus', () => {
  it('lands every family with its labels, and zeros a series that vanishes', async () => {
    const start = Date.now()
    let now = start
    let instanceTypes = ['c7g.large', 'm7g.large']
    const sources: Sources = {
      queueDepths: async () => ({
        values: new Map([[ARN, { visible: 4, inFlight: 1, delayed: 0 }]]),
        failed: [],
      }),
      queueAges: async () => new Map([[ARN, 95]]),
      instances: async () => instanceTypes.map((type, i) => instance(`i-0${i}aaaaaaa`, type, now)),
      github: {
        isConfigured: async () => true,
        registeredRunners: async scopes => ({
          values: new Map(
            scopes.map(s => [
              scopeKey(s),
              [{ name: 'linuxi-00aaaaaaa', status: 'online' as const, busy: true, scope: s }],
            ]),
          ),
          failed: [],
        }),
      },
    }
    const sampler = deps(sources, () => now)

    await sampleOnce(sampler)
    const run = `e2e_run="${RUN}"`
    assert.equal(await one(`github_aws_runners_capacity{${run}}`), 8)
    assert.equal(
      await one(
        `github_aws_runners_scale_up_queue_messages{${run},queue="main",visibility="visible"}`,
      ),
      4,
    )
    assert.equal(
      await one(`github_aws_runners_scale_up_queue_oldest_message_age_seconds{${run}}`),
      95,
    )
    assert.equal(await one(`github_aws_runners_instances{${run},instance_type="m7g.large"}`), 1)
    assert.equal(await one(`github_aws_runners_busy_runners{${run},organization="acme"}`), 1)
    assert.equal(await one(`github_aws_runners_booting_runners{${run}}`), 1)
    assert.equal(await one(`count(github_aws_runners_source_up{${run}} == 1)`), 4)
    const [busy] = await query(`github_aws_runners_busy_runners{${run}}`)
    assert.equal(busy?.metric.repository, undefined, 'an empty repository label is not sent')
    assert.equal(busy?.metric.runner_type, 'org')

    // A minute later the m7g instance is gone: its series reads 0 rather than lingering at 1.
    now = start + 60_000
    instanceTypes = ['c7g.large']
    await sampleOnce(sampler)
    const latest = await query(
      `github_aws_runners_instances{${run},instance_type="m7g.large"} @ ${now / 1000}`,
    )
    assert.equal(Number(latest[0]?.value[1]), 0)
  })
})
