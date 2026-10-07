import {
  GetMetricDataCommand,
  type GetMetricDataCommandOutput,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch'
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  type Instance,
} from '@aws-sdk/client-ec2'
import {
  GetSecretValueCommand,
  type GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager'
import {
  GetQueueAttributesCommand,
  type GetQueueAttributesCommandOutput,
} from '@aws-sdk/client-sqs'
import { GetParameterCommand, type GetParameterCommandOutput } from '@aws-sdk/client-ssm'
import type { DescribeRunnerInstances, GetQueueAgeDatapoints, GetQueueAttributes } from './aws.ts'

/**
 * The AWS SDK calls behind the source ports: the paging, batching and error meanings of each API,
 * and nothing about runners. Each takes only the client's `send` for the one command it uses, so
 * tests pass a fake.
 */

type Send<C, O> = { send(command: C, options: { abortSignal: AbortSignal }): Promise<O> }

export const sqsQueueAttributes =
  (sqs: Send<GetQueueAttributesCommand, GetQueueAttributesCommandOutput>): GetQueueAttributes =>
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
    ).Attributes ?? {}

/** GetMetricData takes up to 500 queries a call. */
const QUERIES_PER_CALL = 500

export const cloudWatchQueueAges =
  (cloudwatch: Send<GetMetricDataCommand, GetMetricDataCommandOutput>): GetQueueAgeDatapoints =>
  async (queueNames, window, abortSignal) => {
    const datapoints = new Map<string, number[]>()
    for (let start = 0; start < queueNames.length; start += QUERIES_PER_CALL) {
      const nameById = new Map(
        queueNames.slice(start, start + QUERIES_PER_CALL).map((name, i) => [`q${i}`, name]),
      )
      const queries: MetricDataQuery[] = [...nameById].map(([Id, name]) => ({
        Id,
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
          const name = nameById.get(result.Id ?? '')
          if (!name) continue
          const values = datapoints.get(name)
          if (values) values.push(...(result.Values ?? []))
          else datapoints.set(name, [...(result.Values ?? [])])
        }
        NextToken = out.NextToken
      } while (NextToken)
    }
    return datapoints
  }

export const ec2RunnerInstances =
  (ec2: Send<DescribeInstancesCommand, DescribeInstancesCommandOutput>): DescribeRunnerInstances =>
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
      for (const reservation of page.Reservations ?? []) {
        instances.push(...(reservation.Instances ?? []))
      }
      NextToken = page.NextToken
    } while (NextToken)
    return instances
  }

/** A secret's value, or undefined when it has none yet. */
export type ReadSecret = (arn: string, signal: AbortSignal) => Promise<string | undefined>
export type ReadParameter = (name: string, signal: AbortSignal) => Promise<string>

/**
 * A secret's current value, or undefined when it has none yet: the module creates the secret
 * empty, and it has no AWSCURRENT version until someone puts the value in. A secret that does not
 * exist at all (a wrong or deleted ARN) is an error, not "not filled in yet".
 */
export const secretsManagerValue =
  (secrets: Send<GetSecretValueCommand, GetSecretValueCommandOutput>): ReadSecret =>
  async (arn, abortSignal) => {
    try {
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: arn }), { abortSignal })
      return out.SecretString?.trim() || undefined
    } catch (error) {
      if (isUnfilledSecret(error)) return undefined
      throw error
    }
  }

const isUnfilledSecret = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === 'ResourceNotFoundException' &&
  /staging label/i.test(error.message)

export const ssmParameterValue =
  (ssm: Send<GetParameterCommand, GetParameterCommandOutput>): ReadParameter =>
  async (name, abortSignal) =>
    (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }), { abortSignal }))
      .Parameter?.Value ?? ''
