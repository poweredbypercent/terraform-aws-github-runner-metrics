import type { GitHubScope } from '../../domain/types.ts'

/** The REST path of a scope's runners and App installation: /orgs/o or /repos/o/r, encoded. */
export const scopeApiPath = (scope: GitHubScope): string =>
  scope.repo
    ? `/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}`
    : `/orgs/${encodeURIComponent(scope.owner)}`
