import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { GetMetricDataCommand, GetMetricDataCommandOutput } from '@aws-sdk/client-cloudwatch'
import type { DescribeInstancesCommand, DescribeInstancesCommandOutput } from '@aws-sdk/client-ec2'
import type {
  GetSecretValueCommand,
  GetSecretValueCommandOutput,
} from '@aws-sdk/client-secrets-manager'
import type {
  GetQueueAttributesCommand,
  GetQueueAttributesCommandOutput,
} from '@aws-sdk/client-sqs'
import { signal } from '../test/fixtures.ts'
import {
  cloudWatchQueueAges,
  ec2RunnerInstances,
  secretsManagerValue,
  sqsQueueAttributes,
  sqsQueueUrl,
} from './aws-sdk.ts'

/** A fake client: answers each send from `pages` in turn and records the commands' input. */
function fake<C extends { input: unknown }, O>(pages: Partial<O>[]) {
  const inputs: C['input'][] = []
  return {
    inputs,
    client: {
      send: async (command: C) => {
        inputs.push(command.input)
        return (pages.shift() ?? {}) as O
      },
    },
  }
}

const AWS_ERROR = (name: string, message: string) => Object.assign(new Error(message), { name })

describe('sqsQueueUrl', () => {
  it('addresses the queue in its own partition and region', () => {
    assert.equal(
      sqsQueueUrl('arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds'),
      'https://sqs.eu-west-1.amazonaws.com/123456789012/ci-queued-builds',
    )
    assert.equal(
      sqsQueueUrl('arn:aws-cn:sqs:cn-north-1:123456789012:ci-queued-builds.fifo'),
      'https://sqs.cn-north-1.amazonaws.com.cn/123456789012/ci-queued-builds.fifo',
    )
    assert.throws(
      () => sqsQueueUrl('arn:aws-iso:sqs:us-iso-east-1:123456789012:q'),
      /partition aws-iso is not supported/,
    )
  })
})

describe('sqsQueueAttributes', () => {
  const ARN = 'arn:aws:sqs:eu-west-1:123456789012:ci-queued-builds'

  it('asks for the depth attributes at the queue URL', async () => {
    const sqs = fake<GetQueueAttributesCommand, GetQueueAttributesCommandOutput>([
      { Attributes: { ApproximateNumberOfMessages: '1' } },
    ])
    assert.deepEqual(await sqsQueueAttributes(sqs.client)(ARN, signal), {
      ApproximateNumberOfMessages: '1',
    })
    assert.equal(sqs.inputs[0]?.QueueUrl, sqsQueueUrl(ARN))
  })

  it('answers undefined for a queue that does not exist, and fails on anything else', async () => {
    const failing = (error: Error) => ({
      send: async (_: GetQueueAttributesCommand): Promise<GetQueueAttributesCommandOutput> => {
        throw error
      },
    })
    const missing = AWS_ERROR('QueueDoesNotExist', 'The specified queue does not exist.')
    assert.equal(await sqsQueueAttributes(failing(missing))(ARN, signal), undefined)
    const denied = AWS_ERROR('AccessDenied', 'not authorized')
    await assert.rejects(sqsQueueAttributes(failing(denied))(ARN, signal), /not authorized/)
  })
})

describe('cloudWatchQueueAges', () => {
  it('batches queries, follows NextToken and maps datapoints back to queue names', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `queue-${i}`)
    const cw = fake<GetMetricDataCommand, GetMetricDataCommandOutput>([
      { MetricDataResults: [{ Id: 'q0', Values: [30] }], NextToken: 'more' },
      {
        MetricDataResults: [
          { Id: 'q0', Values: [20] },
          { Id: 'q499', Values: [7] },
        ],
      },
      { MetricDataResults: [{ Id: 'q0', Values: [5] }] },
    ])
    const window = { start: new Date(0), end: new Date(60_000) }
    const ages = await cloudWatchQueueAges(cw.client)(names, window, signal)
    assert.deepEqual(ages.get('queue-0'), [30, 20])
    assert.deepEqual(ages.get('queue-499'), [7])
    assert.deepEqual(ages.get('queue-500'), [5])
    assert.deepEqual(
      cw.inputs.map(i => [i.MetricDataQueries?.length, i.NextToken]),
      [
        [500, undefined],
        [500, 'more'],
        [1, undefined],
      ],
    )
  })
})

describe('ec2RunnerInstances', () => {
  it('filters on the runner module tags and pages through every reservation', async () => {
    const ec2 = fake<DescribeInstancesCommand, DescribeInstancesCommandOutput>([
      { Reservations: [{ Instances: [{ InstanceId: 'i-1' }] }], NextToken: 'next' },
      { Reservations: [{ Instances: [{ InstanceId: 'i-2' }, { InstanceId: 'i-3' }] }] },
    ])
    const instances = await ec2RunnerInstances(ec2.client)(['ci'], signal)
    assert.deepEqual(
      instances.map(i => i.InstanceId),
      ['i-1', 'i-2', 'i-3'],
    )
    assert.deepEqual(ec2.inputs[0]?.Filters?.[1], { Name: 'tag:ghr:environment', Values: ['ci'] })
  })
})

describe('secretsManagerValue', () => {
  const failing = (error: Error) => ({
    send: async (_: GetSecretValueCommand): Promise<GetSecretValueCommandOutput> => {
      throw error
    },
  })

  it('reads the current value, trimmed', async () => {
    const secrets = fake<GetSecretValueCommand, GetSecretValueCommandOutput>([
      { SecretString: ' {"token":"x"}\n' },
    ])
    assert.equal(await secretsManagerValue(secrets.client)('arn', signal), '{"token":"x"}')
  })

  it('treats a secret with no value yet as not filled in', async () => {
    const unfilled = AWS_ERROR(
      'ResourceNotFoundException',
      "Secrets Manager can't find the specified secret value for staging label: AWSCURRENT",
    )
    assert.equal(await secretsManagerValue(failing(unfilled))('arn', signal), undefined)
  })

  it('fails on a secret that does not exist: a wrong ARN is not an empty secret', async () => {
    const missing = AWS_ERROR(
      'ResourceNotFoundException',
      "Secrets Manager can't find the specified secret.",
    )
    await assert.rejects(secretsManagerValue(failing(missing))('arn', signal), /specified secret/)
  })
})
