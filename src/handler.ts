import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch'
import { DescribeInstancesCommand, EC2Client, type Instance } from '@aws-sdk/client-ec2'
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager'
import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers'
import { parseConfig } from './config/parse.ts'
import type { Config, RemoteWriteAuth } from './config/types.ts'
import { jsonLogger } from './log.ts'
import { createVanishTracker } from './model/vanish.ts'
import { type Deps, type Outcome, sampleOnce } from './run.ts'
import { type AwsCredentials, authFromConfig } from './sinks/auth.ts'
import { remoteWriteSink } from './sinks/remote-write/sink.ts'
import { readInstances, readQueueAges, readQueueDepths } from './sources/aws.ts'
import { createGitHubAppClient } from './sources/github/client.ts'
import {
  type AppCredentials,
  credentialsFromRunnerModule,
  parseAppSecret,
} from './sources/github/credentials.ts'
import { readRegisteredRunners } from './sources/github/runners.ts'

/**
 * The Lambda entry point and the only place that touches AWS clients, fetch and the environment:
 * everything else takes what it needs as arguments. Dependencies are built once per container
 * and kept while it is warm, so caches (GitHub tokens, writer credentials, the vanish tracker)
 * survive from one minute's sample to the next.
 */

/** Set at build time from package.json; "dev" when run from source. */
declare const __VERSION__: string
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev'
const USER_AGENT = `terraform-aws-github-runner-metrics/${VERSION}`
const SECRET_TTL_MS = 10 * 60_000

/** A Secrets Manager secret's value, cached; undefined when it has not been given one yet. */
function secretReader(
  client: SecretsManagerClient,
): (arn: string, signal?: AbortSignal) => Promise<string | undefined> {
  const cache = new Map<string, { value: string | undefined; readAt: number }>()
  return async (arn, signal) => {
    const cached = cache.get(arn)
    if (cached && Date.now() - cached.readAt < SECRET_TTL_MS && cached.value !== undefined)
      return cached.value
    let value: string | undefined
    try {
      const out = await client.send(
        new GetSecretValueCommand({ SecretId: arn }),
        signal ? { abortSignal: signal } : {},
      )
      value = out.SecretString?.trim() || undefined
    } catch (err) {
      // Created empty by the module: there is no version until someone puts the value in.
      if ((err as { name?: string }).name !== 'ResourceNotFoundException') throw err
    }
    cache.set(arn, { value, readAt: Date.now() })
    return value
  }
}

function githubCredentialsLoader(
  config: Config,
  secrets: ReturnType<typeof secretReader>,
  ssm: SSMClient,
): ((signal: AbortSignal) => Promise<AppCredentials | undefined>) | undefined {
  const credentials = config.github.credentials
  switch (credentials.type) {
    case 'none':
      return undefined
    case 'secret':
      return async signal => {
        const raw = await secrets(credentials.secretArn, signal)
        return raw ? parseAppSecret(raw) : undefined
      }
    case 'ssm':
      return async signal => {
        const read = async (Name: string) =>
          (
            await ssm.send(new GetParameterCommand({ Name, WithDecryption: true }), {
              abortSignal: signal,
            })
          ).Parameter?.Value ?? ''
        const [appId, key] = await Promise.all([
          read(credentials.appIdParameter),
          read(credentials.privateKeyParameter),
        ])
        return credentialsFromRunnerModule(appId, key)
      }
  }
}

function writerCredentials(
  auth: Extract<RemoteWriteAuth, { type: 'sigv4' }>,
): () => Promise<AwsCredentials> {
  // Both providers cache and refresh by themselves.
  return auth.roleArn
    ? fromTemporaryCredentials({
        params: {
          RoleArn: auth.roleArn,
          RoleSessionName: 'github-runner-metrics',
          DurationSeconds: 900,
          ...(auth.externalId ? { ExternalId: auth.externalId } : {}),
        },
        clientConfig: { region: auth.region },
      })
    : fromNodeProviderChain()
}

