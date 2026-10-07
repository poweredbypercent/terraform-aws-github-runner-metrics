import type { QueueRef } from '../domain/types.ts'

/** One runner config of a runner stack: what the module calls a "runner" in multi_runner_config. */
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
  readonly queues: readonly QueueRef[]
  /** Constant labels for this runner config's series only. */
  readonly labels: Readonly<Record<string, string>>
}

export type GitHubCredentials =
  | { readonly type: 'none' }
  | { readonly type: 'secret'; readonly secretArn: string }
  | { readonly type: 'ssm'; readonly appIdParameter: string; readonly privateKeyParameter: string }

export interface GitHubConfig {
  readonly credentials: GitHubCredentials
  /** When non-empty, only these "org" or "owner/repo" targets are queried. */
  readonly owners: readonly string[]
}

export type RemoteWriteAuth =
  | { readonly type: 'none' }
  | {
      readonly type: 'sigv4'
      readonly region: string
      readonly service: string
      readonly roleArn: string | undefined
      readonly externalId: string | undefined
    }
  | { readonly type: 'basic'; readonly secretArn: string }
  | { readonly type: 'bearer'; readonly secretArn: string }

export interface RemoteWriteConfig {
  readonly url: string
  readonly auth: RemoteWriteAuth
  /** Plain, non-secret headers such as X-Scope-OrgID. */
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
}

export interface Config {
  readonly runnerConfigs: readonly RunnerConfig[]
  readonly github: GitHubConfig
  readonly remoteWrite: RemoteWriteConfig
  /** Constant labels on every series. */
  readonly labels: Readonly<Record<string, string>>
  /** Instances younger than this are always unregistered; they are not counted as booting. */
  readonly bootGraceSeconds: number
  readonly sourceTimeoutMs: number
}
