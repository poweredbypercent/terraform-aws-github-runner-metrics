import type { Cached } from '../../cache.ts'
import { scopeApiPath, scopeKey } from '../../domain/scope.ts'
import type { GitHubScope } from '../../domain/types.ts'
import type { Fetch } from '../../http.ts'
import { type AppCredentials, mintJwt } from './credentials.ts'

/**
 * GitHub REST calls as a GitHub App, with installation tokens cached across warm invocations.
 *
 * A token is minted per scope and narrowed to what listing runners needs there, whatever else the
 * App is granted (see the README for the permissions). Tokens live an hour and are reused until
 * five minutes before they expire, so a warm sampler mints about once an hour per scope.
 *
 * When GitHub refuses the App itself (401 on a JWT call: a revoked or rotated key), everything
 * cached from those credentials is dropped and they are read again; when an installation has gone
 * (404 minting a token: the App was reinstalled), its id is looked up again.
 */

export class GitHubHttpError extends Error {
  override readonly name = 'GitHubHttpError'
  readonly status: number
  constructor(method: string, path: string, status: number) {
    // Status and path only: never the JWT or a token, which are in the request headers.
    super(`GitHub ${method} ${path}: ${status}`)
    this.status = status
  }
}

const isStatus = (error: unknown, status: number): boolean =>
  error instanceof GitHubHttpError && error.status === status

export interface GitHubAppClient {
  /** GET a path relative to the scope's API base, as the App installation for that scope. */
  get(scope: GitHubScope, path: string, signal: AbortSignal): Promise<unknown>
}

const TOKEN_MARGIN_MS = 5 * 60_000

const narrowedTo = (scope: GitHubScope) =>
  scope.repo
    ? { repositories: [scope.repo], permissions: { administration: 'read' } }
    : { permissions: { organization_self_hosted_runners: 'read' } }

export function createGitHubAppClient(options: {
  credentials: Cached<AppCredentials>
  fetch: Fetch
  userAgent: string
  now: () => number
}): GitHubAppClient {
  let mintedWith: AppCredentials | undefined
  const installations = new Map<string, number>()
  const tokens = new Map<string, { token: string; expiresAt: number }>()

  const request = async (
    method: 'GET' | 'POST',
    url: string,
    token: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> => {
    const response = await options.fetch(url, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': options.userAgent,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    })
    if (!response.ok) throw new GitHubHttpError(method, new URL(url).pathname, response.status)
    return response.json()
  }

  const forget = () => {
    installations.clear()
    tokens.clear()
  }

  const currentCredentials = async (signal: AbortSignal): Promise<AppCredentials> => {
    const app = await options.credentials.get(signal)
    if (!app) throw new Error('GitHub App credentials are not configured')
    // A rotated key or a different App invalidates everything minted with the old one.
    if (app.appId !== mintedWith?.appId || app.privateKey !== mintedWith.privateKey) forget()
    mintedWith = app
    return app
  }

  /** A call authenticated as the App itself (JWT). */
  const asApp = async (
    method: 'GET' | 'POST',
    url: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<unknown> => {
    const jwt = mintJwt(await currentCredentials(signal), options.now())
    try {
      return await request(method, url, jwt, signal, body)
    } catch (error) {
      if (isStatus(error, 401)) {
        options.credentials.invalidate()
        forget()
      }
      throw error
    }
  }

  const installationId = async (scope: GitHubScope, signal: AbortSignal): Promise<number> => {
    const key = scopeKey(scope)
    const known = installations.get(key)
    if (known !== undefined) return known
    const { id } = (await asApp(
      'GET',
      `${scope.apiUrl}${scopeApiPath(scope)}/installation`,
      signal,
    )) as { id: number }
    installations.set(key, id)
    return id
  }

  const mint = async (scope: GitHubScope, signal: AbortSignal) => {
    // Credentials first: a rotation clears the installation ids before one is used.
    await currentCredentials(signal)
    const id = await installationId(scope, signal)
    return (await asApp(
      'POST',
      `${scope.apiUrl}/app/installations/${id}/access_tokens`,
      signal,
      narrowedTo(scope),
    )) as { token: string; expires_at: string }
  }

  const tokenFor = async (scope: GitHubScope, signal: AbortSignal): Promise<string> => {
    const key = scopeKey(scope)
    const cached = tokens.get(key)
    if (cached && options.now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.token
    const knownInstallation = installations.has(key)
    let minted: { token: string; expires_at: string }
    try {
      minted = await mint(scope, signal)
    } catch (error) {
      if (!knownInstallation || !isStatus(error, 404)) throw error
      // The installation the cached id named has gone; the App may have been reinstalled.
      installations.delete(key)
      minted = await mint(scope, signal)
    }
    tokens.set(key, { token: minted.token, expiresAt: Date.parse(minted.expires_at) })
    return minted.token
  }

  return {
    async get(scope, path, signal) {
      const call = async () =>
        request('GET', `${scope.apiUrl}${path}`, await tokenFor(scope, signal), signal)
      try {
        return await call()
      } catch (error) {
        if (!isStatus(error, 401)) throw error
        // A token revoked, or a key rotated early: mint once more before giving up.
        tokens.delete(scopeKey(scope))
        return call()
      }
    },
  }
}
