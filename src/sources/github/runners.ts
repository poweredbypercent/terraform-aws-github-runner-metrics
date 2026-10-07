import { scopeKey, scopeOwnerName } from '../../domain/scope.ts'
import type { GitHubScope, PartialResult, RegisteredRunner } from '../../domain/types.ts'
import type { GitHubAppClient } from './client.ts'

/**
 * The registered runners of every scope the stack's instances register in. Each scope is read on
 * its own: an organisation the App is not installed on fails alone, and the model leaves booting
 * out only for the runner configs that register there.
 */
export async function readRegisteredRunners(
  client: GitHubAppClient,
  scopes: readonly GitHubScope[],
  owners: readonly string[],
  signal: AbortSignal,
): Promise<PartialResult<string, readonly RegisteredRunner[]>> {
  const unique = new Map(scopes.map(s => [scopeKey(s), s]))
  const wanted = [...unique.values()].filter(
    s => owners.length === 0 || owners.includes(scopeOwnerName(s)),
  )
  const values = new Map<string, readonly RegisteredRunner[]>()
  const failed: string[] = []
  await Promise.all(
    wanted.map(async scope => {
      try {
        values.set(scopeKey(scope), await listRunners(client, scope, signal))
      } catch {
        failed.push(scopeKey(scope))
      }
    }),
  )
  if (failed.length > 0 && values.size === 0) {
    throw new Error(`no GitHub scope could be read (${failed.length})`)
  }
  return { values, failed }
}

async function listRunners(
  client: GitHubAppClient,
  scope: GitHubScope,
  signal: AbortSignal,
): Promise<RegisteredRunner[]> {
  const base = scope.repo
    ? `/repos/${scope.owner}/${scope.repo}/actions/runners`
    : `/orgs/${scope.owner}/actions/runners`
  const runners: RegisteredRunner[] = []
  for (let page = 1; ; page++) {
    const body = (await client.get(scope, `${base}?per_page=100&page=${page}`, signal)) as {
      runners?: { name: string; status: string; busy: boolean }[]
    }
    const batch = body.runners ?? []
    for (const r of batch) {
      runners.push({
        name: r.name,
        status: r.status === 'online' ? 'online' : 'offline',
        busy: r.busy === true,
        scope,
      })
    }
    if (batch.length < 100) return runners
  }
}
