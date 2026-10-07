import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { scopeKey } from '../../domain/scope.ts'
import type { GitHubScope } from '../../domain/types.ts'
import type { Fetch } from '../../sinks/transport.ts'
import { createGitHubAppClient } from './client.ts'
import { credentialsFromRunnerModule, mintJwt, parseAppSecret } from './credentials.ts'
import { readRegisteredRunners } from './runners.ts'

const NOW = Date.parse('2026-10-07T12:00:00Z')
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const APP = { appId: '123', privateKey: PEM }
const ORG: GitHubScope = { type: 'org', owner: 'acme', apiUrl: 'https://api.github.com' }
const REPO: GitHubScope = {
  type: 'repo',
  owner: 'acme',
  repo: 'widgets',
  apiUrl: 'https://ghes.example/api/v3',
}

describe('credentials', () => {
  it('mints an RS256 App JWT, backdated for clock skew', () => {
    const [header, payload, signature] = mintJwt(APP, NOW).split('.')
    assert.deepEqual(JSON.parse(Buffer.from(header ?? '', 'base64url').toString()), {
      alg: 'RS256',
      typ: 'JWT',
    })
    const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString())
    assert.equal(claims.iss, '123')
    assert.equal(claims.iat, NOW / 1000 - 60)
    assert.ok(claims.exp - claims.iat <= 600, 'GitHub accepts at most ten minutes')
    assert.ok(
      createVerify('RSA-SHA256')
        .update(`${header}.${payload}`)
        .verify(publicKey, signature ?? '', 'base64url'),
    )
  })

  it('reads the dedicated App secret and the runner module parameters', () => {
    assert.deepEqual(parseAppSecret(JSON.stringify({ app_id: 123, private_key: PEM })), APP)
    assert.deepEqual(credentialsFromRunnerModule('123\n', Buffer.from(PEM).toString('base64')), APP)
    assert.throws(() => parseAppSecret('{"app_id":"x"}'), /must be JSON/)
    assert.throws(() => parseAppSecret('not json'), /must be JSON/)
    assert.throws(() => credentialsFromRunnerModule('123', 'bm9wZQ=='), /base64 PEM key/)
  })
})

/** A fake GitHub: installations, token minting and runner pages, recording every call. */
function fakeGitHub(
  pages: Record<string, { name: string; status: string; busy: boolean }[][]> = {},
) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  let rejectNextRunnersCall = false
  let tokens = 0
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url: `${url.origin}${url.pathname}`,
      body: init?.body && JSON.parse(String(init.body)),
    })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
    if (url.pathname.endsWith('/installation'))
      return json({ id: url.pathname.includes('/repos/') ? 2 : 1 })
    if (url.pathname.endsWith('/access_tokens')) {
      tokens++
      return json({ token: `t${tokens}`, expires_at: new Date(NOW + 3_600_000).toISOString() })
    }
    if (url.pathname.endsWith('/actions/runners')) {
      if (rejectNextRunnersCall) {
        rejectNextRunnersCall = false
        return json({}, 401)
      }
      const page = Number(url.searchParams.get('page'))
      return json({ runners: pages[url.pathname]?.[page - 1] ?? [] })
    }
    return json({}, 404)
  }
  return { calls, fetchImpl, rejectNext: () => (rejectNextRunnersCall = true) }
}

const client = (fetchImpl: Fetch, load = async () => APP as typeof APP | undefined) => {
  let now = NOW
  const c = createGitHubAppClient({
    loadCredentials: load,
    fetch: fetchImpl,
    userAgent: 'test',
    now: () => now,
  })
  return { c, advance: (ms: number) => (now += ms) }
}
const signal = new AbortController().signal

describe('GitHub App client', () => {
  it('finds the installation and mints a token narrowed to the scope', async () => {
    const gh = fakeGitHub()
    const { c } = client(gh.fetchImpl)
    await c.get(ORG, '/orgs/acme/actions/runners?per_page=100&page=1', signal)
    await c.get(REPO, '/repos/acme/widgets/actions/runners?per_page=100&page=1', signal)
    const minted = gh.calls.filter(call => call.url.endsWith('/access_tokens'))
    assert.deepEqual(
      minted.map(call => [call.url, call.body]),
      [
        [
          'https://api.github.com/app/installations/1/access_tokens',
          { permissions: { organization_self_hosted_runners: 'read' } },
        ],
        [
          'https://ghes.example/api/v3/app/installations/2/access_tokens',
          { repositories: ['widgets'], permissions: { administration: 'read' } },
        ],
      ],
    )
  })

  it('reuses a token until it nears expiry', async () => {
    const gh = fakeGitHub()
    const { c, advance } = client(gh.fetchImpl)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    advance(60_000)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    assert.equal(gh.calls.filter(call => call.url.endsWith('/access_tokens')).length, 1)
    advance(56 * 60_000)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    assert.equal(gh.calls.filter(call => call.url.endsWith('/access_tokens')).length, 2)
  })

  it('mints once more when GitHub rejects the cached token', async () => {
    const gh = fakeGitHub()
    const { c } = client(gh.fetchImpl)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    gh.rejectNext()
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    assert.equal(gh.calls.filter(call => call.url.endsWith('/access_tokens')).length, 2)
  })

  it('starts again with a rotated key at the next mint', async () => {
    const gh = fakeGitHub()
    let key = PEM
    const { c, advance } = client(gh.fetchImpl, async () => ({ appId: '123', privateKey: key }))
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    key = `${PEM}\n`
    // Tokens outlive a key rotation, so the cached one is used until it nears expiry...
    advance(11 * 60_000)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    assert.equal(gh.calls.filter(call => call.url.endsWith('/installation')).length, 1)
    // ...and the next mint, with the new key, looks the installation up afresh.
    advance(45 * 60_000)
    await c.get(ORG, '/orgs/acme/actions/runners', signal)
    assert.equal(gh.calls.filter(call => call.url.endsWith('/installation')).length, 2)
  })
})

describe('readRegisteredRunners', () => {
  it('pages through each scope and lets a failing scope fail alone', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      name: `r${i}`,
      status: 'online',
      busy: false,
    }))
    const gh = fakeGitHub({
      '/orgs/acme/actions/runners': [full, [{ name: 'last', status: 'offline', busy: false }]],
    })
    const { c } = client(gh.fetchImpl)
    const missing: GitHubScope = { type: 'org', owner: 'nope', apiUrl: 'https://api.github.com' }
    const failingClient = {
      get: (scope: GitHubScope, path: string, s: AbortSignal) =>
        scope.owner === 'nope' ? Promise.reject(new Error('404')) : c.get(scope, path, s),
    }
    const result = await readRegisteredRunners(failingClient, [ORG, ORG, missing], [], signal)
    assert.equal(result.values.get(scopeKey(ORG))?.length, 101)
    assert.equal(result.values.get(scopeKey(ORG))?.[100]?.status, 'offline')
    assert.deepEqual(result.failed, [scopeKey(missing)])
  })

  it('queries only the allowed owners when an allowlist is set', async () => {
    const gh = fakeGitHub()
    const { c } = client(gh.fetchImpl)
    const result = await readRegisteredRunners(c, [ORG, REPO], ['acme/widgets'], signal)
    assert.deepEqual([...result.values.keys()], [scopeKey(REPO)])
  })
})
