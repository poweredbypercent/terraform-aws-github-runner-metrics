import { scopeKey } from '../../domain/scope.ts'
import type { GitHubScope } from '../../domain/types.ts'
import type { Fetch } from '../../sinks/transport.ts'
import { type AppCredentials, mintJwt } from './credentials.ts'

/**
 * GitHub REST calls as a GitHub App, with installation tokens cached across warm invocations.
 *
 * A token is minted per scope and narrowed to what listing runners needs there, whatever else the
 * App is granted: "organization_self_hosted_runners: read" for an organisation, "administration:
 * read" on just that repository for repository-level runners. Tokens live an hour and are reused
 * until five minutes before they expire, so a warm sampler mints about once an hour per scope.
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

export interface GitHubAppClient {
  /** GET a path relative to the scope's API base, as the App installation for that scope. */
  get(scope: GitHubScope, path: string, signal: AbortSignal): Promise<unknown>
}

const TOKEN_MARGIN_MS = 5 * 60_000
const CREDENTIALS_TTL_MS = 10 * 60_000

async function request(
  fetchImpl: Fetch,
  url: string,
  options: {
    method: 'GET' | 'POST'
    token: string
    body?: unknown
    signal: AbortSignal
    userAgent: string
  },
): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: options.method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${options.token}`,
      'user-agent': options.userAgent,
      'x-github-api-version': '2022-11-28',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
  })
  if (!response.ok) {
    throw new GitHubHttpError(options.method, new URL(url).pathname, response.status)
  }
  return response.json()
}

const installationPath = (scope: GitHubScope): string =>
  scope.repo
    ? `/repos/${scope.owner}/${scope.repo}/installation`
    : `/orgs/${scope.owner}/installation`

const narrowedTo = (scope: GitHubScope) =>
  scope.repo
    ? { repositories: [scope.repo], permissions: { administration: 'read' } }
    : { permissions: { organization_self_hosted_runners: 'read' } }

export function createGitHubAppClient(options: {
  /** undefined when the App has not been configured yet: GitHub is then skipped. */
  loadCredentials: (signal: AbortSignal) => Promise<AppCredentials | undefined>
  fetch: Fetch
  userAgent: string
  now: () => number
}): GitHubAppClient & { credentials(signal: AbortSignal): Promise<AppCredentials | undefined> } {
  let credentials: { value: AppCredentials | undefined; readAt: number } | undefined
  const installations = new Map<string, number>()
  const tokens = new Map<string, { token: string; expiresAt: number }>()

  const currentCredentials = async (signal: AbortSignal) => {
    const now = options.now()
    if (credentials && now - credentials.readAt < CREDENTIALS_TTL_MS) return credentials.value
    const value = await options.loadCredentials(signal)
    // A rotated key or a different App invalidates everything minted with the old one.
    if (
      value?.appId !== credentials?.value?.appId ||
      value?.privateKey !== credentials?.value?.privateKey
    ) {
      installations.clear()
      tokens.clear()
    }
    // An App not filled in yet is not cached, so it is picked up as soon as it is.
    credentials = value ? { value, readAt: now } : undefined
    return value
  }

  const tokenFor = async (scope: GitHubScope, signal: AbortSignal): Promise<string> => {
    const key = scopeKey(scope)
    const cached = tokens.get(key)
    if (cached && options.now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.token
    const app = await currentCredentials(signal)
    if (!app) throw new Error('GitHub App credentials are not configured')
    const jwt = mintJwt(app, options.now())
    const common = { token: jwt, signal, userAgent: options.userAgent }
    let installationId = installations.get(key)
    if (installationId === undefined) {
      const installation = (await request(
        options.fetch,
        `${scope.apiUrl}${installationPath(scope)}`,
        {
          method: 'GET',
          ...common,
        },
      )) as { id: number }
      installationId = installation.id
      installations.set(key, installationId)
    }
    const minted = (await request(
      options.fetch,
      `${scope.apiUrl}/app/installations/${installationId}/access_tokens`,
      { method: 'POST', body: narrowedTo(scope), ...common },
    )) as { token: string; expires_at: string }
    tokens.set(key, { token: minted.token, expiresAt: Date.parse(minted.expires_at) })
    return minted.token
  }

  return {
    credentials: currentCredentials,
    async get(scope, path, signal) {
      const call = async () =>
        request(options.fetch, `${scope.apiUrl}${path}`, {
          method: 'GET',
          token: await tokenFor(scope, signal),
          signal,
          userAgent: options.userAgent,
        })
      try {
        return await call()
      } catch (err) {
        if (!(err instanceof GitHubHttpError) || err.status !== 401) throw err
        // A token revoked, or a key rotated early: mint once more before giving up.
        tokens.delete(scopeKey(scope))
        return call()
      }
    },
  }
}
