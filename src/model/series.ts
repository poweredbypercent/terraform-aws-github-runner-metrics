import { instanceIdOfRunnerName, scopeKey } from '../domain/scope.ts'
import type {
  GitHubScope,
  QueueRef,
  RegisteredRunner,
  RunnerConfig,
  RunnerInstance,
  Snapshot,
} from '../domain/types.ts'
import { type LabelsOf, METRICS, type Sample, sample } from './catalogue.ts'

/** What the model needs to know about the stack, besides the snapshot. */
export interface SeriesSettings {
  readonly runnerConfigs: readonly RunnerConfig[]
  /** Instances younger than this are always unregistered; they are not counted as booting. */
  readonly bootGraceSeconds: number
}

/**
 * A snapshot of the runner stack, as series. Pure: everything it needs is in its arguments.
 *
 * Each family is built only from sources that answered; a failed source leaves its series out
 * (the sampler reports source_up=0 for it), never zero, and so does a single queue that was not
 * read. Counts whose label sets are fixed by the config (a runner config's orphans and booting
 * runners) are filled with zeros so a quiet runner config still reports; label sets that come and
 * go (instance types, owners) are left to the vanish tracker.
 */
export function buildSeries(config: SeriesSettings, snapshot: Snapshot): Sample[] {
  const { now } = snapshot
  const series: Sample[] = []
  const byEnvironment = new Map(config.runnerConfigs.map(c => [c.environment, c]))

  for (const c of config.runnerConfigs) {
    if (c.maxRunners !== null) {
      series.push(sample(METRICS.capacity, baseLabels(c), c.maxRunners, now))
    }
  }

  if (snapshot.depths) {
    for (const { c, queue } of queuesOf(config)) {
      const depth = snapshot.depths.values.get(queue.arn)
      if (!depth) continue
      for (const [visibility, value] of [
        ['visible', depth.visible],
        ['in_flight', depth.inFlight],
        ['delayed', depth.delayed],
      ] as const) {
        const labels = { ...baseLabels(c), queue: queue.kind, visibility }
        series.push(sample(METRICS.queueMessages, labels, value, now))
      }
    }
  }

  if (snapshot.ages) {
    for (const { c, queue } of queuesOf(config)) {
      const age = ageOf(queue, snapshot.ages, snapshot.depths)
      if (age === undefined) continue
      series.push(sample(METRICS.queueAge, { ...baseLabels(c), queue: queue.kind }, age, now))
    }
  }

  const instances = snapshot.instances?.filter(i => byEnvironment.has(i.environment))
  if (instances) {
    series.push(...instanceSeries(config, byEnvironment, instances, now))
  }

  if (snapshot.runners) {
    series.push(
      ...runnerSeries(config, byEnvironment, snapshot.runners.values, instances ?? [], now),
    )
  }

  if (instances && snapshot.runners) {
    series.push(...bootingSeries(config, instances, snapshot.runners, now))
  }

  return series.map(s => withRunnerConfigLabels(s, byEnvironment))
}

type ByEnvironment = ReadonlyMap<string, RunnerConfig>

const baseLabels = (c: RunnerConfig) => ({ environment: c.environment, runner_config: c.name })

const queuesOf = (config: SeriesSettings) =>
  config.runnerConfigs.flatMap(c => c.queues.map(queue => ({ c, queue })))

/**
 * The oldest message's age: CloudWatch's datapoint, checked against what SQS said in the same
 * sample. A queue SQS found empty has no oldest message, whatever CloudWatch last published (its
 * last datapoint outlives the messages it measured). A queue SQS says does not exist has no age.
 * Otherwise the age is CloudWatch's datapoint, and without one it is unknown, never zero: a main
 * queue that is missing, or messages CloudWatch has not published yet.
 */
function ageOf(
  queue: QueueRef,
  ages: ReadonlyMap<string, number>,
  depths: Snapshot['depths'],
): number | undefined {
  const depth = depths?.values.get(queue.arn)
  if (depth && depth.visible + depth.inFlight + depth.delayed === 0) return 0
  if (depths && !depth && !depths.failed.some(f => f.key === queue.arn)) return undefined
  return ages.get(queue.arn)
}

function instanceSeries(
  config: SeriesSettings,
  byEnvironment: ByEnvironment,
  instances: readonly RunnerInstance[],
  now: number,
): Sample[] {
  type InstanceLabels = LabelsOf<typeof METRICS.instances>
  const series: Sample[] = []
  const live = new Map<string, { labels: InstanceLabels; count: number }>()
  const orphans = new Map(config.runnerConfigs.map(c => [c.environment, 0]))
  for (const i of instances) {
    if (i.orphan) {
      orphans.set(i.environment, (orphans.get(i.environment) ?? 0) + 1)
      continue
    }
    const c = byEnvironment.get(i.environment)
    if (!c) continue
    const labels: InstanceLabels = {
      ...baseLabels(c),
      instance_type: i.instanceType,
      lifecycle: i.lifecycle,
      state: i.state,
    }
    const key = JSON.stringify(labels)
    live.set(key, { labels, count: (live.get(key)?.count ?? 0) + 1 })
  }
  for (const { labels, count } of live.values()) {
    series.push(sample(METRICS.instances, labels, count, now))
  }
  for (const c of config.runnerConfigs) {
    series.push(
      sample(METRICS.orphanInstances, baseLabels(c), orphans.get(c.environment) ?? 0, now),
    )
  }
  return series
}

