import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { CONFIG_VERSION, parseConfig } from './parse.ts'

/**
 * The CONFIG contract between the Terraform module and the Lambda. main.tftest.hcl asserts that the
 * module renders exactly src/test/config.v1.json for a fixed set of inputs; this asserts that the
 * Lambda reads that same document. A change on either side fails here or there, not at deploy.
 */
const rendered = readFileSync(new URL('../test/config.v1.json', import.meta.url), 'utf8')

describe('the CONFIG the Terraform module renders', () => {
  it('is the version this Lambda reads, and parses without a problem', () => {
    assert.equal(JSON.parse(rendered).version, CONFIG_VERSION)
    assert.doesNotThrow(() => parseConfig(rendered))
  })

  it('means what the module meant', () => {
    const config = parseConfig(rendered)
    assert.deepEqual(
      config.runnerConfigs.map(c => ({
        name: c.name,
        environment: c.environment,
        maxRunners: c.maxRunners,
        prefix: c.runnerNamePrefix,
        api: c.githubApiUrl,
        queues: c.queues.map(q => `${q.kind}:${q.name}`),
        labels: c.labels,
      })),
      [
        {
          name: 'fifo',
          environment: 'ci-fifo',
          maxRunners: null,
          prefix: '',
          api: 'https://ghes.example/api/v3',
          queues: ['main:ci-fifo-queued-builds.fifo'],
          labels: {},
        },
        {
          name: 'linux',
          environment: 'ci-linux',
          maxRunners: 20,
          prefix: 'linux',
          api: 'https://api.github.com',
          queues: ['main:ci-linux-queued-builds', 'dead_letter:ci-linux-queued-builds_dead_letter'],
          labels: { team: 'platform' },
        },
      ],
    )
    assert.deepEqual(config.github.owners, ['acme'])
    assert.equal(config.github.credentials.type, 'secret')
    assert.deepEqual(config.remoteWrite.auth, {
      type: 'sigv4',
      region: 'eu-west-1',
      service: 'aps',
      roleArn: 'arn:aws:iam::210987654321:role/prometheus-writer',
      externalId: 'metrics',
      sessionName: 'github-runner-metrics-123456789012',
    })
    assert.deepEqual(config.remoteWrite.headers, { 'X-Scope-OrgID': 'ci' })
    assert.equal(config.remoteWrite.timeoutMs, 10_000)
    assert.deepEqual(config.labels, { cluster: 'ci' })
    assert.equal(config.bootGraceSeconds, 30)
    assert.equal(config.sourceTimeoutMs, 10_000)
  })
})
