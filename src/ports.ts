import type {
  GitHubScope,
  PartialResult,
  QueueDepth,
  RegisteredRunner,
  RunnerInstance,
} from './domain/types.ts'
import type { Sample } from './model/catalogue.ts'

/**
 * What a sample reads from and writes to. run.ts depends only on these; handler.ts builds them
 * from the AWS SDK and fetch, and tests pass fakes.
 */

export interface Sources {
  /** Keyed by queue ARN. */
  queueDepths(signal: AbortSignal): Promise<PartialResult<QueueDepth>>
  /** Keyed by queue ARN. */
  queueAges(now: number, signal: AbortSignal): Promise<ReadonlyMap<string, number>>
  instances(signal: AbortSignal): Promise<readonly RunnerInstance[]>
  /** Undefined when the module was deployed without GitHub: it is then never attempted. */
  readonly github: GitHubSource | undefined
}

/** Registered runners, keyed by scope (see scopeKey). */
export type RegisteredRunners = PartialResult<readonly RegisteredRunner[]>

export interface GitHubSource {
  /**
   * Whether the App's credentials have been filled in: that happens after deploy, so until then
   * GitHub is skipped rather than reported as failing.
   */
  isConfigured(signal: AbortSignal): Promise<boolean>
  registeredRunners(scopes: readonly GitHubScope[], signal: AbortSignal): Promise<RegisteredRunners>
}

export interface Sink {
  push(samples: readonly Sample[]): Promise<void>
}

/**
 * Sources and the sink reject when they fail; run.ts settles each source on its own, and a sink
 * failure fails the invocation.
 */

/** One structured event; the handler logs them as JSON lines. */
export type Logger = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Readonly<Record<string, unknown>>,
) => void
