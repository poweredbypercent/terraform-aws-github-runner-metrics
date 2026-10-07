import type { SourceName } from '../domain/types.ts'

/**
 * Every metric this sampler emits, defined once: name, help text, label names and the source it
 * comes from. The label names are types, so a series cannot be built with a label missing or
 * misspelt, and docs/metrics.md is generated from this list (npm run docs:metrics) so the
 * documentation cannot drift from the code.
 */

export const PREFIX = 'github_aws_runners_'

export interface MetricDefinition<L extends string = string> {
  readonly name: string
  readonly help: string
  readonly labels: readonly L[]
  /** Where the value comes from; the sampler's own series say `sampler`. */
  readonly source: SourceName | 'config' | 'sampler'
  /**
   * Label values that come and go (an instance type, an owner): when one disappears while its
   * source is up, the series is sent as 0 for a few samples rather than left to linger at its
   * last value for Prometheus' five-minute lookback.
   */
  readonly vanishes: boolean
}

/** The label set a metric's series must carry. */
export type LabelsOf<M> = M extends MetricDefinition<infer L> ? Readonly<Record<L, string>> : never

export interface Sample {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
  readonly timestamp: number
}

const define = <const L extends string>(
  suffix: string,
  help: string,
  labels: readonly L[],
  source: MetricDefinition['source'],
  vanishes = false,
): MetricDefinition<L> => ({ name: `${PREFIX}${suffix}`, help, labels, source, vanishes })

const CONFIG = ['environment', 'runner_config'] as const
const RUNNERS = [...CONFIG, 'runner_type', 'organization', 'repository'] as const

export const METRICS = {
  capacity: define(
    'capacity',
    'The most runners this runner config may run at once (runners_maximum_count). Not reported when unlimited.',
    CONFIG,
    'config',
  ),
  queueMessages: define(
    'scale_up_queue_messages',
    'Jobs in the scale-up queue. queue="main": waiting for the scale-up lambda (visible), being handled or backing off after the runner cap or a capacity error (in_flight), or delayed. queue="dead_letter": jobs that failed scale-up repeatedly and will not get a runner.',
    [...CONFIG, 'queue', 'visibility'],
    'sqs',
  ),
  queueAge: define(
    'scale_up_queue_oldest_message_age_seconds',
    'Age of the oldest message in the queue (CloudWatch ApproximateAgeOfOldestMessage, about a minute behind). Grows while depth stays flat when scale-up keeps failing.',
    [...CONFIG, 'queue'],
    'cloudwatch',
  ),
  instances: define(
    'instances',
    'Runner EC2 instances, pending or running, by type, purchase option and state. Orphans are counted separately.',
    [...CONFIG, 'instance_type', 'lifecycle', 'state'],
    'ec2',
    true,
  ),
  orphanInstances: define(
    'orphan_instances',
    'Instances the runner module marked as never having registered (ghr:orphan); scale-down terminates them.',
    CONFIG,
    'ec2',
  ),
  bootingRunners: define(
    'booting_runners',
    'Instances launched more than the boot grace period ago that have not registered with GitHub yet. Needs both EC2 and GitHub; not reported when either failed.',
    CONFIG,
    'github',
  ),
  registeredRunners: define(
    'registered_runners',
    'Runners of this stack registered with GitHub, in any state.',
    RUNNERS,
    'github',
    true,
  ),
  busyRunners: define('busy_runners', 'Registered runners running a job.', RUNNERS, 'github', true),
  idleRunners: define(
    'idle_runners',
    'Registered runners online and waiting for a job (for example a warm pool).',
    RUNNERS,
    'github',
    true,
  ),
  offlineRunners: define(
    'offline_runners',
    'Registered runners GitHub reports offline.',
    RUNNERS,
    'github',
    true,
  ),
  sourceUp: define(
    'source_up',
    'Whether the source answered this sample: 1 yes, 0 failed. A source that is not configured (GitHub without credentials) is not reported.',
    ['source'],
    'sampler',
  ),
  lastSampleTimestamp: define(
    'last_sample_timestamp_seconds',
    'When this sample was taken (Unix seconds). Alert on time() minus this to catch a sampler that has stopped.',
    [],
    'sampler',
  ),
  sampleDuration: define(
    'sample_duration_seconds',
    'How long reading the sources took.',
    [],
    'sampler',
  ),
} as const

export const ALL_METRICS: readonly MetricDefinition[] = Object.values(METRICS)

export function sample<L extends string>(
  metric: MetricDefinition<L>,
  labels: Readonly<Record<L, string>>,
  value: number,
  timestamp: number,
): Sample {
  return { name: metric.name, labels, value, timestamp }
}

/** The identity of a series: its name and labels, independent of label order. */
export const seriesKey = (s: Pick<Sample, 'name' | 'labels'>): string =>
  `${s.name}{${Object.keys(s.labels)
    .sort()
    .map(k => `${k}=${JSON.stringify(s.labels[k])}`)
    .join(',')}}`

/** A Markdown table of the catalogue, for docs/metrics.md. */
export function renderMetricDocs(): string {
  const rows = ALL_METRICS.map(
    m =>
      `| \`${m.name}\` | ${m.labels.map(l => `\`${l}\``).join(', ') || '-'} | ${m.source} | ${m.help} |`,
  )
  return [
    '# Metrics',
    '',
    'All metrics are gauges. Every series also carries the constant labels you configure.',
    'Generated from `src/model/catalogue.ts` by `npm run docs:metrics`; do not edit by hand.',
    '',
    '| Metric | Labels | Source | Meaning |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
}
