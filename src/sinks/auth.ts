import { createHash, createHmac } from 'node:crypto'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, Checksum, SourceData } from '@smithy/types'
import type { RemoteWriteAuth } from '../config/types.ts'

/**
 * How a remote-write request is authenticated. Each strategy turns the final request (body
 * included, since SigV4 signs it) into the headers to send; plain configured headers such as
 * X-Scope-OrgID are added by the sink for every strategy.
 *
 *   AMP              sigv4 (service aps), optionally through a role in the workspace's account
 *   Grafana Cloud    basic: instance id + access-policy token
 *   Mimir behind a proxy, others   bearer, or basic
 *   Prometheus with --web.enable-remote-write-receiver   none
 */

export interface UnsignedRequest {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
}

export type Auth = (request: UnsignedRequest) => Promise<Record<string, string>>

export type AwsCredentials = AwsCredentialIdentity

const bytes = (data: SourceData): string | Uint8Array =>
  typeof data === 'string'
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)

/** node:crypto behind the Checksum interface the signer wants; no extra hashing dependency. */
class Sha256 implements Checksum {
  private readonly hash
  constructor(secret?: SourceData) {
    this.hash = secret === undefined ? createHash('sha256') : createHmac('sha256', bytes(secret))
  }
  update(data: Uint8Array): void {
    this.hash.update(data)
  }
  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.hash.digest())
  }
  reset(): void {
    throw new Error('not supported')
  }
}

/** SigV4 with the AWS SDK's own signer; credentials come from a provider that caches and refreshes. */
export function sigv4Auth(options: {
  region: string
  service: string
  credentials: () => Promise<AwsCredentials>
  now?: () => Date
}): Auth {
  return async request => {
    const signer = new SignatureV4({
      region: options.region,
      service: options.service,
      credentials: options.credentials,
      sha256: Sha256,
    })
    const url = new URL(request.url)
    const signed = await signer.sign(
      new HttpRequest({
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname,
        headers: { ...request.headers, host: url.host },
        body: request.body,
      }),
      options.now ? { signingDate: options.now() } : {},
    )
    return signed.headers
  }
}

/** Reads a secret holding JSON; undefined when it has not been filled in yet. */
export type ReadSecret = (arn: string) => Promise<string | undefined>

async function secretJson(readSecret: ReadSecret, arn: string): Promise<Record<string, unknown>> {
  const raw = await readSecret(arn)
  if (!raw) throw new Error(`remote-write secret ${arn} has no value`)
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // A bearer secret may be the bare token.
    return { token: raw.trim() }
  }
}

export function basicAuth(readSecret: ReadSecret, arn: string): Auth {
  return async request => {
    const { username, password } = await secretJson(readSecret, arn)
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new Error('basic auth secret needs {"username": "...", "password": "..."}')
    }
    const token = Buffer.from(`${username}:${password}`).toString('base64')
    return { ...request.headers, authorization: `Basic ${token}` }
  }
}

export function bearerAuth(readSecret: ReadSecret, arn: string): Auth {
  return async request => {
    const { token } = await secretJson(readSecret, arn)
    if (typeof token !== 'string' || token === '') {
      throw new Error('bearer auth secret needs {"token": "..."} or the bare token')
    }
    return { ...request.headers, authorization: `Bearer ${token}` }
  }
}

export const noAuth: Auth = async request => ({ ...request.headers })

export function authFromConfig(
  auth: RemoteWriteAuth,
  deps: {
    readSecret: ReadSecret
    credentialsFor: (
      auth: Extract<RemoteWriteAuth, { type: 'sigv4' }>,
    ) => () => Promise<AwsCredentials>
  },
): Auth {
  switch (auth.type) {
    case 'none':
      return noAuth
    case 'sigv4':
      return sigv4Auth({
        region: auth.region,
        service: auth.service,
        credentials: deps.credentialsFor(auth),
      })
    case 'basic':
      return basicAuth(deps.readSecret, auth.secretArn)
    case 'bearer':
      return bearerAuth(deps.readSecret, auth.secretArn)
  }
}