export function buildDeps(env: NodeJS.ProcessEnv): Deps {
  const config = parseConfig(env.CONFIG)
  const region = env.AWS_REGION
  const clientConfig = region ? { region } : {}
  const sqs = new SQSClient(clientConfig)
  const cloudwatch = new CloudWatchClient(clientConfig)
  const ec2 = new EC2Client(clientConfig)
  const secrets = secretReader(new SecretsManagerClient(clientConfig))
  const ssm = new SSMClient(clientConfig)

  const loadGitHubCredentials = githubCredentialsLoader(config, secrets, ssm)
  const github = loadGitHubCredentials
    ? createGitHubAppClient({
        loadCredentials: loadGitHubCredentials,
        fetch,
        userAgent: USER_AGENT,
        now: Date.now,
      })
    : undefined

  return {
    config,
    now: Date.now,
    log: jsonLogger,
    vanish: createVanishTracker(),
    sources: {
      queueDepths: signal =>
        readQueueDepths(
          async (QueueUrl, abortSignal) =>
            (
              await sqs.send(
                new GetQueueAttributesCommand({
                  QueueUrl,
                  AttributeNames: [
                    'ApproximateNumberOfMessages',
                    'ApproximateNumberOfMessagesNotVisible',
                    'ApproximateNumberOfMessagesDelayed',
                  ],
                }),
                { abortSignal },
              )
            ).Attributes ?? {},
          config.runnerConfigs,
          signal,
        ),
      queueAges: (now, signal) =>
        readQueueAges(
          async (queueNames, window, abortSignal) => {
            const datapoints = new Map<string, number[]>()
            // GetMetricData takes up to 500 queries a call.
            for (let start = 0; start < queueNames.length; start += 500) {
              const names = queueNames.slice(start, start + 500)
              const queries: MetricDataQuery[] = names.map((name, i) => ({
                Id: `q${start + i}`,
                MetricStat: {
                  Metric: {
                    Namespace: 'AWS/SQS',
                    MetricName: 'ApproximateAgeOfOldestMessage',
                    Dimensions: [{ Name: 'QueueName', Value: name }],
                  },
                  Period: 60,
                  Stat: 'Maximum',
                },
              }))
              let NextToken: string | undefined
              do {
                const out = await cloudwatch.send(
                  new GetMetricDataCommand({
                    StartTime: window.start,
                    EndTime: window.end,
                    ScanBy: 'TimestampDescending',
                    MetricDataQueries: queries,
                    NextToken,
                  }),
                  { abortSignal },
                )
                for (const result of out.MetricDataResults ?? []) {
                  const name = queueNames[Number(result.Id?.slice(1))]
                  if (name)
                    datapoints.set(name, [
                      ...(datapoints.get(name) ?? []),
                      ...(result.Values ?? []),
                    ])
                }
                NextToken = out.NextToken
              } while (NextToken)
            }
            return datapoints
          },
          config.runnerConfigs,
          now,
          signal,
        ),
      instances: signal =>
        readInstances(
          async (environments, abortSignal) => {
            const instances: Instance[] = []
            let NextToken: string | undefined
            do {
              const page = await ec2.send(
                new DescribeInstancesCommand({
                  Filters: [
                    { Name: 'tag:ghr:Application', Values: ['github-action-runner'] },
                    { Name: 'tag:ghr:environment', Values: [...environments] },
                    { Name: 'instance-state-name', Values: ['pending', 'running'] },
                  ],
                  NextToken,
                }),
                { abortSignal },
              )
              for (const reservation of page.Reservations ?? [])
                instances.push(...(reservation.Instances ?? []))
              NextToken = page.NextToken
            } while (NextToken)
            return instances
          },
          config.runnerConfigs,
          signal,
        ),
      registeredRunners: github
        ? async (scopes, signal) =>
            (await github.credentials(signal))
              ? readRegisteredRunners(github, scopes, config.github.owners, signal)
              : undefined
        : undefined,
    },
    sink: remoteWriteSink({
      url: config.remoteWrite.url,
      auth: authFromConfig(config.remoteWrite.auth, {
        readSecret: arn => secrets(arn),
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
