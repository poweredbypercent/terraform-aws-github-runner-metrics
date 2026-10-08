import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { queueArn as ARN, queuesOf, signal, testConfig } from '../test/fixtures.ts'
import { type Ec2Instance, readInstances, readQueueAges, readQueueDepths } from './aws.ts'

const { runnerConfigs } = testConfig({
  runner_configs: [
    {
      name: 'linux',
      environment: 'ci-linux',
      queues: queuesOf('ci-linux-queued-builds', 'ci-linux-queued-builds_dead_letter'),
    },
    {
      name: 'ghes',
      environment: 'ci-ghes',
      github_api_url: 'https://ghes.example/api/v3',
      queues: queuesOf('ci-ghes-queued-builds'),
    },
  ],
})

const DEPTH = {
  ApproximateNumberOfMessages: '3',
  ApproximateNumberOfMessagesNotVisible: '1',
  ApproximateNumberOfMessagesDelayed: '0',
}

describe('readQueueDepths', () => {
  it('reads every queue, and lets a queue that fails fail alone, saying why', async () => {
    const depths = await readQueueDepths(
      async arn => {
        if (arn.endsWith('_dead_letter')) throw new Error('AccessDenied')
        return DEPTH
      },
      runnerConfigs,
      signal,
    )
    assert.deepEqual(depths.values.get(ARN('ci-linux-queued-builds')), {
      visible: 3,
      inFlight: 1,
      delayed: 0,
    })
    assert.deepEqual(depths.failed, [
      { key: ARN('ci-linux-queued-builds_dead_letter'), error: 'AccessDenied' },
    ])
  })

  it('treats a dead-letter queue that does not exist as absent, and a main one as failed', async () => {
    const depths = await readQueueDepths(
      async arn => (arn.endsWith('_dead_letter') || arn.includes('ghes') ? undefined : DEPTH),
      runnerConfigs,
      signal,
    )
    assert.equal(depths.values.has(ARN('ci-linux-queued-builds_dead_letter')), false)
    assert.deepEqual(depths.failed, [
      { key: ARN('ci-ghes-queued-builds'), error: 'queue ci-ghes-queued-builds does not exist' },
    ])
  })

  it('fails a queue whose attributes SQS did not return, rather than reading zero', async () => {
    const depths = await readQueueDepths(
      async arn => (arn.includes('ghes') ? { ApproximateNumberOfMessages: '2' } : DEPTH),
      runnerConfigs,
      signal,
    )
    assert.deepEqual(depths.failed, [
      {
        key: ARN('ci-ghes-queued-builds'),
        error: 'SQS returned no ApproximateNumberOfMessagesNotVisible',
      },
    ])
  })

  it('fails the source when no queue could be read, naming why', async () => {
    await assert.rejects(
      readQueueDepths(
        async () => {
          throw new Error('AccessDenied')
        },
        runnerConfigs,
        signal,
      ),
      /none of 3 could be read: AccessDenied/,
    )
  })
})

describe('readQueueAges', () => {
  it('takes the newest datapoint, and leaves out a queue without one', async () => {
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
    assert.deepEqual([...ages.keys()], [ARN('ci-linux-queued-builds')])
  })
})

describe('readInstances', () => {
  const instance = (id: string, fields: Partial<Ec2Instance>): Ec2Instance => ({
    id,
    type: undefined,
    lifecycle: undefined,
    state: undefined,
    launchTime: undefined,
    tags: {},
    ...fields,
  })

  it('maps runner instances, their purchase option and their GitHub scope', async () => {
    let environments: readonly string[] = []
    const instances = await readInstances(
      async envs => {
        environments = envs
        return [
          instance('i-0aaaaaaaa', {
            type: 'c7g.xlarge',
            lifecycle: 'spot',
            state: 'running',
            launchTime: new Date(1000),
            tags: { 'ghr:environment': 'ci-linux', 'ghr:Type': 'Org', 'ghr:Owner': 'acme' },
          }),
          instance('i-0bbbbbbbb', {
            type: 'm7i.large',
            state: 'pending',
            tags: {
              'ghr:environment': 'ci-ghes',
              'ghr:Type': 'Repo',
              'ghr:Owner': 'acme/widgets',
              'ghr:orphan': 'true',
            },
          }),
          instance('i-0cccccccc', { tags: { 'ghr:environment': 'another-stack' } }),
        ]
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
