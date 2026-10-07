import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { queuesOf } from '../test/fixtures.ts'
import { ConfigError, parseConfig, queueFromArn } from './parse.ts'

const minimal = {
  version: 1,
  runner_configs: [
    {
      name: 'linux',
      environment: 'ci-linux',
      max_runners: 64,
      runner_name_prefix: 'linux',
      queues: queuesOf('ci-linux-queued-builds', 'ci-linux-queued-builds_dead_letter'),
    },
  ],
  remote_write: { url: 'http://localhost:9090/api/v1/write' },
}

const withRunnerConfig = (overrides: Record<string, unknown>) => ({
  ...minimal,
  runner_configs: [{ ...minimal.runner_configs[0], ...overrides }],
})

const problemsOf = (config: unknown): readonly string[] => {
  try {
    parseConfig(JSON.stringify(config))
  } catch (err) {
    assert.ok(err instanceof ConfigError)
    return err.problems
  }
  assert.fail('expected a ConfigError')
}

const assertProblems = (config: unknown, expected: readonly RegExp[]) => {
  const problems = problemsOf(config)
  for (const pattern of expected) {
    assert.ok(
      problems.some(p => pattern.test(p)),
      `expected a problem matching ${pattern}, got:\n${problems.join('\n')}`,
    )
  }
}

