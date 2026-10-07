import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { abortsAfter } from '../test/fixtures.ts'
import { describeError } from './result.ts'
import { readEach, settle, untilAborted } from './settle.ts'

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

describe('untilAborted', () => {
  it('passes a result through, and stops waiting when the signal fires', async () => {
    assert.equal(await untilAborted(Promise.resolve(1), new AbortController().signal), 1)
    await assert.rejects(untilAborted(new Promise(() => {}), abortsAfter(10)), /aborted after 10ms/)
    const aborted = AbortSignal.abort(new Error('gone'))
    await assert.rejects(untilAborted(Promise.resolve(1), aborted), /gone/)
  })
})

describe('readEach', () => {
  const read = async (item: string) => {
    if (item === 'broken') throw new Error('AccessDenied')
    if (item === 'absent') return undefined
    return item.length
  }

  it('keeps what could be read, what failed and why, and skips what does not exist', async () => {
    const result = await readEach(['abc', 'broken', 'absent'], item => item, read)
    assert.deepEqual([...result.values], [['abc', 3]])
    assert.deepEqual(result.failed, [{ key: 'broken', error: 'AccessDenied' }])
  })

  it('fails as a whole when nothing could be read, naming the distinct reasons', async () => {
    await assert.rejects(
      readEach(
        ['a', 'b', 'c'],
        item => item,
        item => Promise.reject(new Error(item === 'c' ? 'Throttling' : 'AccessDenied')),
      ),
      /none of 3 could be read: AccessDenied; Throttling/,
    )
  })

  it('succeeds with nothing to read', async () => {
    assert.deepEqual(await readEach([], item => item, read), { values: new Map(), failed: [] })
  })
})
