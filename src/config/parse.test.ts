import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { queuesOf, renderedConfig } from '../test/fixtures.ts'
import { ConfigError, parseConfig, queueFromArn } from './parse.ts'

const linux = {
  name: 'linux',
  environment: 'ci-linux',
  max_runners: 64,
  runner_name_prefix: 'linux',
  queues: queuesOf('ci-linux-queued-builds', 'ci-linux-queued-builds_dead_letter'),
}

const withRunnerConfig = (overrides: Record<string, unknown>) =>
  renderedConfig({ runner_configs: [{ ...linux, ...overrides }] })

const SECRET_ARN = 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:remote-write-AbCdEf'
const AMP = 'https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write'
const SIGV4 = {
  type: 'sigv4',
  region: 'eu-west-1',
  service: 'aps',
  session_name: 'github-runner-metrics-123456789012',
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
  it('reads the config the module renders', () => {
    const config = parseConfig(JSON.stringify(withRunnerConfig({})))
    const [first] = config.runnerConfigs
    assert.equal(first?.environment, 'ci-linux')
    assert.equal(first?.maxRunners, 64)
    assert.equal(first?.runnerNamePrefix, 'linux')
    assert.equal(first?.githubApiUrl, 'https://api.github.com')
    assert.deepEqual(
      first?.queues.map(q => [q.kind, q.name]),
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

  it("requires every field the module renders: the defaults are the module's alone", () => {
    assertProblems(
      renderedConfig({
        runner_configs: [{ ...linux, github_api_url: undefined, max_runners: undefined }],
        remote_write: { timeout_seconds: undefined },
        boot_grace_seconds: undefined,
      }),
      [
        /github_api_url must be an http\(s\) URL/,
        /max_runners must be a number/,
        /remote_write\.timeout_seconds must be a number/,
        /boot_grace_seconds must be a number/,
      ],
    )
  })

  it('treats -1 as an unlimited runner cap', () => {
    const config = parseConfig(JSON.stringify(withRunnerConfig({ max_runners: -1 })))
    assert.equal(config.runnerConfigs[0]?.maxRunners, null)
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
    const mainOnly = parseConfig(JSON.stringify(withRunnerConfig({ queues: queuesOf('jobs') })))
    assert.deepEqual(
      mainOnly.runnerConfigs[0]?.queues.map(q => q.kind),
      ['main'],
    )
  })

  it('requires a main queue', () => {
    assertProblems(withRunnerConfig({ queues: { dead_letter: null } }), [
      /queues\.main must be a non-empty string/,
    ])
  })

  it('reads the GitHub and SigV4 options', () => {
    const config = parseConfig(
      JSON.stringify(
        renderedConfig({
          github: {
            credentials: {
              type: 'secret',
              secret_arn:
                'arn:aws:secretsmanager:eu-west-1:123456789012:secret:runner-metrics/github-app-AbCdEf',
            },
            owners: ['acme', 'acme/widgets'],
          },
          remote_write: {
            url: AMP,
            auth: {
              ...SIGV4,
              role_arn: 'arn:aws:iam::210987654321:role/writer',
              external_id: 'ci',
            },
            headers: { 'X-Scope-OrgID': 'ci' },
          },
        }),
      ),
    )
    assert.equal(config.github.credentials.type, 'secret')
    assert.deepEqual(config.github.owners, ['acme', 'acme/widgets'])
    assert.deepEqual(config.remoteWrite.auth, {
      type: 'sigv4',
      region: 'eu-west-1',
      service: 'aps',
      roleArn: 'arn:aws:iam::210987654321:role/writer',
      externalId: 'ci',
      sessionName: 'github-runner-metrics-123456789012',
    })
    assert.deepEqual(config.remoteWrite.headers, { 'X-Scope-OrgID': 'ci' })
  })

  it('reads basic and bearer auth, and SSM credentials', () => {
    for (const type of ['basic', 'bearer'] as const) {
      const config = parseConfig(
        JSON.stringify(
          renderedConfig({ remote_write: { url: AMP, auth: { type, secret_arn: SECRET_ARN } } }),
        ),
      )
      assert.deepEqual(config.remoteWrite.auth, { type, secretArn: SECRET_ARN })
    }
    const ssm = parseConfig(
      JSON.stringify(
        renderedConfig({
          github: {
            credentials: {
              type: 'ssm',
              app_id_parameter: '/gh/id',
              private_key_parameter: '/gh/key',
            },
            owners: ['acme'],
          },
        }),
      ),
    )
    assert.deepEqual(ssm.github.credentials, {
      type: 'ssm',
      appIdParameter: '/gh/id',
      privateKeyParameter: '/gh/key',
    })
  })

  it('refuses a SigV4 region, service or external id AWS would not accept', () => {
    assertProblems(
      renderedConfig({
        remote_write: {
          url: AMP,
          auth: { ...SIGV4, region: 'EU_WEST_1', service: '', external_id: 'x' },
        },
      }),
      [
        /auth\.region must be a non-empty string matching/,
        /auth\.service must be a non-empty string/,
        /external_id needs role_arn/,
        /external_id must be 2-1224 characters/,
      ],
    )
  })

  it('reports every problem at once', () => {
    assertProblems(
      renderedConfig({
        version: 2,
        runner_configs: [
          {
            name: 'a',
            environment: 'dup',
            queues: { main: 'not-an-arn' },
            labels: { state: 'x', team: '' },
            runner_name_prefix: 7,
          },
          { name: 'b', environment: 'dup', queues: queuesOf('b') },
        ],
        remote_write: {
          url: 'ftp://nope',
          auth: { ...SIGV4, external_id: 'xy' },
          headers: { Authorization: 'Bearer secret' },
        },
        labels: { __hidden: 'x', 'bad-name': 'y' },
      }),
      [
        /version must be 1/,
        /queues\.main: not-an-arn is not an SQS queue ARN/,
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
    assertProblems(
      renderedConfig({
        runner_configs: [{ ...linux, github_api_url: 'http://ghe.example/api/v3' }],
        remote_write: {
          url: 'http://prom.example/write',
          auth: { type: 'bearer', secret_arn: SECRET_ARN },
        },
      }),
      [/github_api_url must use https/, /remote_write\.url must use https/],
    )
    for (const url of [
      'https://u:p@prom.example/write',
      'https://prom.example/write?token=x',
      'https://prom.example/write#x',
    ]) {
      assertProblems(renderedConfig({ remote_write: { url } }), [
        /remote_write\.url must be an http\(s\) URL without credentials, a query string or a fragment/,
      ])
    }
  })

  it('keeps credentials out of plain headers, and control characters out of their values', () => {
    for (const name of ['X-Api-Key', 'X-Auth-Token', 'Api-Secret']) {
      assertProblems(renderedConfig({ remote_write: { headers: { [name]: 'v' } } }), [
        new RegExp(`${name} looks like a credential`),
      ])
    }
    assertProblems(renderedConfig({ remote_write: { headers: { 'X-Scope-OrgID': 'a\r\nb' } } }), [
      /headers\.X-Scope-OrgID must be a non-empty string matching/,
    ])
  })

  it('refuses a wildcard secret ARN', () => {
    assertProblems(
      renderedConfig({
        github: {
          credentials: {
            type: 'secret',
            secret_arn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:*',
          },
          owners: ['acme'],
        },
      }),
      [/github\.credentials\.secret_arn/],
    )
  })

  it('requires an owners allowlist with GitHub credentials, and lower-cases it', () => {
    const credentials = {
      type: 'secret',
      secret_arn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf',
    }
    assertProblems(renderedConfig({ github: { credentials } }), [/github\.owners must list/])
    const config = parseConfig(
      JSON.stringify(renderedConfig({ github: { credentials, owners: ['Acme', 'Acme/Widgets'] } })),
    )
    assert.deepEqual(config.github.owners, ['acme', 'acme/widgets'])
  })

  it("keeps the signer's own headers for the signer", () => {
    assertProblems(renderedConfig({ remote_write: { headers: { 'X-Amz-Security-Token': 'x' } } }), [
      /X-Amz-Security-Token is set by/,
    ])
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
