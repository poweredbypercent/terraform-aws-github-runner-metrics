import type { Config, RunnerConfig } from '../config/types.ts'
import { instanceIdOfRunnerName, scopeKey } from '../domain/scope.ts'
import type { GitHubScope, RegisteredRunner, RunnerInstance, Snapshot } from '../domain/types.ts'
import { type LabelsOf, METRICS, type Sample, sample } from './catalogue.ts'

/**
 * A snapshot of the runner stack, as series. Pure: everything it needs is in its arguments.
 *
 * Each family is built only from sources that answered; a failed source leaves its series out
 * (the sampler reports source_up=0 for it), never zero. Label sets that are fixed by the config
 * (a runner config's queues, its orphan and booting counts) are filled with zeros so a quiet
 * runner config still reports; label sets that come and go (instance types, owners) are left to
 * the vanish tracker.
 */
export function buildSeries(config: Config, snapshot: Snapshot): Sample[] {
  const { now } = snapshot
  const series: Sample[] = []
  const byEnvironment = new Map(config.runnerConfigs.map(c => [c.environment, c]))
  const base = (c: RunnerConfig) => ({ environment: c.environment, runner_config: c.name })

  for (const c of config.runnerConfigs) {
    if (c.maxRunners !== null) series.push(sample(METRICS.capacity, base(c), c.maxRunners, now))
  }

  if (snapshot.depths) {
    for (const c of config.runnerConfigs) {
      for (const queue of c.queues) {
        const depth = snapshot.depths.values.get(queue.arn)
        if (!depth) continue
        for (const [visibility, value] of [
          ['visible', depth.visible],
          ['in_flight', depth.inFlight],
          ['delayed', depth.delayed],
        ] as const) {
          series.push(
            sample(
              METRICS.queueMessages,
              { ...base(c), queue: queue.kind, visibility },
              value,
              now,
            ),
          )
        }
      }
    }
  }

  if (snapshot.ages) {
    for (const c of config.runnerConfigs) {
      for (const queue of c.queues) {
        const age = snapshot.ages.get(queue.arn)
        if (age === undefined) continue
        // CloudWatch has no datapoints for a queue that does not exist either; once SQS has said
        // which queues exist, a dead-letter queue that is not among them gets no age.
        if (
          queue.kind === 'dead_letter' &&
          snapshot.depths &&
          !snapshot.depths.values.has(queue.arn)
        ) {
          continue
        }
        series.push(sample(METRICS.queueAge, { ...base(c), queue: queue.kind }, age, now))
      }
    }
  }

  const instances = snapshot.instances?.filter(i => byEnvironment.has(i.environment))
  if (instances) {
    series.push(...instanceSeries(config, instances, now))
  }

  if (snapshot.runners) {
    series.push(...runnerSeries(config, snapshot.runners.values, instances, now))
  }

  if (instances && snapshot.runners) {
    series.push(...bootingSeries(config, instances, snapshot.runners, now))
  }

  return series.map(s => withRunnerConfigLabels(s, byEnvironment))
}

function instanceSeries(
  config: Config,
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
    const labels: InstanceLabels = {
      environment: i.environment,
      runner_config: configName(config, i.environment),
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
      sample(
        METRICS.orphanInstances,
        { environment: c.environment, runner_config: c.name },
        orphans.get(c.environment) ?? 0,
        now,
      ),
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
  config: Config,
  runner: RegisteredRunner,
  environmentOfInstance: ReadonlyMap<string, string>,
): RunnerConfig | undefined {
  const id = instanceIdOfRunnerName(runner.name)
  if (!id) return undefined
  const environment = environmentOfInstance.get(id)
  if (environment) return config.runnerConfigs.find(c => c.environment === environment)
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
  config: Config,
  byScope: ReadonlyMap<string, readonly RegisteredRunner[]>,
  instances: readonly RunnerInstance[] | undefined,
  now: number,
): Sample[] {
  const environmentOfInstance = new Map((instances ?? []).map(i => [i.id, i.environment]))
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
  for (const i of instances ?? []) {
    const c = config.runnerConfigs.find(rc => rc.environment === i.environment)
    if (c && i.scope && byScope.has(scopeKey(i.scope))) countsFor(c, i.scope)
  }
  for (const runners of byScope.values()) {
    for (const runner of runners) {
      const c = placeRunner(config, runner, environmentOfInstance)
      if (!c) continue
      const entry = countsFor(c, runner.scope)
      if (runner.status !== 'online') entry.offline++
      else if (runner.busy) entry.busy++
      else entry.idle++
    }
  }

  const series: Sample[] = []
  for (const { c, scope, busy, idle, offline } of counts.values()) {
    const labels = { environment: c.environment, runner_config: c.name, ...scopeLabels(scope) }
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
 * Instances that have not registered yet, joined by instance id rather than by subtracting counts
 * (which lags and goes negative). Only for runner configs whose instances all have a scope that
 * was read this sample: an instance whose scope failed, or carries no ghr:Owner tag, cannot be
 * checked, and an unknown count is left out rather than guessed.
 */
function bootingSeries(
  config: Config,
  instances: readonly RunnerInstance[],
  runners: NonNullable<Snapshot['runners']>,
  now: number,
): Sample[] {
  const registered = new Set<string>()
  for (const list of runners.values.values()) {
    for (const r of list) {
      const id = instanceIdOfRunnerName(r.name)
      if (id) registered.add(id)
    }
  }
  const grace = config.bootGraceSeconds * 1000
  const series: Sample[] = []
  for (const c of config.runnerConfigs) {
    const mine = instances.filter(i => i.environment === c.environment && !i.orphan)
    const checkable = mine.every(i => i.scope && runners.values.has(scopeKey(i.scope)))
    if (!checkable) continue
    const booting = mine.filter(
      i => !registered.has(i.id) && (i.launchTime === undefined || now - i.launchTime >= grace),
    ).length
    series.push(
      sample(
        METRICS.bootingRunners,
        { environment: c.environment, runner_config: c.name },
        booting,
        now,
      ),
    )
  }
  return series
}

const configName = (config: Config, environment: string): string =>
  config.runnerConfigs.find(c => c.environment === environment)?.name ?? environment

/** A runner config's own constant labels; the global ones are added to every series by run(). */
function withRunnerConfigLabels(
  s: Sample,
  byEnvironment: ReadonlyMap<string, RunnerConfig>,
): Sample {
  const perConfig = s.labels.environment
    ? byEnvironment.get(s.labels.environment)?.labels
    : undefined
  return perConfig ? { ...s, labels: { ...perConfig, ...s.labels } } : s
}
