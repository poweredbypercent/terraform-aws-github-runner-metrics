import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ConfigError, parseConfig, queueFromArn } from './parse.ts'

const minimal = {
  version: 1,
  runner_configs: [
    {
      name: 'linux',
      environment: 'ci-linux',
      max_runners: 64,
      runner_name_prefix: 'linux',
      queue_arns: [
        'arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds',
        'arn:aws:sqs:eu-west-1:123456789012:ci-linux-queued-builds_dead_letter',
      ],
    },
  ],
  remote_write: { url: 'http://localhost:9090/api/v1/write' },
}

const problemsOf = (config: unknown): readonly string[] => {
  try {
    parseConfig(JSON.stringify(config))
  } catch (err) {
    assert.ok(err instanceof ConfigError)
    return err.problems
  }
  assert.fail('expected a ConfigError')
}

describe('parseConfig', () => {
  it('reads a minimal config with defaults', () => {
    const config = parseConfig(JSON.stringify(minimal))
    const [linux] = config.runnerConfigs
    assert.equal(linux?.environment, 'ci-linux')
    assert.equal(linux?.maxRunners, 64)
    assert.equal(linux?.githubApiUrl, 'https://api.github.com')
    assert.deepEqual(
      linux?.queues.map(q => [q.kind, q.url]),
      [
        ['main', 'https://sqs.eu-west-1.amazonaws.com/123456789012/ci-linux-queued-builds'],
        [
          'dead_letter',
          'https://sqs.eu-west-1.amazonaws.com/123456789012/ci-linux-queued-builds_dead_letter',
        ],
      ],
    )
    assert.deepEqual(config.github, { credentials: { type: 'none' }, owners: [] })
    assert.deepEqual(config.remoteWrite.auth, { type: 'none' })
    assert.equal(config.remoteWrite.timeoutMs, 10_000)
    assert.equal(config.bootGraceSeconds, 30)
  })

  it('treats -1 and null as an unlimited runner cap', () => {
    for (const max_runners of [-1, null]) {
      const config = parseConfig(
        JSON.stringify({
          ...minimal,
          runner_configs: [{ ...minimal.runner_configs[0], max_runners }],
        }),
      )
      assert.equal(config.runnerConfigs[0]?.maxRunners, null)
    }
  })

  it('reads the GitHub and SigV4 options', () => {
    const config = parseConfig(
      JSON.stringify({
        ...minimal,
        github: {
          credentials: {
            type: 'secret',
            secret_arn:
              'arn:aws:secretsmanager:eu-west-1:123456789012:secret:runner-metrics/github-app-AbCdEf',
          },
          owners: ['acme', 'acme/widgets'],
        },
        remote_write: {
          url: 'https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write',
          auth: {
            type: 'sigv4',
            region: 'eu-west-1',
            role_arn: 'arn:aws:iam::210987654321:role/writer',
          },
          headers: { 'X-Scope-OrgID': 'ci' },
        },
        labels: { cluster: 'ci' },
      }),
    )
    assert.equal(config.github.credentials.type, 'secret')
    assert.deepEqual(config.github.owners, ['acme', 'acme/widgets'])
    assert.deepEqual(config.remoteWrite.auth, {
      type: 'sigv4',
      region: 'eu-west-1',
      service: 'aps',
      roleArn: 'arn:aws:iam::210987654321:role/writer',
      externalId: undefined,
    })
    assert.deepEqual(config.remoteWrite.headers, { 'X-Scope-OrgID': 'ci' })
  })

  it('reports every problem at once', () => {
    const problems = problemsOf({
      version: 2,
      runner_configs: [
        { name: 'a', environment: 'dup', queue_arns: ['not-an-arn'], labels: { state: 'x' } },
        { name: 'b', environment: 'dup', queue_arns: [] },
      ],
      remote_write: {
        url: 'ftp://nope',
        auth: { type: 'sigv4', region: 'eu-west-1', external_id: 'x' },
        headers: { Authorization: 'Bearer secret' },
      },
      labels: { __hidden: 'x', 'bad-name': 'y' },
    })
    for (const expected of [
      /version must be 1/,
      /queue_arns\[0\]: not-an-arn is not an SQS queue ARN/,
      /labels\.state is a built-in label/,
      /environment "dup" appears more than once/,
      /remote_write\.url/,
      /external_id needs role_arn/,
      /Authorization is set by the remote-write client/,
      /labels\.__hidden starts with "__"/,
      /labels\.bad-name is not a valid Prometheus label name/,
    ]) {
      assert.ok(
        problems.some(p => expected.test(p)),
        `expected a problem matching ${expected}, got:\n${problems.join('\n')}`,
      )
    }
  })

  it('rejects a missing or unparseable CONFIG', () => {
    assert.throws(() => parseConfig(undefined), /CONFIG must be set/)
    assert.throws(() => parseConfig('{'), /CONFIG must be set/)
  })
})

describe('queueFromArn', () => {
  it('derives the queue URL for other partitions', () => {
    const queue = queueFromArn('arn:aws-cn:sqs:cn-north-1:123456789012:ci-queued-builds')
    assert.ok(typeof queue !== 'string')
    assert.equal(queue.url, 'https://sqs.cn-north-1.amazonaws.com.cn/123456789012/ci-queued-builds')
  })

  it('refuses partitions it has no endpoint for', () => {
    assert.match(
      String(queueFromArn('arn:aws-iso:sqs:us-iso-east-1:123456789012:q')),
      /partition aws-iso/,
    )
  })
})
