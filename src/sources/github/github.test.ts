import assert from 'node:assert/strict'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'
import { cached } from '../../cache.ts'
import { scopeKey } from '../../domain/scope.ts'
import type { GitHubScope } from '../../domain/types.ts'
import type { Fetch } from '../../http.ts'
import { cachedForTest, NOW, ORG, signal } from '../../test/fixtures.ts'
import { createGitHubAppClient, type GitHubAppClient } from './client.ts'
import {
  type AppCredentials,
  credentialsFromRunnerModule,
  mintJwt,
  parseAppSecret,
} from './credentials.ts'
import { readRegisteredRunners } from './runners.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const APP: AppCredentials = { appId: '123', privateKey: PEM }
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

/**
 * A fake GitHub: installations, token minting and runner pages, recording every call. `refuse`
 * makes the next call to a path ending in the given suffix answer with a status instead.
 */
function fakeGitHub(
  pages: Record<string, { name: string; status: string; busy: boolean }[][]> = {},
) {
  const calls: { method: string; url: string; body?: unknown }[] = []
  const refusals: { suffix: string; status: number }[] = []
  let installationId = 1
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
    const refusal = refusals.findIndex(r => url.pathname.endsWith(r.suffix))
    if (refusal >= 0) return json({}, refusals.splice(refusal, 1)[0]?.status)
    if (url.pathname.endsWith('/installation')) {
      return json({ id: url.pathname.includes('/repos/') ? 100 + installationId : installationId })
    }
    if (url.pathname.endsWith('/access_tokens')) {
      tokens++
      return json({ token: `t${tokens}`, expires_at: new Date(NOW + 3_600_000).toISOString() })
    }
    if (url.pathname.endsWith('/actions/runners')) {
      const page = Number(url.searchParams.get('page'))
      return json({ runners: pages[url.pathname]?.[page - 1] ?? [] })
    }
    return json({}, 404)
  }
  const count = (suffix: string) => calls.filter(call => call.url.endsWith(suffix)).length
  return {
    calls,
    fetchImpl,
    count,
    refuse: (suffix: string, status: number) => void refusals.push({ suffix, status }),
    reinstall: () => void installationId++,
  }
}

/** A client over a fake GitHub, with a clock to move and credentials that count their loads. */
function harness(load: () => AppCredentials | undefined = () => APP) {
  let now = NOW
  let loads = 0
  const github = fakeGitHub()
  const credentials = cached(
    async () => {
      loads++
      return load()
    },
    10 * 60_000,
    () => now,
  )
  const client = createGitHubAppClient({
    credentials,
    fetch: github.fetchImpl,
    userAgent: 'test',
    now: () => now,
  })
  const advance = (ms: number) => {
    now += ms
  }
  return { client, github, advance, loads: () => loads }
}

const RUNNERS = '/orgs/acme/actions/runners'

describe('GitHub App client', () => {
  it('finds the installation and mints a token narrowed to the scope', async () => {
    const { client, github } = harness()
    await client.get(ORG, RUNNERS, signal)
    await client.get(REPO, '/repos/acme/widgets/actions/runners', signal)
    const minted = github.calls.filter(call => call.url.endsWith('/access_tokens'))
    assert.deepEqual(
      minted.map(call => [call.url, call.body]),
      [
        [
          'https://api.github.com/app/installations/1/access_tokens',
          { permissions: { organization_self_hosted_runners: 'read' } },
        ],
        [
          'https://ghes.example/api/v3/app/installations/101/access_tokens',
          { repositories: ['widgets'], permissions: { administration: 'read' } },
        ],
      ],
    )
  })

  it('reuses a token until it nears expiry', async () => {
    const { client, github, advance } = harness()
    await client.get(ORG, RUNNERS, signal)
    advance(60_000)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(github.count('/access_tokens'), 1)
    advance(56 * 60_000)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(github.count('/access_tokens'), 2)
  })

  it('mints once more when GitHub rejects the cached token', async () => {
    const { client, github } = harness()
    await client.get(ORG, RUNNERS, signal)
    github.refuse('/actions/runners', 401)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(github.count('/access_tokens'), 2)
  })

  it('starts again with a rotated key at the next mint', async () => {
    let key = PEM
    const { client, github, advance } = harness(() => ({ appId: '123', privateKey: key }))
    await client.get(ORG, RUNNERS, signal)
    key = `${PEM}\n`
    // Tokens outlive a key rotation, so the cached one is used until it nears expiry...
    advance(11 * 60_000)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(github.count('/installation'), 1)
    // ...and the next mint, with the new key, looks the installation up afresh.
    advance(45 * 60_000)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(github.count('/installation'), 2)
  })

  it('reads the credentials again as soon as GitHub refuses the App, and retries once', async () => {
    const { client, github, loads } = harness()
    github.refuse('/installation', 401)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(loads(), 2, 'not served from the ten-minute cache')
    github.refuse('/installation', 401)
    github.refuse('/installation', 401)
    await assert.rejects(client.get(REPO, '/repos/acme/widgets/actions/runners', signal), /401/)
  })

  it('looks the installation up again when the App was reinstalled', async () => {
    const { client, github, advance } = harness()
    await client.get(ORG, RUNNERS, signal)
    github.reinstall()
    github.refuse('/installations/1/access_tokens', 404)
    advance(56 * 60_000)
    await client.get(ORG, RUNNERS, signal)
    assert.equal(
      github.calls.at(-2)?.url,
      'https://api.github.com/app/installations/2/access_tokens',
    )
  })

  it('refuses to call GitHub without credentials', async () => {
    const { client, github } = harness(() => undefined)
    await assert.rejects(client.get(ORG, RUNNERS, signal), /not configured/)
    assert.equal(github.calls.length, 0)
  })
})

describe('readRegisteredRunners', () => {
  it('pages through each scope and lets a failing scope fail alone', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      name: `r${i}`,
      status: 'online',
      busy: false,
    }))
    const github = fakeGitHub({
      [RUNNERS]: [full, [{ name: 'last', status: 'offline', busy: false }]],
    })
    const client = createGitHubAppClient({
      credentials: cachedForTest(() => APP),
      fetch: github.fetchImpl,
      userAgent: 'test',
      now: () => NOW,
    })
    const missing: GitHubScope = { type: 'org', owner: 'nope', apiUrl: 'https://api.github.com' }
    github.refuse('/orgs/nope/installation', 404)
    const result = await readRegisteredRunners(
      client,
      [ORG, ORG, missing],
      ['acme', 'nope'],
      signal,
    )
    assert.equal(result.values.get(scopeKey(ORG))?.length, 101)
    assert.equal(result.values.get(scopeKey(ORG))?.[100]?.status, 'offline')
    assert.deepEqual(result.failed, [scopeKey(missing)])
  })

  it('queries only the allowed owners, whatever their case in the tags', async () => {
    const asked: GitHubScope[] = []
    const client: GitHubAppClient = {
      get: async scope => {
        asked.push(scope)
        return { runners: [] }
      },
    }
    const tagged: GitHubScope = { ...REPO, owner: 'Acme', repo: 'Widgets' }
    const result = await readRegisteredRunners(client, [ORG, tagged], ['acme/widgets'], signal)
    assert.deepEqual([...result.values.keys()], [scopeKey(tagged)])
    assert.deepEqual(asked, [tagged])
    assert.deepEqual((await readRegisteredRunners(client, [ORG], [], signal)).values.size, 0)
  })
})
