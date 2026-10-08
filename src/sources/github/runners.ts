import { scopeKey, scopeOwnerName } from '../../domain/scope.ts'
import { readEach } from '../../domain/settle.ts'
import type { GitHubScope, RegisteredRunner } from '../../domain/types.ts'
import type { RegisteredRunners } from '../../ports.ts'
import type { GitHubAppClient } from './client.ts'
import { scopeApiPath } from './paths.ts'
import { parseRunnersPage } from './responses.ts'

const PER_PAGE = 100

/**
 * The registered runners of every allowed scope the stack's instances register in. The scopes
 * come from instance tags, which a job may be able to set, so only those in `owners` (lower-cased,
 * as GitHub names are case-insensitive) are queried. Each scope is read on its own: an
 * organisation the App is not installed on fails alone, and the model leaves booting out only
 * for the runner configs that register there.
 */
export async function readRegisteredRunners(
  client: GitHubAppClient,
  scopes: readonly GitHubScope[],
  owners: readonly string[],
  signal: AbortSignal,
): Promise<RegisteredRunners> {
  const unique = new Map(scopes.map(s => [scopeKey(s), s]))
  const wanted = [...unique.values()].filter(s => owners.includes(scopeOwnerName(s).toLowerCase()))
  return readEach(wanted, scopeKey, scope => listRunners(client, scope, signal))
}

async function listRunners(
  client: GitHubAppClient,
  scope: GitHubScope,
  signal: AbortSignal,
): Promise<RegisteredRunner[]> {
  const base = `${scopeApiPath(scope)}/actions/runners`
  const runners: RegisteredRunner[] = []
  for (let page = 1; ; page++) {
    const batch = parseRunnersPage(
      await client.get(scope, `${base}?per_page=${PER_PAGE}&page=${page}`, signal),
    )
    for (const r of batch) {
      runners.push({ name: r.name, status: r.online ? 'online' : 'offline', busy: r.busy, scope })
    }
    if (batch.length < PER_PAGE) return runners
  }
}