/**
 * Which runner config a registered runner belongs to: through its instance when the instance is
 * known, otherwise by the runner name prefix when exactly one config uses it. Runners that cannot
 * be placed (another stack's, a laptop) are not this sampler's to count.
 */
function placeRunner(
  config: SeriesSettings,
  byEnvironment: ByEnvironment,
  runner: RegisteredRunner,
  environmentOfInstance: ReadonlyMap<string, string>,
): RunnerConfig | undefined {
  const id = instanceIdOfRunnerName(runner.name)
  if (!id) return undefined
  const environment = environmentOfInstance.get(id)
  if (environment) return byEnvironment.get(environment)
  const byPrefix = config.runnerConfigs.filter(
    c => c.runnerNamePrefix !== '' && runner.name === `${c.runnerNamePrefix}${id}`,
  )
  return byPrefix.length === 1 ? byPrefix[0] : undefined
}

const scopeLabels = (scope: GitHubScope) => ({
  runner_type: scope.type,
  organization: scope.owner,
  repository: scope.repo ?? '',
})

function runnerSeries(
  config: SeriesSettings,
  byEnvironment: ByEnvironment,
  byScope: ReadonlyMap<string, readonly RegisteredRunner[]>,
  instances: readonly RunnerInstance[],
  now: number,
): Sample[] {
  const environmentOfInstance = new Map(instances.map(i => [i.id, i.environment]))
  type Counts = { c: RunnerConfig; scope: GitHubScope; busy: number; idle: number; offline: number }
  const counts = new Map<string, Counts>()
  const countsFor = (c: RunnerConfig, scope: GitHubScope): Counts => {
    const key = `${c.name}|${scopeKey(scope)}`
    let entry = counts.get(key)
    if (!entry) {
      entry = { c, scope, busy: 0, idle: 0, offline: 0 }
      counts.set(key, entry)
    }
    return entry
  }

  // A scope this runner config's instances register in reports zeros even with no runners yet.
  for (const i of instances) {
    const c = byEnvironment.get(i.environment)
    if (c && i.scope && byScope.has(scopeKey(i.scope))) countsFor(c, i.scope)
  }
  for (const runners of byScope.values()) {
    for (const runner of runners) {
      const c = placeRunner(config, byEnvironment, runner, environmentOfInstance)
      if (!c) continue
      const entry = countsFor(c, runner.scope)
      if (runner.status !== 'online') entry.offline++
      else if (runner.busy) entry.busy++
      else entry.idle++
    }
  }

  const series: Sample[] = []
  for (const { c, scope, busy, idle, offline } of counts.values()) {
    const labels = { ...baseLabels(c), ...scopeLabels(scope) }
    series.push(
      sample(METRICS.registeredRunners, labels, busy + idle + offline, now),
      sample(METRICS.busyRunners, labels, busy, now),
      sample(METRICS.idleRunners, labels, idle, now),
      sample(METRICS.offlineRunners, labels, offline, now),
    )
  }
  return series
}

/**
 * Instances whose runner is not online yet, joined by instance id rather than by subtracting
 * counts (which lags and goes negative). Online, not merely registered: with JIT configuration
 * (the runner module's default for ephemeral runners) the scale-up Lambda registers the runner
 * before the instance has booted, and it stays offline until the agent connects. Only for runner
 * configs whose instances all have a scope that was read this sample: an instance whose scope
 * failed, or carries no ghr:Owner tag, cannot be checked, and an unknown count is left out rather
 * than guessed.
 */
function bootingSeries(
  config: SeriesSettings,
  instances: readonly RunnerInstance[],
  runners: NonNullable<Snapshot['runners']>,
  now: number,
): Sample[] {
  const online = new Set<string>()
  for (const list of runners.values.values()) {
    for (const r of list) {
      const id = r.status === 'online' ? instanceIdOfRunnerName(r.name) : undefined
      if (id) online.add(id)
    }
  }
  const grace = config.bootGraceSeconds * 1000
  const series: Sample[] = []
  for (const c of config.runnerConfigs) {
    const mine = instances.filter(i => i.environment === c.environment && !i.orphan)
    const checkable = mine.every(i => i.scope && runners.values.has(scopeKey(i.scope)))
    if (!checkable) continue
    const booting = mine.filter(
      i => !online.has(i.id) && (i.launchTime === undefined || now - i.launchTime >= grace),
    ).length
    series.push(sample(METRICS.bootingRunners, baseLabels(c), booting, now))
  }
  return series
}

/** A runner config's own constant labels; the global ones are added to every series by run.ts. */
function withRunnerConfigLabels(s: Sample, byEnvironment: ByEnvironment): Sample {
  const perConfig = s.labels.environment
    ? byEnvironment.get(s.labels.environment)?.labels
    : undefined
  return perConfig ? { ...s, labels: { ...perConfig, ...s.labels } } : s
}
