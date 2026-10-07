import { createSign } from 'node:crypto'

/** A GitHub App's identity: a dedicated read-only App, or the runner module's (see the README). */
export interface AppCredentials {
  readonly appId: string
  readonly privateKey: string
}

const APP_ID = /^\d+$/

/** The dedicated App's secret: {"app_id": "...", "private_key": "-----BEGIN ... KEY-----..."}. */
export function parseAppSecret(raw: string): AppCredentials {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('GitHub App secret must be JSON {"app_id": "...", "private_key": "..."}')
  }
  const { app_id, private_key } = (parsed ?? {}) as Record<string, unknown>
  const appId = typeof app_id === 'number' ? String(app_id) : app_id
  if (
    typeof appId !== 'string' ||
    !APP_ID.test(appId) ||
    typeof private_key !== 'string' ||
    !private_key.includes('PRIVATE KEY')
  ) {
    throw new Error('GitHub App secret must be JSON {"app_id": "...", "private_key": "..."}')
  }
  return { appId, privateKey: private_key }
}

/** The runner module stores its App's key base64-encoded in SSM (github_app.key_base64). */
export function credentialsFromRunnerModule(appId: string, keyBase64: string): AppCredentials {
  const privateKey = Buffer.from(keyBase64.trim(), 'base64').toString('utf8')
  if (!APP_ID.test(appId.trim()) || !privateKey.includes('PRIVATE KEY')) {
    throw new Error(
      'the runner module GitHub App parameters do not hold an app id and a base64 PEM key',
    )
  }
  return { appId: appId.trim(), privateKey }
}

const base64url = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

/** An App JWT (RS256), backdated a minute for clock skew; GitHub accepts at most ten minutes. */
export function mintJwt(credentials: AppCredentials, now: number): string {
  const seconds = Math.floor(now / 1000)
  const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
    iat: seconds - 60,
    exp: seconds + 540,
    iss: credentials.appId,
  })}`
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(credentials.privateKey, 'base64url')}`
}
