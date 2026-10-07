import type { GitHubScope } from './types.ts'

/**
 * The runner module tags every instance with where its runner registers: ghr:Type is "Org" or
 * "Repo", and ghr:Owner is the organisation, or "owner/repo" for repository-level runners. Reading
 * the scope from the instances means nothing about the organisation has to be configured.
 *
 * Those tags are untrusted input - a workflow job can often tag its own instance - so only values
 * shaped like GitHub names are accepted, and every path segment is encoded where it is used.
 */

const ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPOSITORY = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/

export function scopeFromTags(
  type: string | undefined,
  owner: string | undefined,
  apiUrl: string,
): GitHubScope | undefined {
  if (!owner) return undefined
  if (type === 'Org') return ACCOUNT.test(owner) ? { type: 'org', owner, apiUrl } : undefined
  if (type === 'Repo') {
    const [account = '', repo = '', ...rest] = owner.split('/')
    if (rest.length > 0 || !ACCOUNT.test(account) || !REPOSITORY.test(repo)) return undefined
    return { type: 'repo', owner: account, repo, apiUrl }
  }
  return undefined
}

/** "org" or "owner/repo", as configured in an owners allowlist. */
export const scopeOwnerName = (scope: GitHubScope): string =>
  scope.repo ? `${scope.owner}/${scope.repo}` : scope.owner

/** A stable key for caches and failure sets: one per API host and registration target. */
export const scopeKey = (scope: GitHubScope): string =>
  `${scope.apiUrl}|${scope.type}|${scopeOwnerName(scope)}`

/** The REST path of the scope's runners and App installation: /orgs/o or /repos/o/r, encoded. */
export const scopeApiPath = (scope: GitHubScope): string =>
  scope.repo
    ? `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`
    : `/orgs/${encodeURIComponent(scope.owner)}`

/** `al2023i-0af1c3dbf2fbbe681` -> `i-0af1c3dbf2fbbe681`: runners are named `<prefix><instance id>`. */
export const instanceIdOfRunnerName = (name: string): string | undefined =>
  name.match(/(i-[0-9a-f]{8,17})$/)?.[1]
