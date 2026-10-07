import type { Config } from './config/types.ts'
import { err, type Result } from './domain/result.ts'
import { settle } from './domain/settle.ts'
import type { RunnerInstance, Snapshot, SourceHealth, SourceName } from './domain/types.ts'
import { METRICS, type Sample, sample } from './model/catalogue.ts'
import { buildSeries } from './model/series.ts'
import type { VanishTracker } from './model/vanish.ts'
import type { GitHubSource, Logger, RegisteredRunners, Sink, Sources } from './ports.ts'

/**
 * One sample of the runner stack: read every source, build the series, push them.
 *
 * Sources run in parallel, each inside its own time budget, and fail on their own: a failed source
 * leaves its series out and reports source_up=0, and the rest are still pushed. GitHub waits only
 * for EC2, because the instances say which organisations and repositories to ask about. The push
 * itself is the one failure that fails the invocation.
 */

export interface Deps {
  readonly config: Config
  readonly sources: Sources
  readonly sink: Sink
  readonly vanish: VanishTracker
  readonly now: () => number
  readonly log: Logger
}

export interface Outcome {
  readonly series: number
  readonly up: SourceHealth
}

export async function sampleOnce(deps: Deps): Promise<Outcome> {
  const now = deps.now()
  const { snapshot, up } = await readSources(deps, now)
  const proposed = deps.vanish.apply(buildSeries(deps.config, snapshot), up, now)
  const series = finalise(deps.config.labels, proposed.samples, up, now, deps.now())
  await deps.sink.push(series)
  proposed.commit()
  deps.log('info', 'pushed', { series: series.length, up })
  return { series: series.length, up }
}

async function readSources(
  deps: Deps,
  now: number,
): Promise<{ snapshot: Snapshot; up: SourceHealth }> {
  const { sources, log } = deps
  const budget = deps.config.sourceTimeoutMs

  const instances = settle(budget, signal => sources.instances(signal))
  const [depths, ages, known, runners] = await Promise.all([
    settle(budget, signal => sources.queueDepths(signal)),
    settle(budget, signal => sources.queueAges(now, signal)),
    instances,
    sources.github ? readGitHub(sources.github, instances, budget, log) : undefined,
  ])

  const up: { [S in SourceName]?: boolean } = {
    sqs: depths.ok && depths.value.failed.length === 0,
    cloudwatch: ages.ok,
    ec2: known.ok,
  }
  if (runners) up.github = runners.ok && runners.value.failed.length === 0

  for (const [source, result] of [
    ['sqs', depths],
    ['cloudwatch', ages],
    ['ec2', known],
    ['github', runners],
  ] as const) {
    if (result && !result.ok) log('warn', 'source failed', { source, error: result.error })
  }
  // Each with its reason: a missing permission, an App not installed, a timeout.
  if (depths.ok && depths.value.failed.length > 0) {
    log('warn', 'queues not read', { queues: depths.value.failed })
  }
  if (runners?.ok && runners.value.failed.length > 0) {
    log('warn', 'GitHub scopes not read', { scopes: runners.value.failed })
  }

  return {
    snapshot: {
      now,
      depths: depths.ok ? depths.value : undefined,
      ages: ages.ok ? ages.value : undefined,
      instances: known.ok ? known.value : undefined,
      runners: runners?.ok ? runners.value : undefined,
    },
    up,
  }
}

/** GitHub's answer, or undefined when it is skipped: the App's credentials are not filled in. */
async function readGitHub(
  github: GitHubSource,
  instances: Promise<Result<readonly RunnerInstance[]>>,
  budget: number,
  log: Logger,
): Promise<Result<RegisteredRunners> | undefined> {
  const configured = await settle(budget, signal => github.isConfigured(signal))
  if (!configured.ok) return err(configured.error)
  if (!configured.value) {
    log('warn', 'GitHub skipped: the App credentials have not been filled in yet')
    return undefined
  }
  const known = await instances
  // Without the instances there is nothing to ask about; reading no scopes would look like a
  // healthy GitHub reporting no runners at all.
  if (!known.ok) return err(`needs ec2, which failed: ${known.error}`)
  const scopes = known.value.flatMap(i => (i.scope ? [i.scope] : []))
  return settle(budget, signal => github.registeredRunners(scopes, signal))
}

/** The sampler's own series, and the global constant labels on every series. */
function finalise(
  labels: Config['labels'],
  samples: readonly Sample[],
  up: SourceHealth,
  now: number,
  finished: number,
): Sample[] {
  const series = [
    ...samples,
    ...Object.entries(up).map(([source, answered]) =>
      sample(METRICS.sourceUp, { source }, answered ? 1 : 0, now),
    ),
    sample(METRICS.sampleDuration, {}, (finished - now) / 1000, now),
    sample(METRICS.lastSampleTimestamp, {}, now / 1000, now),
  ]
  return series.map(s => ({ ...s, labels: { ...labels, ...s.labels } }))
}
