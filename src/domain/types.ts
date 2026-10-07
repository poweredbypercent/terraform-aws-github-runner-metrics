/**
 * The shape of one sample of a runner stack, as the sources report it and the model reads it.
 *
 * A field is undefined when its source failed this minute or is not configured. The model leaves
 * out every series that depends on it rather than reporting zero: a gap says "unknown", a zero
 * would say "nothing there".
 */

export type QueueKind = 'main' | 'dead_letter'
export type Lifecycle = 'spot' | 'on-demand'
export type RunnerType = 'org' | 'repo'
export type SourceName = 'sqs' | 'cloudwatch' | 'ec2' | 'github'

/** One of a runner config's scale-up queues, as configured (ARN) and as SQS addresses it (URL). */
export interface QueueRef {
  readonly arn: string
  readonly name: string
  readonly url: string
  readonly kind: QueueKind
}

export interface QueueDepth {
  /** Jobs not yet picked up by the scale-up lambda. */
  readonly visible: number
  /** Jobs being handled, or backing off after the runner cap or a capacity error. */
  readonly inFlight: number
  readonly delayed: number
}

/** Where a GitHub runner is registered: an organisation, or a single repository. */
export interface GitHubScope {
  readonly type: RunnerType
  readonly owner: string
  /** Only for repository-level runners. */
  readonly repo?: string
  /** REST API base, e.g. https://api.github.com or https://ghes.example/api/v3. */
  readonly apiUrl: string
}

/** A runner EC2 instance launched by the runner module, pending or running. */
export interface RunnerInstance {
  readonly id: string
  readonly environment: string
  readonly instanceType: string
  readonly lifecycle: Lifecycle
  readonly state: string
  /** Epoch milliseconds. */
  readonly launchTime: number | undefined
  /** Marked by the runner module's scale-down: it never registered and is due for termination. */
  readonly orphan: boolean
  /** From the ghr:Type / ghr:Owner tags; undefined when the tags are missing or malformed. */
  readonly scope: GitHubScope | undefined
}

export interface RegisteredRunner {
  readonly name: string
  readonly status: 'online' | 'offline'
  readonly busy: boolean
  readonly scope: GitHubScope
}

/** Results that may succeed for some items and fail for others, e.g. per queue or per scope. */
export interface PartialResult<K, V> {
  readonly values: ReadonlyMap<K, V>
  readonly failed: readonly K[]
}

export interface Snapshot {
  /** Epoch milliseconds at the start of the sample; every series carries it. */
  readonly now: number
  readonly depths: PartialResult<string, QueueDepth> | undefined
  readonly ages: ReadonlyMap<string, number> | undefined
  readonly instances: readonly RunnerInstance[] | undefined
  readonly runners: PartialResult<string, readonly RegisteredRunner[]> | undefined
  /** Only the sources that were attempted; GitHub without credentials is not attempted. */
  readonly up: { readonly [S in SourceName]?: boolean }
}
