import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { describeError, settle } from './result.ts'

describe('settle', () => {
  it('returns the value of a source that finishes in time', async () => {
    assert.deepEqual(await settle(1000, async () => 42), { ok: true, value: 42 })
  })

  it('turns a throw into a failed result carrying only the message', async () => {
    const result = await settle(1000, async () => {
      throw new Error('AccessDenied')
    })
    assert.deepEqual(result, { ok: false, error: 'AccessDenied' })
  })

  it('aborts a source that runs past its deadline', async () => {
    let aborted = false
    const result = await settle(20, signal => {
      signal.addEventListener('abort', () => {
        aborted = true
      })
      return new Promise(() => {})
    })
    assert.deepEqual(result, { ok: false, error: 'timed out after 20ms' })
    assert.equal(aborted, true)
  })

  it('describes non-Error throws', () => {
    assert.equal(describeError('plain'), 'plain')
  })
})
