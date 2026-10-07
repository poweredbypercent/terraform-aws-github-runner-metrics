import type { GitHubScope } from './types.ts'

/**
 * The runner module tags every instance with where its runner registers: ghr:Type is "Org" or
 * "Repo", and ghr:Owner is the organisation, or "owner/repo" for repository-level runners. Reading
 * the scope from the instances means nothing about the organisation has to be configured.
 */
export function scopeFromTags(
  type: string | undefined,
  owner: string | undefined,
  apiUrl: string,
): GitHubScope | undefined {
  if (!owner) return undefined
  if (type === 'Org') return { type: 'org', owner, apiUrl }
  if (type === 'Repo') {
    const [account, repo, ...rest] = owner.split('/')
    if (!account || !repo || rest.length > 0) return undefined
    return { type: 'repo', owner: account, repo, apiUrl }
  }
  return undefined
}

/** A stable key for caches and failure sets: one per API host and registration target. */
export const scopeKey = (scope: GitHubScope): string =>
  `${scope.apiUrl}|${scope.type}|${scope.owner}${scope.repo ? `/${scope.repo}` : ''}`

/** "org" or "owner/repo", as configured in an owners allowlist. */
export const scopeOwnerName = (scope: GitHubScope): string =>
  scope.repo ? `${scope.owner}/${scope.repo}` : scope.owner

/** `al2023i-0af1c3dbf2fbbe681` -> `i-0af1c3dbf2fbbe681`: runners are named `<prefix><instance id>`. */
export const instanceIdOfRunnerName = (name: string): string | undefined =>
  name.match(/(i-[0-9a-f]{8,17})$/)?.[1]
