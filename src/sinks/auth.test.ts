import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { authFromConfig, basicAuth, bearerAuth, noAuth, sigv4Auth } from './auth.ts'

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
const secrets = (values: Record<string, string>) => async (arn: string) => values[arn]

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
    })(request)
    // Pinned: the same request signed independently with @smithy/signature-v4 while building the
    // first version of this sampler, whose pushes AMP accepted.
    assert.equal(
      headers.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-west-1/aps/aws4_request, SignedHeaders=content-encoding;content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-prometheus-remote-write-version, Signature=2c4207f3c63389dbf8fc38229dcb3556893b7a388f9159d57fb2108001f812d6',
    )
    assert.equal(headers['x-amz-security-token'], 'SESSIONTOKEN')
  })
})

describe('basic and bearer auth', () => {
  it('reads the credentials from the secret at request time', async () => {
    const basic = await basicAuth(
      secrets({ b: '{"username":"123","password":"glc_token"}' }),
      'b',
    )(request)
    assert.equal(basic.authorization, `Basic ${Buffer.from('123:glc_token').toString('base64')}`)
    const bearer = await bearerAuth(secrets({ t: '{"token":"abc"}' }), 't')(request)
    assert.equal(bearer.authorization, 'Bearer abc')
    const bare = await bearerAuth(secrets({ t: 'abc\n' }), 't')(request)
    assert.equal(bare.authorization, 'Bearer abc')
  })

  it('fails clearly on an empty or malformed secret, without echoing it', async () => {
    await assert.rejects(basicAuth(secrets({}), 'b')(request), /has no value/)
    await assert.rejects(
      basicAuth(secrets({ b: '{"username":"u"}' }), 'b')(request),
      /needs \{"username": "...", "password": "..."\}/,
    )
  })

  it('passes the request headers through untouched without auth', async () => {
    assert.deepEqual(await noAuth(request), request.headers)
  })
})

describe('authFromConfig', () => {
  it('builds the configured strategy', async () => {
    const auth = authFromConfig(
      { type: 'bearer', secretArn: 't' },
      { readSecret: secrets({ t: 'abc' }), credentialsFor: () => assert.fail('not sigv4') },
    )
    assert.equal((await auth(request)).authorization, 'Bearer abc')
  })
})
