import type { Config } from './config/types.ts'
import { type Result, settle } from './domain/result.ts'
import type {
  GitHubScope,
  PartialResult,
  QueueDepth,
  RegisteredRunner,
  RunnerInstance,
  Snapshot,
  SourceName,
} from './domain/types.ts'
import type { Logger } from './log.ts'
import { METRICS, type Sample, sample } from './model/catalogue.ts'
import { buildSeries } from './model/series.ts'
import type { VanishTracker } from './model/vanish.ts'
import type { Sink } from './sinks/remote-write/sink.ts'

/**
 * One sample of the runner stack: read every source, build the series, push them.
 *
 * Sources run in parallel, each inside its own time budget, and fail on their own: a failed source
 * leaves its series out and reports source_up=0, and the rest are still pushed. GitHub waits only
 * for EC2, because the instances say which organisations and repositories to ask about. The push
 * itself is the one failure that fails the invocation.
 */

export interface Sources {
  queueDepths(signal: AbortSignal): Promise<PartialResult<string, QueueDepth>>
  queueAges(now: number, signal: AbortSignal): Promise<ReadonlyMap<string, number>>
  instances(signal: AbortSignal): Promise<readonly RunnerInstance[]>
  /** undefined when GitHub is not configured, so it is not attempted at all. */
  registeredRunners:
    | ((
        scopes: readonly GitHubScope[],
        signal: AbortSignal,
      ) => Promise<PartialResult<string, readonly RegisteredRunner[]> | undefined>)
    | undefined
}

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
  readonly up: Snapshot['up']
}

export async function sampleOnce(deps: Deps): Promise<Outcome> {
  const { config, sources, log } = deps
  const now = deps.now()
  const budget = config.sourceTimeoutMs

  const depths = settle(budget, signal => sources.queueDepths(signal))
  const ages = settle(budget, signal => sources.queueAges(now, signal))
  const instances = settle(budget, signal => sources.instances(signal))
  const runners = (async (): Promise<
    Result<PartialResult<string, readonly RegisteredRunner[]> | undefined>
  > => {
    const read = sources.registeredRunners
    if (!read) return { ok: true, value: undefined }
    const known = await instances
    const scopes = known.ok ? known.value.flatMap(i => (i.scope ? [i.scope] : [])) : []
    return settle(budget, signal => read(scopes, signal))
  })()

  const [d, a, i, r] = await Promise.all([depths, ages, instances, runners])
  const up: { [S in SourceName]?: boolean } = {
    sqs: d.ok && d.value.failed.length === 0,
    cloudwatch: a.ok,
    ec2: i.ok,
  }
  const githubConfigured = !r.ok || r.value !== undefined
  if (githubConfigured) up.github = r.ok && r.value !== undefined && r.value.failed.length === 0

  for (const [source, result] of [
    ['sqs', d],
    ['cloudwatch', a],
    ['ec2', i],
    ['github', r],
  ] as const) {
    if (!result.ok) log('warn', 'source failed', { source, error: result.error })
  }
  if (d.ok && d.value.failed.length > 0) log('warn', 'queues not read', { queues: d.value.failed })
  if (r.ok && r.value && r.value.failed.length > 0) {
    log('warn', 'GitHub scopes not read', { scopes: r.value.failed })
  }

  const snapshot: Snapshot = {
    now,
    depths: d.ok ? d.value : undefined,
    ages: a.ok ? a.value : undefined,
    instances: i.ok ? i.value : undefined,
    runners: r.ok ? r.value : undefined,
    up,
  }
  const series: Sample[] = deps.vanish.apply(buildSeries(config, snapshot), up, now)
  for (const [source, ok] of Object.entries(up)) {
    series.push(sample(METRICS.sourceUp, { source }, ok ? 1 : 0, now))
  }
  series.push(
    sample(METRICS.sampleDuration, {}, (deps.now() - now) / 1000, now),
    sample(METRICS.lastSampleTimestamp, {}, now / 1000, now),
  )
  // The global constant labels go on every series, the sampler's own included.
  const labelled = series.map(s => ({ ...s, labels: { ...config.labels, ...s.labels } }))

  await deps.sink.push(labelled)
  log('info', 'pushed', { series: labelled.length, up })
  return { series: labelled.length, up }
}
