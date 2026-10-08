import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { AwsCredentialIdentity } from '@smithy/types'
import { abortsAfter, cachedForTest, signal } from '../test/fixtures.ts'
import {
  authFromConfig,
  basicAuth,
  bearerAuth,
  noAuth,
  refreshingCredentials,
  sigv4Auth,
} from './auth.ts'

const AMP =
  'https://aps-workspaces.eu-west-1.amazonaws.com/workspaces/ws-5f5eaea4-b91f-42ef-9ecb-72c3853cdf57/api/v1/remote_write'
const request = {
  url: AMP,
  headers: {
    'content-encoding': 'snappy',
    'content-type': 'application/x-protobuf',
    'x-prometheus-remote-write-version': '0.1.0',
  },
  body: Uint8Array.from([1, 2, 3, 4, 5]),
}
const secret = (value: string | undefined) => cachedForTest(() => value)

describe('sigv4Auth', () => {
  it('signs a remote_write request for aps, session token included', async () => {
    const headers = await sigv4Auth({
      region: 'eu-west-1',
      service: 'aps',
      credentials: async () => ({
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
        sessionToken: 'SESSIONTOKEN',
      }),
      now: () => new Date('2015-08-30T12:36:00Z'),
    }).sign(request, signal)
    // Pinned: the same request signed independently with @smithy/signature-v4 while building the
    // first version of this sampler, whose pushes AMP accepted.
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-west-1/aps/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-prometheus-remote-write-version, Signature=2c4207f3c63389dbf8fc38229dcb3556893b7a388f9159d57fb2108001f812d6',
    )
    assert.equal(headers['x-amz-security-token'], 'SESSIONTOKEN')
  })

  it('stops waiting for credentials when the push runs out of time', async () => {
    const auth = sigv4Auth({
      region: 'eu-west-1',
      service: 'aps',
      credentials: () => new Promise(() => {}),
    })
    await assert.rejects(auth.sign(request, abortsAfter(10)), /aborted after 10ms/)
  })
})

describe('refreshingCredentials', () => {
  const issued = (expiresAt: number): AwsCredentialIdentity => ({
    accessKeyId: `AK${expiresAt}`,
    secretAccessKey: 's',
    expiration: new Date(expiresAt),
  })

  it('keeps credentials until shortly before they expire, sharing one refresh', async () => {
    let now = 0
    let calls = 0
    const provider = refreshingCredentials(
      async () => issued(now + 15 * 60_000 + calls++),
      () => now,
    )
    const [a, b] = await Promise.all([provider(), provider()])
    assert.equal(calls, 1, 'concurrent callers share one call')
    assert.equal(a, b)
    now = 9 * 60_000
    await provider()
    assert.equal(calls, 1, 'still more than five minutes to go')
    now = 11 * 60_000
    assert.equal(await provider(), a, 'four minutes left: signs while the refresh runs')
    assert.equal(calls, 2)
    await new Promise(resolve => setImmediate(resolve))
    assert.notEqual(await provider(), a, 'then the refreshed ones')
    assert.equal(calls, 2)
  })

  it('keeps signing while a refresh hangs, and replaces the hung one', async () => {
    let now = 0
    let calls = 0
    const provider = refreshingCredentials(
      async () => (calls++ === 0 ? issued(now + 15 * 60_000) : new Promise<never>(() => {})),
      () => now,
    )
    const first = await provider()
    now = 11 * 60_000
    assert.equal(await provider(), first)
    now = 11 * 60_000 + 31_000
    assert.equal(await provider(), first)
    assert.equal(calls, 3, 'the hung refresh was replaced')
  })

  it('keeps credentials that do not expire, and tries again after a failure', async () => {
    let calls = 0
    const stable = refreshingCredentials(async () => {
      calls++
      return { accessKeyId: 'AK', secretAccessKey: 's' }
    })
    await stable()
    await stable()
    assert.equal(calls, 1)
    let fail = true
    const flaky = refreshingCredentials(async () => {
      if (fail) throw new Error('sts down')
      return { accessKeyId: 'AK', secretAccessKey: 's' }
    })
    await assert.rejects(flaky(), /sts down/)
    fail = false
    assert.equal((await flaky()).accessKeyId, 'AK')
  })

  it('replaces a refresh that hangs, rather than waiting on it for good', async () => {
    let now = 0
    let calls = 0
    const provider = refreshingCredentials(
      async () => {
        calls++
        if (calls === 1) return new Promise<never>(() => {})
        return issued(now + 15 * 60_000)
      },
      () => now,
    )
    void provider()
    now = 10_000
    void provider()
    assert.equal(calls, 1, 'a refresh in flight is shared while it is young')
    now = 31_000
    assert.equal((await provider()).accessKeyId, `AK${31_000 + 15 * 60_000}`)
    assert.equal(calls, 2)
  })

  it('keeps signing with unexpired credentials when a refresh fails', async () => {
    let now = 0
    let fail = false
    const provider = refreshingCredentials(
      async () => {
        if (fail) throw new Error('sts down')
        return issued(now + 15 * 60_000)
      },
      () => now,
    )
    const first = await provider()
    fail = true
    now = 12 * 60_000
    assert.equal(await provider(), first, 'three minutes left: still signs')
    await new Promise(resolve => setImmediate(resolve))
    now = 15 * 60_000
    await assert.rejects(provider(), /sts down/, "expired: the failure is the caller's")
  })
})

