import { scopeFromTags } from '../domain/scope.ts'
import { readEach } from '../domain/settle.ts'
import type {
  PartialResult,
  QueueDepth,
  QueueRef,
  RunnerConfig,
  RunnerInstance,
} from '../domain/types.ts'

/**
 * The AWS sources. Each takes a small function ("port") for the one API call it needs; the handler
 * builds those from the SDK clients, and tests pass fakes. Everything here is the logic around
 * the call: which queues, how results map onto the domain, what a missing datapoint means.
 */

/** A queue's attributes, or undefined when the queue does not exist. */
export type GetQueueAttributes = (
  queueArn: string,
  signal: AbortSignal,
) => Promise<Readonly<Record<string, string | undefined>> | undefined>

/** Oldest-message age datapoints per queue name, newest first. */
export type GetQueueAgeDatapoints = (
  queueNames: readonly string[],
  window: { start: Date; end: Date },
  signal: AbortSignal,
) => Promise<ReadonlyMap<string, readonly number[]>>

/** A pending or running EC2 instance: what the runner logic reads of one, in plain terms. */
export interface Ec2Instance {
  readonly id: string
  readonly type: string | undefined
  /** EC2 sets it only for spot (and scheduled) instances; absent is on-demand. */
  readonly lifecycle: string | undefined
  readonly state: string | undefined
  readonly launchTime: Date | undefined
  readonly tags: Readonly<Record<string, string>>
}

export type DescribeRunnerInstances = (
  environments: readonly string[],
  signal: AbortSignal,
) => Promise<readonly Ec2Instance[]>

const allQueues = (configs: readonly RunnerConfig[]): QueueRef[] => configs.flatMap(c => c.queues)

/**
 * Depth of every configured queue. Each queue is read on its own, so one that cannot be read (a
 * permission missing) fails alone.
 */
export async function readQueueDepths(
  getAttributes: GetQueueAttributes,
  configs: readonly RunnerConfig[],
  signal: AbortSignal,
): Promise<PartialResult<QueueDepth>> {
  return readEach(
    allQueues(configs),
    queue => queue.arn,
    async queue => {
      const attributes = await getAttributes(queue.arn, signal)
      if (attributes === undefined) {
        // A runner config without redrive_build_queue has no dead-letter queue. Its ARN is still
        // derived from the naming convention (multi-runner stacks do not output their queues),
        // so a missing one is absent, not a failure. A missing main queue is a misconfiguration.
        if (queue.kind === 'dead_letter') return undefined
        throw new Error(`queue ${queue.name} does not exist`)
      }
      return {
        visible: count(attributes, 'ApproximateNumberOfMessages'),
        inFlight: count(attributes, 'ApproximateNumberOfMessagesNotVisible'),
        delayed: count(attributes, 'ApproximateNumberOfMessagesDelayed'),
      }
    },
  )
}

/** An attribute SQS was asked for; one it did not return is a failure, not a zero. */
function count(attributes: Readonly<Record<string, string | undefined>>, name: string): number {
  const value = Number(attributes[name])
  if (attributes[name] === undefined || !Number.isFinite(value)) {
    throw new Error(`SQS returned no ${name}`)
  }
  return value
}

/** How far back to look for the newest datapoint: SQS publishes each minute, a minute behind. */
const AGE_LOOKBACK_MS = 5 * 60_000

/**
 * The oldest message's age per queue, from CloudWatch: SQS publishes it each minute, about a
 * minute behind. A queue without a datapoint is left out: an idle queue (SQS stops publishing for
 * those), a queue that does not exist and one not published yet all look the same here. The model
 * tells them apart with what SQS said in the same sample.
 */
export async function readQueueAges(
  getDatapoints: GetQueueAgeDatapoints,
  configs: readonly RunnerConfig[],
  now: number,
  signal: AbortSignal,
): Promise<Map<string, number>> {
  const queues = allQueues(configs)
  const datapoints = await getDatapoints(
    queues.map(q => q.name),
    { start: new Date(now - AGE_LOOKBACK_MS), end: new Date(now) },
    signal,
  )
  const ages = new Map<string, number>()
  for (const queue of queues) {
    const newest = datapoints.get(queue.name)?.[0]
    if (newest !== undefined) ages.set(queue.arn, newest)
  }
  return ages
}

/** The runner instances of the configured environments, in the domain's terms. */
export async function readInstances(
  describe: DescribeRunnerInstances,
  configs: readonly RunnerConfig[],
  signal: AbortSignal,
): Promise<RunnerInstance[]> {
  const apiUrlOf = new Map(configs.map(c => [c.environment, c.githubApiUrl]))
  const raw = await describe(
    configs.map(c => c.environment),
    signal,
  )
  const instances: RunnerInstance[] = []
  for (const i of raw) {
    const environment = i.tags['ghr:environment']
    const apiUrl = environment ? apiUrlOf.get(environment) : undefined
    if (!environment || apiUrl === undefined) continue
    instances.push({
      id: i.id,
      environment,
      instanceType: i.type ?? 'unknown',
      lifecycle: i.lifecycle === 'spot' ? 'spot' : 'on-demand',
      state: i.state ?? 'unknown',
      launchTime: i.launchTime?.getTime(),
      orphan: i.tags['ghr:orphan'] === 'true',
      scope: scopeFromTags(i.tags['ghr:Type'], i.tags['ghr:Owner'], apiUrl),
    })
  }
  return instances
}
