import { CloudWatchClient } from '@aws-sdk/client-cloudwatch'
import { EC2Client } from '@aws-sdk/client-ec2'
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { SQSClient } from '@aws-sdk/client-sqs'
import { SSMClient } from '@aws-sdk/client-ssm'
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { type Cached, cached } from './cache.ts'
import { parseConfig } from './config/parse.ts'
import type { Config, SigV4Auth } from './config/types.ts'
import { jsonLogger } from './log.ts'
import { createVanishTracker } from './model/vanish.ts'
import type { GitHubSource } from './ports.ts'
import { type Deps, type Outcome, sampleOnce } from './run.ts'
import { authFromConfig, type CredentialProvider, refreshingCredentials } from './sinks/auth.ts'
import { remoteWriteSink } from './sinks/remote-write/sink.ts'
import { readInstances, readQueueAges, readQueueDepths } from './sources/aws.ts'
import {
  cloudWatchQueueAges,
  ec2RunnerInstances,
  type ReadParameter,
  type ReadSecret,
  secretsManagerValue,
  sqsQueueAttributes,
  ssmParameterValue,
} from './sources/aws-sdk.ts'
import { createGitHubAppClient } from './sources/github/client.ts'
import {
  type AppCredentials,
  credentialsFromRunnerModule,
  parseAppSecret,
} from './sources/github/credentials.ts'
import { readRegisteredRunners } from './sources/github/runners.ts'

/**
 * The Lambda entry point and composition root: the only place that reads the environment and
 * creates AWS clients. It holds no logic of its own - the SDK calls are in sources/aws-sdk.ts -
 * only the wiring. Dependencies are built once per container and kept while it is warm, so caches
 * (GitHub tokens, secrets, writer credentials, the vanish tracker) survive from one minute's
 * sample to the next.
 */

/** Set at build time from package.json; "dev" when run from source. */
declare const __VERSION__: string
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const USER_AGENT = `terraform-aws-github-runner-metrics/${VERSION}`
/**
 * A secret or the App's credentials are kept this long before being read again, so a rotation is
 * picked up within it.
 */
const CREDENTIAL_TTL_MS = 10 * 60_000
/** The writer role's sessions: STS's minimum, refreshed five minutes before they end. */
const WRITER_SESSION_SECONDS = 900

/** Kept for CREDENTIAL_TTL_MS, and not at all until there is a value (a secret filled in later). */
const cachedCredential = <T>(load: (signal: AbortSignal) => Promise<T | undefined>) =>
  cached(load, CREDENTIAL_TTL_MS, Date.now)

function githubCredentials(
  config: Config,
  readSecret: ReadSecret,
  readParameter: ReadParameter,
): Cached<AppCredentials> | undefined {
  const credentials = config.github.credentials
  switch (credentials.type) {
    case 'none':
      return undefined
    case 'secret':
      return cachedCredential(async signal => {
        const raw = await readSecret(credentials.secretArn, signal)
        return raw === undefined ? undefined : parseAppSecret(raw)
      })
    case 'ssm':
      return cachedCredential(async signal => {
        const [appId, key] = await Promise.all([
          readParameter(credentials.appIdParameter, signal),
          readParameter(credentials.privateKeyParameter, signal),
        ])
        return credentialsFromRunnerModule(appId, key)
      })
    default:
      // A new kind of credentials must be wired here, not silently turn GitHub off.
      return credentials satisfies never
  }
}

function githubSource(
  config: Config,
  credentials: Cached<AppCredentials> | undefined,
): GitHubSource | undefined {
  if (!credentials) return undefined
  const client = createGitHubAppClient({ credentials, fetch, userAgent: USER_AGENT, now: Date.now })
  return {
    isConfigured: async signal => (await credentials.get(signal)) !== undefined,
    registeredRunners: (scopes, signal) =>
      readRegisteredRunners(client, scopes, config.github.owners, signal),
  }
}

/**
 * The node provider chain caches by itself; the assume-role provider does not, so it is wrapped:
 * one STS call per session rather than one per push.
 */
const writerCredentials = (auth: SigV4Auth): CredentialProvider =>
  auth.roleArn
    ? refreshingCredentials(
        fromTemporaryCredentials({
          params: {
            RoleArn: auth.roleArn,
            RoleSessionName: auth.sessionName,
            DurationSeconds: WRITER_SESSION_SECONDS,
            ...(auth.externalId ? { ExternalId: auth.externalId } : {}),
          },
          clientConfig: { region: auth.region },
        }),
      )
    : fromNodeProviderChain()

export function buildDeps(env: NodeJS.ProcessEnv): Deps {
  const config = parseConfig(env.CONFIG)
  const clientConfig = env.AWS_REGION ? { region: env.AWS_REGION } : {}
  const sqs = sqsQueueAttributes(new SQSClient(clientConfig))
  const cloudwatch = cloudWatchQueueAges(new CloudWatchClient(clientConfig))
  const ec2 = ec2RunnerInstances(new EC2Client(clientConfig))
  const readSecret = secretsManagerValue(new SecretsManagerClient(clientConfig))
  const readParameter = ssmParameterValue(new SSMClient(clientConfig))
  const { runnerConfigs } = config

  return {
    config,
    now: Date.now,
    log: jsonLogger,
    vanish: createVanishTracker(),
    sources: {
      queueDepths: signal => readQueueDepths(sqs, runnerConfigs, signal),
      queueAges: (now, signal) => readQueueAges(cloudwatch, runnerConfigs, now, signal),
      instances: signal => readInstances(ec2, runnerConfigs, signal),
      github: githubSource(config, githubCredentials(config, readSecret, readParameter)),
    },
    sink: remoteWriteSink({
      url: config.remoteWrite.url,
      auth: authFromConfig(config.remoteWrite.auth, {
        secret: arn => cachedCredential(signal => readSecret(arn, signal)),
        credentialsFor: writerCredentials,
      }),
      headers: config.remoteWrite.headers,
      timeoutMs: config.remoteWrite.timeoutMs,
      userAgent: USER_AGENT,
      fetch,
    }),
  }
}

let deps: Deps | undefined

export async function handler(): Promise<Outcome> {
  deps ??= buildDeps(process.env)
  return sampleOnce(deps)
}
