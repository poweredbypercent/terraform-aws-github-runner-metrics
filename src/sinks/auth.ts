import { createHash, createHmac } from 'node:crypto'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, Checksum, SourceData } from '@smithy/types'
import type { Cached } from '../cache.ts'
import type { RemoteWriteAuth, SigV4Auth } from '../config/types.ts'

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

export interface Auth {
  /** The headers to send: the request's own, plus whatever authenticates it. */
  sign(request: UnsignedRequest, signal: AbortSignal): Promise<Record<string, string>>
  /** The receiver refused the credentials: forget cached ones so the next push reads them again. */
  refused(): void
}

const toHashInput = (data: SourceData): string | Uint8Array =>
  typeof data === 'string'
    ? data
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)

/** node:crypto behind the Checksum interface the signer wants; no extra hashing dependency. */
class Sha256 implements Checksum {
  private readonly hash
  constructor(secret?: SourceData) {
    this.hash =
      secret === undefined ? createHash('sha256') : createHmac('sha256', toHashInput(secret))
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

const nothingCached = (): void => {}

/** SigV4 with the AWS SDK's own signer; credentials come from a provider that caches and refreshes. */
export function sigv4Auth(options: {
  region: string
  service: string
  credentials: () => Promise<AwsCredentialIdentity>
  now?: () => Date
}): Auth {
  const signer = new SignatureV4({
    region: options.region,
    service: options.service,
    credentials: options.credentials,
    sha256: Sha256,
  })
  return {
    async sign(request) {
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
    },
    refused: nothingCached,
  }
}

/** A secret's value, read when needed and cached; undefined until someone fills it in. */
export type SecretValue = Cached<string>

async function secretJson(secret: SecretValue, signal: AbortSignal) {
  const raw = await secret.get(signal)
  if (!raw) throw new Error('the remote-write secret has no value yet')
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    // A bearer secret may be the bare token.
    return { token: raw.trim() }
  }
}

const withAuthorization = (request: UnsignedRequest, authorization: string) => ({
  ...request.headers,
  authorization,
})

export function basicAuth(secret: SecretValue): Auth {
  return {
    async sign(request, signal) {
      const { username, password } = await secretJson(secret, signal)
      if (typeof username !== 'string' || typeof password !== 'string') {
        throw new Error('basic auth secret needs {"username": "...", "password": "..."}')
      }
      const token = Buffer.from(`${username}:${password}`).toString('base64')
      return withAuthorization(request, `Basic ${token}`)
    },
    refused: () => secret.invalidate(),
  }
}

export function bearerAuth(secret: SecretValue): Auth {
  return {
    async sign(request, signal) {
      const { token } = await secretJson(secret, signal)
      if (typeof token !== 'string' || token === '') {
        throw new Error('bearer auth secret needs {"token": "..."} or the bare token')
      }
      return withAuthorization(request, `Bearer ${token}`)
    },
    refused: () => secret.invalidate(),
  }
}

export const noAuth: Auth = {
  sign: async request => ({ ...request.headers }),
  refused: nothingCached,
}

export function authFromConfig(
  auth: RemoteWriteAuth,
  deps: {
    secret: (arn: string) => SecretValue
    credentialsFor: (auth: SigV4Auth) => () => Promise<AwsCredentialIdentity>
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
      return basicAuth(deps.secret(auth.secretArn))
    case 'bearer':
      return bearerAuth(deps.secret(auth.secretArn))
  }
}
