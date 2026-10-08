import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { instanceIdOfRunnerName, scopeFromTags, scopeKey, scopeOwnerName } from './scope.ts'

const API = 'https://api.github.com'

describe('scopeFromTags', () => {
  it('reads organisation-level runners', () => {
    assert.deepEqual(scopeFromTags('Org', 'acme', API), { type: 'org', owner: 'acme', apiUrl: API })
  })

  it('reads repository-level runners', () => {
    assert.deepEqual(scopeFromTags('Repo', 'acme/widgets.js', API), {
      type: 'repo',
      owner: 'acme',
      repo: 'widgets.js',
      apiUrl: API,
    })
  })

  it('reads a name in any case as the same scope', () => {
    assert.deepEqual(scopeFromTags('Org', 'ACME', API), scopeFromTags('Org', 'acme', API))
    assert.deepEqual(
      scopeFromTags('Repo', 'Acme/Widgets', API),
      scopeFromTags('Repo', 'acme/widgets', API),
    )
  })

  it('refuses tags it cannot interpret', () => {
    assert.equal(scopeFromTags(undefined, 'acme', API), undefined)
    assert.equal(scopeFromTags('Org', undefined, API), undefined)
    assert.equal(scopeFromTags('Repo', 'acme', API), undefined)
    assert.equal(scopeFromTags('Repo', 'acme/widgets/extra', API), undefined)
    assert.equal(scopeFromTags('Enterprise', 'acme', API), undefined)
  })

  it('refuses tag values that are not GitHub names: they are untrusted input', () => {
    for (const owner of [
      '../app/installations/1#',
      'acme?x=1',
      'acme/..',
      '-acme',
      'a'.repeat(40),
    ]) {
      assert.equal(scopeFromTags('Org', owner, API), undefined, owner)
      assert.equal(scopeFromTags('Repo', `${owner}/widgets`, API), undefined, owner)
    }
    assert.equal(scopeFromTags('Repo', 'acme/..', API), undefined)
    assert.equal(scopeFromTags('Repo', 'acme/.', API), undefined)
  })
})

describe('scope keys and names', () => {
  const repo = { type: 'repo', owner: 'acme', repo: 'widgets', apiUrl: API } as const

  it('keys a scope by API host, type and target', () => {
    assert.equal(scopeKey(repo), 'https://api.github.com|repo|acme/widgets')
    assert.equal(scopeOwnerName(repo), 'acme/widgets')
  })
})

describe('instanceIdOfRunnerName', () => {
  it('takes the instance id off the end of a runner name', () => {
    assert.equal(instanceIdOfRunnerName('al2023i-0af1c3dbf2fbbe681'), 'i-0af1c3dbf2fbbe681')
    assert.equal(instanceIdOfRunnerName('i-0af1c3dbf2fbbe681'), 'i-0af1c3dbf2fbbe681')
    assert.equal(instanceIdOfRunnerName('someone-laptop'), undefined)
  })
})
