import { createHash, createHmac } from 'node:crypto'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, Checksum, SourceData } from '@smithy/types'
import type { Cached } from '../cache.ts'
import type { RemoteWriteAuth, SigV4Auth } from '../config/types.ts'
import { untilAborted } from '../domain/settle.ts'

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

export type CredentialProvider = () => Promise<AwsCredentialIdentity>

/** Credentials are refreshed this long before they expire. */
const CREDENTIAL_REFRESH_MARGIN_MS = 5 * 60_000

/**
 * A provider that keeps its credentials until shortly before they expire. The SDK's assume-role
 * provider does not cache by itself (its clients do, around it), and called straight from the
 * signer it would call STS on every push. Concurrent callers share one refresh.
 */
export function refreshingCredentials(
  provider: CredentialProvider,
  now: () => number = Date.now,
): CredentialProvider {
  let current: AwsCredentialIdentity | undefined
  let refreshing: Promise<AwsCredentialIdentity> | undefined
  const fresh = (c: AwsCredentialIdentity) =>
    c.expiration === undefined || c.expiration.getTime() - now() > CREDENTIAL_REFRESH_MARGIN_MS
  return async () => {
    if (current && fresh(current)) return current
    refreshing ??= provider()
      .then(credentials => {
        current = credentials
        return credentials
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }
}

/**
 * SigV4 with the AWS SDK's own signer. Getting the credentials (an STS call, when a writer role is
 * assumed) comes out of the push's own budget: it takes the push's signal, so a hung call cannot
 * run on to the Lambda's timeout.
 */
export function sigv4Auth(options: {
  region: string
  service: string
  credentials: CredentialProvider
  now?: () => Date
}): Auth {
  return {
    async sign(request, signal) {
      const signer = new SignatureV4({
        region: options.region,
        service: options.service,
        credentials: await untilAborted(options.credentials(), signal),
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
    },
    refused: nothingCached,
  }
}

/** A secret's value, read when needed and cached; undefined until someone fills it in. */
export type SecretValue = Cached<string>

/** The secret's fields when it is a JSON object; otherwise it is a bare token. */
async function secretFields(
  secret: SecretValue,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const raw = await secret.get(signal)
  if (!raw) throw new Error('the remote-write secret has no value yet')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Readonly<Record<string, unknown>>
  }
  return { token: raw.trim() }
}

/**
 * Visible ASCII only. A token with a line break or control character in it (a wrapped paste)
 * would make fetch reject the header, and its error message would quote the value.
 */
const TOKEN = /^[\x21-\x7e]+$/

const withAuthorization = (request: UnsignedRequest, authorization: string) => ({
  ...request.headers,
  authorization,
})

export function basicAuth(secret: SecretValue): Auth {
  return {
    async sign(request, signal) {
      const { username, password } = await secretFields(secret, signal)
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
      const { token } = await secretFields(secret, signal)
      if (typeof token !== 'string' || !TOKEN.test(token)) {
        throw new Error(
          'bearer auth secret needs {"token": "..."} or the bare token, printable and on one line',
        )
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
    credentialsFor: (auth: SigV4Auth) => CredentialProvider
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
