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
/** Which sources answered this sample; a source that is not configured is absent. */
export type SourceHealth = { readonly [S in SourceName]?: boolean }

/** One of a runner config's scale-up queues. Its kind is configured, never guessed from its name. */
export interface QueueRef {
  readonly arn: string
  /** The queue's name, as CloudWatch's QueueName dimension knows it (FIFO queues end in .fifo). */
  readonly name: string
  readonly kind: QueueKind
}

/** One runner config of a runner stack: what the runner module calls a "runner" in multi_runner_config. */
export interface RunnerConfig {
  /** The `runner_config` label: the multi-runner key, or the stack's name. */
  readonly name: string
  /** The `environment` label and the ghr:environment tag value: `<prefix>` or `<prefix>-<key>`. */
  readonly environment: string
  /** runners_maximum_count; null when unlimited, and then no capacity series is reported. */
  readonly maxRunners: number | null
  readonly runnerNamePrefix: string
  /** GitHub REST API base for this stack (GitHub Enterprise Server sets its own). */
  readonly githubApiUrl: string
  /** Exactly one main queue, and at most one dead-letter queue. */
  readonly queues: readonly QueueRef[]
  /** Constant labels for this runner config's series only. */
  readonly labels: Readonly<Record<string, string>>
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

/** An item (a queue, a scope) that could not be read, and why. */
export interface ItemFailure {
  readonly key: string
  readonly error: string
}

/** Results read item by item (per queue, per scope): what was read, keyed, and what failed. */
export interface PartialResult<V> {
  readonly values: ReadonlyMap<string, V>
  readonly failed: readonly ItemFailure[]
}

export interface Snapshot {
  /** Epoch milliseconds at the start of the sample; every series carries it. */
  readonly now: number
  /** Keyed by queue ARN. */
  readonly depths: PartialResult<QueueDepth> | undefined
  /** Keyed by queue ARN. */
  readonly ages: ReadonlyMap<string, number> | undefined
  readonly instances: readonly RunnerInstance[] | undefined
  /** Keyed by scope (see scopeKey). */
  readonly runners: PartialResult<readonly RegisteredRunner[]> | undefined
}
