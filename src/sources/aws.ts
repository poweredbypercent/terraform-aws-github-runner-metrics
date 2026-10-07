import type { Instance } from '@aws-sdk/client-ec2'
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

export type DescribeRunnerInstances = (
  environments: readonly string[],
  signal: AbortSignal,
) => Promise<readonly Instance[]>

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
 * minute behind. No datapoint means the queue has been idle (SQS stops publishing for idle
 * queues), which is an age of zero. A queue SQS says is empty is zero whatever CloudWatch's last
 * datapoint says; the model applies that, since it needs both sources.
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
  return new Map(queues.map(q => [q.arn, datapoints.get(q.name)?.[0] ?? 0]))
}

const tag = (instance: Instance, key: string): string | undefined =>
  instance.Tags?.find(t => t.Key === key)?.Value

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
    const environment = tag(i, 'ghr:environment')
    const apiUrl = environment ? apiUrlOf.get(environment) : undefined
    if (!i.InstanceId || !environment || apiUrl === undefined) continue
    instances.push({
      id: i.InstanceId,
      environment,
      instanceType: i.InstanceType ?? 'unknown',
      // EC2 sets InstanceLifecycle only for spot (and scheduled) instances; absent is on-demand.
      lifecycle: i.InstanceLifecycle === 'spot' ? 'spot' : 'on-demand',
      state: i.State?.Name ?? 'unknown',
      launchTime: i.LaunchTime?.getTime(),
      orphan: tag(i, 'ghr:orphan') === 'true',
      scope: scopeFromTags(tag(i, 'ghr:Type'), tag(i, 'ghr:Owner'), apiUrl),
    })
  }
  return instances
}
