import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cached } from './cache.ts'
import { signal } from './test/fixtures.ts'

describe('cached', () => {
  const counter = (values: (string | undefined)[]) => {
    let loads = 0
    return {
      load: async () => {
        loads++
        return values.shift()
      },
      loads: () => loads,
    }
  }

  it('keeps a value for its lifetime, then loads again', async () => {
    let now = 0
    const source = counter(['a', 'b'])
    const value = cached(source.load, 1000, () => now)
    assert.equal(await value.get(signal), 'a')
    now = 999
    assert.equal(await value.get(signal), 'a')
    now = 1000
    assert.equal(await value.get(signal), 'b')
    assert.equal(source.loads(), 2)
  })

  it('never keeps "not configured yet"', async () => {
    const source = counter([undefined, 'filled'])
    const value = cached(source.load, 60_000, () => 0)
    assert.equal(await value.get(signal), undefined)
    assert.equal(await value.get(signal), 'filled')
  })

  it('forgets on invalidate', async () => {
    const source = counter(['old', 'new'])
    const value = cached(source.load, 60_000, () => 0)
    assert.equal(await value.get(signal), 'old')
    value.invalidate()
    assert.equal(await value.get(signal), 'new')
  })
})
