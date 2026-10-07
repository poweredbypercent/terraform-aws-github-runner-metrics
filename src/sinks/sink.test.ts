import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Fetch } from '../http.ts'
import { type Auth, noAuth } from './auth.ts'
import { remoteWriteSink } from './remote-write/sink.ts'
import { post } from './transport.ts'

type Call = { url: string; init: RequestInit }

const respond = (...statuses: (number | Error)[]) => {
  const calls: Call[] = []
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    const next = statuses.shift() ?? 200
    if (next instanceof Error) throw next
    const body =
      next === 400 ? 'out of order sample' : next > 400 ? 'Authorization: Bearer abc' : null
    return new Response(body, { status: next })
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

  it('keeps no body but a 400 one: a proxy may echo the request headers', async () => {
    for (const status of [401, 403, 502]) {
      const { fetchImpl } = respond(status, status)
      await assert.rejects(post(fetchImpl, request, 1), (err: Error) => {
        assert.equal(err.message, `remote_write: ${status}`)
        return true
      })
    }
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

const sink = (fetchImpl: Fetch, auth: Auth = noAuth) =>
  remoteWriteSink({
    url: 'http://receiver/api/v1/write',
    auth,
    headers: { 'X-Scope-OrgID': 'ci' },
    timeoutMs: 2000,
    userAgent: 'terraform-aws-github-runner-metrics/0.1.0',
    fetch: fetchImpl,
  })
const SAMPLE = [{ name: 'm', labels: {}, value: 1, timestamp: 1 }]

describe('remoteWriteSink', () => {
  it('posts a snappy protobuf body with the remote-write headers and configured extras', async () => {
    const { calls, fetchImpl } = respond(204)
    await sink(fetchImpl).push(SAMPLE)
    const headers = calls[0]?.init.headers as Record<string, string>
    assert.equal(headers['content-encoding'], 'snappy')
    assert.equal(headers['content-type'], 'application/x-protobuf')
    assert.equal(headers['x-prometheus-remote-write-version'], '0.1.0')
    assert.equal(headers['user-agent'], 'terraform-aws-github-runner-metrics/0.1.0')
    assert.equal(headers['X-Scope-OrgID'], 'ci')
  })

  it('sends nothing for an empty sample', async () => {
    const { calls, fetchImpl } = respond()
    await sink(fetchImpl).push([])
    assert.equal(calls.length, 0)
  })

  it('tells the auth when the receiver refuses its credentials, and only then', async () => {
    let refused = 0
    const auth: Auth = { ...noAuth, refused: () => void refused++ }
    await assert.rejects(sink(respond(401).fetchImpl, auth).push(SAMPLE), /401/)
    await assert.rejects(sink(respond(403).fetchImpl, auth).push(SAMPLE), /403/)
    await assert.rejects(sink(respond(400).fetchImpl, auth).push(SAMPLE), /400/)
    assert.equal(refused, 2)
  })
})
