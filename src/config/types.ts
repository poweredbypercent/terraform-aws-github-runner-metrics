import type { RunnerConfig } from '../domain/types.ts'

export type GitHubCredentials =
  | { readonly type: 'none' }
  | { readonly type: 'secret'; readonly secretArn: string }
  | { readonly type: 'ssm'; readonly appIdParameter: string; readonly privateKeyParameter: string }

export interface GitHubConfig {
  readonly credentials: GitHubCredentials
  /** The only "org" or "owner/repo" targets queried, lower-cased; required with credentials. */
  readonly owners: readonly string[]
}

export interface SigV4Auth {
  readonly type: 'sigv4'
  readonly region: string
  readonly service: string
  readonly roleArn: string | undefined
  readonly externalId: string | undefined
  /** The assumed role's session name, so the writer account's CloudTrail can tell deployments apart. */
  readonly sessionName: string
}

export type RemoteWriteAuth =
  | { readonly type: 'none' }
  | SigV4Auth
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
