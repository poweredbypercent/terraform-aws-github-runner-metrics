/**
 * GitHub's answers, checked where they come in rather than cast: a malformed one fails its scope
 * with a named error instead of turning into a wrong count or a token minted on every call. The
 * errors never quote the answer, which can hold a token.
 */

export class GitHubResponseError extends Error {
  override readonly name = 'GitHubResponseError'
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** GET /orgs/{org}/installation or /repos/{owner}/{repo}/installation. */
export function parseInstallationId(body: unknown): number {
  if (
    isObject(body) &&
    typeof body.id === 'number' &&
    Number.isSafeInteger(body.id) &&
    body.id > 0
  ) {
    return body.id
  }
  throw new GitHubResponseError('GitHub installation: the answer has no installation id')
}

export interface InstallationToken {
  readonly token: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

/** POST /app/installations/{id}/access_tokens. */
export function parseInstallationToken(body: unknown): InstallationToken {
  if (isObject(body) && typeof body.token === 'string' && body.token !== '') {
    const expiresAt = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
    if (Number.isFinite(expiresAt)) return { token: body.token, expiresAt }
  }
  throw new GitHubResponseError('GitHub access token: the answer has no token and expiry')
}

export interface ListedRunner {
  readonly name: string
  readonly online: boolean
  readonly busy: boolean
}

/** One page of GET .../actions/runners. */
export function parseRunnersPage(body: unknown): ListedRunner[] {
  if (!isObject(body) || !Array.isArray(body.runners)) {
    throw new GitHubResponseError('GitHub runners: the answer has no runners list')
  }
  return body.runners.map(runner => {
    if (!isObject(runner) || typeof runner.name !== 'string' || typeof runner.status !== 'string') {
      throw new GitHubResponseError('GitHub runners: a runner has no name or status')
    }
    return { name: runner.name, online: runner.status === 'online', busy: runner.busy === true }
  })
}
