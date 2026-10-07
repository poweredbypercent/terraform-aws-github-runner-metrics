import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noAuth } from './auth.ts'
import { remoteWriteSink } from './remote-write/sink.ts'
import { type Fetch, post } from './transport.ts'

type Call = { url: string; init: RequestInit }

const respond = (...statuses: (number | Error)[]) => {
  const calls: Call[] = []
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = statuses.shift() ?? 200
    if (next instanceof Error) throw next
    return new Response(next >= 400 ? 'out of order sample' : null, { status: next })
  }
  return { calls, fetchImpl }
}

const request = {
  url: 'http://receiver/api/v1/write',
  headers: {},
  body: Uint8Array.of(1),
  timeoutMs: 2000,
}

describe('post', () => {
  it('does not retry a 4xx, and says why it failed', async () => {
    const { calls, fetchImpl } = respond(400)
    await assert.rejects(post(fetchImpl, request, 1), /remote_write: 400 out of order sample/)
    assert.equal(calls.length, 1)
  })

  it('does not retry a 429 either: the next sample is the retry', async () => {
    const { calls, fetchImpl } = respond(429)
    await assert.rejects(post(fetchImpl, request, 1), /429/)
    assert.equal(calls.length, 1)
  })

  it('retries a 5xx or a network error once', async () => {
    const flaky = respond(503, 204)
    await post(flaky.fetchImpl, request, 1)
    assert.equal(flaky.calls.length, 2)
    const down = respond(new Error('ECONNRESET'), new Error('ECONNRESET'))
    await assert.rejects(post(down.fetchImpl, request, 1), /remote_write: ECONNRESET/)
    assert.equal(down.calls.length, 2)
  })
})

describe('remoteWriteSink', () => {
  it('posts a snappy protobuf body with the remote-write headers and configured extras', async () => {
    const { calls, fetchImpl } = respond(204)
    await remoteWriteSink({
      url: 'http://receiver/api/v1/write',
      auth: noAuth,
      headers: { 'X-Scope-OrgID': 'ci' },
      timeoutMs: 2000,
      userAgent: 'terraform-aws-github-runner-metrics/0.1.0',
      fetch: fetchImpl,
    }).push([{ name: 'm', labels: {}, value: 1, timestamp: 1 }])
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers['content-encoding'], 'snappy')
    assert.equal(headers['content-type'], 'application/x-protobuf')
    assert.equal(headers['x-prometheus-remote-write-version'], '0.1.0')
    assert.equal(headers['user-agent'], 'terraform-aws-github-runner-metrics/0.1.0')
    assert.equal(headers['X-Scope-OrgID'], 'ci')
  })

  it('sends nothing for an empty sample', async () => {
    const { calls, fetchImpl } = respond()
    await remoteWriteSink({
      url: 'http://receiver',
      auth: noAuth,
      headers: {},
      timeoutMs: 1000,
      userAgent: 'x',
      fetch: fetchImpl,
    }).push([])
    assert.equal(calls.length, 0)
  })
})
