import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Instance } from '@aws-sdk/client-ec2'
import { parseConfig } from '../config/parse.ts'
import { readInstances, readQueueAges, readQueueDepths } from './aws.ts'

const ARN = (name: string) => `arn:aws:sqs:eu-west-1:123456789012:${name}`
const { runnerConfigs } = parseConfig(
  JSON.stringify({
    version: 1,
    runner_configs: [
      {
        name: 'linux',
        environment: 'ci-linux',
        queue_arns: [ARN('ci-linux-queued-builds'), ARN('ci-linux-queued-builds_dead_letter')],
      },
      {
        name: 'ghes',
        environment: 'ci-ghes',
        github_api_url: 'https://ghes.example/api/v3',
        queue_arns: [ARN('ci-ghes-queued-builds')],
      },
    ],
    remote_write: { url: 'http://localhost:9090/api/v1/write' },
  }),
)
const signal = new AbortController().signal

describe('readQueueDepths', () => {
  it('reads every queue, and lets a queue that fails fail alone', async () => {
    const depths = await readQueueDepths(
      async url => {
        if (url.endsWith('_dead_letter')) throw new Error('AccessDenied')
        return {
          ApproximateNumberOfMessages: '3',
          ApproximateNumberOfMessagesNotVisible: '1',
          ApproximateNumberOfMessagesDelayed: '0',
        }
      },
      runnerConfigs,
      signal,
    )
    assert.deepEqual(depths.values.get(ARN('ci-linux-queued-builds')), {
      visible: 3,
      inFlight: 1,
      delayed: 0,
    })
    assert.deepEqual(depths.failed, [ARN('ci-linux-queued-builds_dead_letter')])
  })

  it('treats a dead-letter queue that does not exist as absent, not failed', async () => {
    const depths = await readQueueDepths(
      async url => {
        if (url.endsWith('_dead_letter')) {
          throw Object.assign(new Error('The specified queue does not exist.'), {
            name: 'QueueDoesNotExist',
          })
        }
        return { ApproximateNumberOfMessages: '0' }
      },
      runnerConfigs,
      signal,
    )
    assert.deepEqual(depths.failed, [])
    assert.equal(depths.values.has(ARN('ci-linux-queued-builds_dead_letter')), false)
  })

  it('fails the source when no queue could be read', async () => {
    await assert.rejects(
      readQueueDepths(
        async () => {
          throw new Error('AccessDenied')
        },
        runnerConfigs,
        signal,
      ),
      /no queue could be read/,
    )
  })
})

describe('readQueueAges', () => {
  it('takes the newest datapoint, and reads no datapoint as an idle queue', async () => {
    let asked: readonly string[] = []
    const ages = await readQueueAges(
      async names => {
        asked = names
        return new Map([['ci-linux-queued-builds', [140, 80]]])
      },
      runnerConfigs,
      Date.parse('2026-10-07T12:00:00Z'),
      signal,
    )
    assert.deepEqual(asked, [
      'ci-linux-queued-builds',
      'ci-linux-queued-builds_dead_letter',
      'ci-ghes-queued-builds',
    ])
    assert.equal(ages.get(ARN('ci-linux-queued-builds')), 140)
    assert.equal(ages.get(ARN('ci-ghes-queued-builds')), 0)
  })
})

describe('readInstances', () => {
  const tags = (pairs: Record<string, string>) =>
    Object.entries(pairs).map(([Key, Value]) => ({ Key, Value }))

  it('maps runner instances, their purchase option and their GitHub scope', async () => {
    let environments: readonly string[] = []
    const instances = await readInstances(
      async envs => {
        environments = envs
        return [
          {
            InstanceId: 'i-0aaaaaaaa',
            InstanceType: 'c7g.xlarge',
            InstanceLifecycle: 'spot',
            State: { Name: 'running' },
            LaunchTime: new Date(1000),
            Tags: tags({ 'ghr:environment': 'ci-linux', 'ghr:Type': 'Org', 'ghr:Owner': 'acme' }),
          },
          {
            InstanceId: 'i-0bbbbbbbb',
            InstanceType: 'm7i.large',
            State: { Name: 'pending' },
            Tags: tags({
              'ghr:environment': 'ci-ghes',
              'ghr:Type': 'Repo',
              'ghr:Owner': 'acme/widgets',
              'ghr:orphan': 'true',
            }),
          },
          { InstanceId: 'i-0cccccccc', Tags: tags({ 'ghr:environment': 'another-stack' }) },
        ] satisfies Instance[]
      },
      runnerConfigs,
      signal,
    )
    assert.deepEqual(environments, ['ci-linux', 'ci-ghes'])
    assert.equal(instances.length, 2)
    assert.deepEqual(instances[0], {
      id: 'i-0aaaaaaaa',
      environment: 'ci-linux',
      instanceType: 'c7g.xlarge',
      lifecycle: 'spot',
      state: 'running',
      launchTime: 1000,
      orphan: false,
      scope: { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' },
    })
    assert.equal(instances[1]?.lifecycle, 'on-demand')
    assert.equal(instances[1]?.orphan, true)
    assert.deepEqual(instances[1]?.scope, {
      type: 'repo',
      owner: 'acme',
      repo: 'widgets',
      apiUrl: 'https://ghes.example/api/v3',
    })
  })
})
