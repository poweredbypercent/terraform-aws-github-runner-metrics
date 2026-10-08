import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { QueueRef } from '../domain/types.ts'
import { CONFIG_VERSION, parseConfig } from './parse.ts'

/**
 * The CONFIG contract between the Terraform module and the Lambda. main.tftest.hcl asserts that the
 * module renders exactly each src/test/config.v1.*.json for a fixed set of inputs; this asserts
 * that the Lambda reads those same documents, and what it takes them to mean. A change on either
 * side fails here or there, not at deploy. Between them they cover each way of reading GitHub and
 * of authenticating to remote write.
 */
const directory = new URL('../test/', import.meta.url)
const rendered = readdirSync(directory).filter(name => /^config\.v\d+\..+\.json$/.test(name))

const queues = (refs: readonly QueueRef[]) => refs.map(q => `${q.kind}:${q.name}`)

/** What each document means, in the Lambda's terms. */
const MEANING: Record<string, unknown> = {
  'config.v1.secret-sigv4.json': {
    runnerConfigs: [
      {
        name: 'fifo',
        environment: 'ci-fifo',
        maxRunners: null,
        runnerNamePrefix: '',
        githubApiUrl: 'https://ghes.example/api/v3',
        queues: ['main:ci-fifo-queued-builds.fifo'],
        labels: {},
      },
      {
        name: 'linux',
        environment: 'ci-linux',
        maxRunners: 20,
        runnerNamePrefix: 'linux',
        githubApiUrl: 'https://api.github.com',
        queues: ['main:ci-linux-queued-builds', 'dead_letter:ci-linux-queued-builds_dead_letter'],
        labels: { team: 'platform' },
      },
    ],
    github: {
      credentials: {
        type: 'secret',
        secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:github-app-AbCdEf',
      },
      owners: ['acme'],
    },
    remoteWrite: {
      url: 'https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-1/api/v1/remote_write',
      auth: {
        type: 'sigv4',
        region: 'eu-west-1',
        service: 'aps',
        roleArn: 'arn:aws:iam::210987654321:role/prometheus-writer',
        externalId: 'metrics',
        sessionName: 'github-runner-metrics-123456789012',
      },
      headers: { 'X-Scope-OrgID': 'ci' },
      timeoutMs: 10_000,
    },
    labels: { cluster: 'ci' },
    bootGraceSeconds: 30,
    sourceTimeoutMs: 10_000,
  },
  'config.v1.ssm-basic.json': {
    runnerConfigs: [
      {
        name: 'ci',
        environment: 'ci',
        maxRunners: null,
        runnerNamePrefix: '',
        githubApiUrl: 'https://api.github.com',
        queues: ['main:ci-builds'],
        labels: {},
      },
    ],
    github: {
      credentials: {
        type: 'ssm',
        appIdParameter: '/gh/app-id',
        privateKeyParameter: '/gh/app-key',
      },
      owners: ['acme/infra'],
    },
    remoteWrite: {
      url: 'https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push',
      auth: {
        type: 'basic',
        secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:grafana-AbCdEf',
      },
      headers: {},
      timeoutMs: 10_000,
    },
    labels: {},
    bootGraceSeconds: 30,
    sourceTimeoutMs: 10_000,
  },
  'config.v1.disabled-bearer.json': {
    runnerConfigs: [
      {
        name: 'ci',
        environment: 'ci',
        maxRunners: 0,
        runnerNamePrefix: 'ci-',
        githubApiUrl: 'https://api.github.com',
        queues: ['main:ci-queued-builds', 'dead_letter:ci-queued-builds_dead_letter'],
        labels: {},
      },
    ],
    github: { credentials: { type: 'none' }, owners: [] },
    remoteWrite: {
      url: 'https://mimir.example:8443/api/v1/push',
      auth: {
        type: 'bearer',
        secretArn: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:mimir-AbCdEf',
      },
      headers: {},
      timeoutMs: 20_000,
    },
    labels: {},
    bootGraceSeconds: 60,
    sourceTimeoutMs: 15_000,
  },
}

describe('the CONFIG the Terraform module renders', () => {
  it('has a meaning written down for every rendered document, and no other', () => {
    assert.deepEqual([...rendered].sort(), Object.keys(MEANING).sort())
  })

  for (const name of rendered) {
    it(`${name} is the version this Lambda reads, and means what the module meant`, () => {
      const text = readFileSync(new URL(name, directory), 'utf8')
      assert.equal(JSON.parse(text).version, CONFIG_VERSION)
      const config = parseConfig(text)
      assert.deepEqual(
        {
          ...config,
          runnerConfigs: config.runnerConfigs.map(c => ({ ...c, queues: queues(c.queues) })),
        },
        MEANING[name],
      )
    })
  }
})