describe('basic and bearer auth', () => {
  it('reads the credentials from the secret at request time', async () => {
    const basic = await basicAuth(secret('{"username":"123","password":"glc_token"}')).sign(
      request,
      signal,
    )
    assert.equal(basic.authorization, `Basic ${Buffer.from('123:glc_token').toString('base64')}`)
    const bearer = await bearerAuth(secret('{"token":"abc"}')).sign(request, signal)
    assert.equal(bearer.authorization, 'Bearer abc')
    const bare = await bearerAuth(secret('abc\n')).sign(request, signal)
    assert.equal(bare.authorization, 'Bearer abc')
    // A bare token that happens to parse as JSON is still the bare token.
    const numeric = await bearerAuth(secret('12345')).sign(request, signal)
    assert.equal(numeric.authorization, 'Bearer 12345')
  })

  it('fails clearly on an empty or malformed secret, without echoing it', async () => {
    await assert.rejects(basicAuth(secret(undefined)).sign(request, signal), /has no value/)
    await assert.rejects(
      basicAuth(secret('{"username":"u"}')).sign(request, signal),
      /needs \{"username": "...", "password": "..."\}/,
    )
    for (const token of ['zq\nzq', 'zq zq', '']) {
      await assert.rejects(
        bearerAuth(secret(JSON.stringify({ token }))).sign(request, signal),
        (error: Error) =>
          /printable and on one line/.test(error.message) && !error.message.includes('zq'),
      )
    }
  })

  it('reads the secret again once the receiver has refused it', async () => {
    let token = 'old'
    const auth = bearerAuth(cachedForTest(() => token))
    assert.equal((await auth.sign(request, signal)).authorization, 'Bearer old')
    token = 'new'
    assert.equal((await auth.sign(request, signal)).authorization, 'Bearer old')
    auth.refused()
    assert.equal((await auth.sign(request, signal)).authorization, 'Bearer new')
  })

  it('passes the request headers through untouched without auth', async () => {
    assert.deepEqual(await noAuth.sign(request, signal), request.headers)
  })
})

describe('authFromConfig', () => {
  it('builds the configured strategy', async () => {
    const auth = authFromConfig(
      { type: 'bearer', secretArn: 't' },
      { secret: () => secret('abc'), credentialsFor: () => assert.fail('not sigv4') },
    )
    assert.equal((await auth.sign(request, signal)).authorization, 'Bearer abc')
  })
})