describe('parseConfig', () => {
  it('reads a minimal config with defaults', () => {
    const config = parseConfig(JSON.stringify(minimal))
    const [linux] = config.runnerConfigs
    assert.equal(linux?.environment, 'ci-linux')
    assert.equal(linux?.maxRunners, 64)
    assert.equal(linux?.githubApiUrl, 'https://api.github.com')
    assert.deepEqual(
      linux?.queues.map(q => [q.kind, q.name]),
      [
        ['main', 'ci-linux-queued-builds'],
        ['dead_letter', 'ci-linux-queued-builds_dead_letter'],
      ],
    )
    assert.deepEqual(config.github, { credentials: { type: 'none' }, owners: [] })
    assert.deepEqual(config.remoteWrite.auth, { type: 'none' })
    assert.equal(config.remoteWrite.timeoutMs, 10_000)
    assert.equal(config.bootGraceSeconds, 30)
  })

  it('treats -1 and null as an unlimited runner cap', () => {
    for (const max_runners of [-1, null]) {
      const config = parseConfig(JSON.stringify(withRunnerConfig({ max_runners })))
      assert.equal(config.runnerConfigs[0]?.maxRunners, null)
    }
  })

  it('takes each queue kind from the config, whatever the queue is called', () => {
    const config = parseConfig(
      JSON.stringify(withRunnerConfig({ queues: queuesOf('jobs.fifo', 'jobs-failed.fifo') })),
    )
    assert.deepEqual(
      config.runnerConfigs[0]?.queues.map(q => [q.kind, q.name]),
      [
        ['main', 'jobs.fifo'],
        ['dead_letter', 'jobs-failed.fifo'],
      ],
    )
  })

  it('requires one main queue and at most one dead-letter queue, of known kinds', () => {
    assertProblems(withRunnerConfig({ queues: [] }), [/queues must have exactly one main queue/])
    assertProblems(
      withRunnerConfig({
        queues: [...queuesOf('a', 'b'), ...queuesOf('c', 'd')],
      }),
      [/exactly one main queue/, /at most one dead_letter queue/],
    )
    assertProblems(withRunnerConfig({ queues: [{ arn: queuesOf('a')[0]?.arn, kind: 'retry' }] }), [
      /queues\[0\]\.kind must be one of main, dead_letter/,
    ])
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
      sessionName: 'github-runner-metrics',
    })
    assert.deepEqual(config.remoteWrite.headers, { 'X-Scope-OrgID': 'ci' })
  })

  it('reports every problem at once', () => {
    assertProblems(
      {
        version: 2,
        runner_configs: [
          {
            name: 'a',
            environment: 'dup',
            queues: [{ arn: 'not-an-arn', kind: 'main' }],
            labels: { state: 'x', team: '' },
            runner_name_prefix: 7,
          },
          { name: 'b', environment: 'dup', queues: queuesOf('b') },
        ],
        remote_write: {
          url: 'ftp://nope',
          auth: { type: 'sigv4', region: 'eu-west-1', external_id: 'x' },
          headers: { Authorization: 'Bearer secret' },
        },
        labels: { __hidden: 'x', 'bad-name': 'y' },
      },
      [
        /version must be 1/,
        /queues\[0\]: not-an-arn is not an SQS queue ARN/,
        /labels\.state is a built-in label/,
        /labels\.team must be a non-empty string/,
        /runner_name_prefix must be a string/,
        /environment "dup" appears more than once/,
        /remote_write\.url/,
        /external_id needs role_arn/,
        /Authorization is set by the remote-write client/,
        /labels\.__hidden starts with "__"/,
        /labels\.bad-name is not a valid Prometheus label name/,
      ],
    )
  })

  it('keeps credentials off plain http and out of URLs', () => {
    const secretArn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:remote-write-AbCdEf'
    assertProblems(
      {
        ...withRunnerConfig({ github_api_url: 'http://ghe.example/api/v3' }),
        remote_write: {
          url: 'http://u:p@prom.example/write?x=1',
          auth: { type: 'bearer', secret_arn: secretArn },
        },
      },
      [
        /github_api_url must use https/,
        /remote_write\.url must use https/,
        /remote_write\.url must not contain credentials/,
        /remote_write\.url must not contain a query string/,
      ],
    )
  })

  it('keeps credentials out of plain headers, and control characters out of their values', () => {
    for (const name of ['X-Api-Key', 'X-Auth-Token', 'Api-Secret']) {
      assertProblems(
        { ...minimal, remote_write: { url: minimal.remote_write.url, headers: { [name]: 'v' } } },
        [new RegExp(`${name} looks like a credential`)],
      )
    }
    assertProblems(
      {
        ...minimal,
        remote_write: { url: minimal.remote_write.url, headers: { 'X-Scope-OrgID': 'a\r\nb' } },
      },
      [/headers\.X-Scope-OrgID must be a non-empty string matching/],
    )
  })

  it('refuses a wildcard secret ARN', () => {
    assertProblems(
      {
        ...minimal,
        github: {
          credentials: {
            type: 'secret',
            secret_arn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:*',
          },
        },
      },
      [/github\.credentials\.secret_arn/],
    )
  })

  it('requires an owners allowlist with GitHub credentials, and lower-cases it', () => {
    const secretArn = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf'
    const credentials = { type: 'secret', secret_arn: secretArn }
    assertProblems({ ...minimal, github: { credentials } }, [/github\.owners must list/])
    const config = parseConfig(
      JSON.stringify({ ...minimal, github: { credentials, owners: ['Acme', 'Acme/Widgets'] } }),
    )
    assert.deepEqual(config.github.owners, ['acme', 'acme/widgets'])
  })

  it("keeps the signer's own headers for the signer", () => {
    assertProblems(
      {
        ...minimal,
        remote_write: { url: minimal.remote_write.url, headers: { 'X-Amz-Security-Token': 'x' } },
      },
      [/X-Amz-Security-Token is set by/],
    )
  })

  it('rejects a missing or unparseable CONFIG', () => {
    assert.throws(() => parseConfig(undefined), /CONFIG must be set/)
    assert.throws(() => parseConfig('{'), /CONFIG must be set/)
  })
})

describe('queueFromArn', () => {
  const arn = (name: string) => `arn:aws:sqs:eu-west-1:123456789012:${name}`

  it('takes the queue name from the ARN, in any partition', () => {
    const queue = queueFromArn('arn:aws-cn:sqs:cn-north-1:123456789012:ci-queued-builds', 'main')
    assert.deepEqual(queue, {
      ok: true,
      value: {
        arn: 'arn:aws-cn:sqs:cn-north-1:123456789012:ci-queued-builds',
        name: 'ci-queued-builds',
        kind: 'main',
      },
    })
  })

  it('accepts the longest names SQS allows, and no longer', () => {
    assert.ok(queueFromArn(arn('q'.repeat(80)), 'main').ok)
    assert.ok(queueFromArn(arn(`${'q'.repeat(75)}.fifo`), 'main').ok)
    assert.ok(!queueFromArn(arn('q'.repeat(81)), 'main').ok)
    assert.ok(!queueFromArn(arn(`${'q'.repeat(76)}.fifo`), 'main').ok)
    assert.ok(!queueFromArn(arn('*'), 'main').ok)
  })
})
