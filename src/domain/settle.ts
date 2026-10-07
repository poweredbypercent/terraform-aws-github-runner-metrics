import { describeError, err, ok, type Result } from './result.ts'
import type { ItemFailure, PartialResult } from './types.ts'

/**
 * Running a source so that its failure, or its slowness, stays its own.
 *
 * Every source gets an AbortSignal that fires at its deadline and is passed down to the SDK call
 * or fetch, so a timed-out call is cancelled rather than left running; the race is a backstop for
 * anything that ignores the signal.
 */

export async function settle<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Result<T>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return ok(await Promise.race([run(controller.signal), deadline]))
  } catch (error) {
    return err(describeError(error))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Waits for `work`, but no longer than `signal` allows: for calls that take no signal of their own
 * (a credential provider), so they cannot outrun the budget they are part of.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** At most this many distinct reasons are named when every item failed. */
const REASONS_NAMED = 3

/**
 * Reads each item on its own, so one that fails (a queue, a GitHub scope) fails alone, keeping why.
 * `read` returns undefined for an item that turned out not to exist, which is neither a value nor
 * a failure. When every item failed, the source as a whole has failed, and says why.
 */
export async function readEach<K, V>(
  items: readonly K[],
  keyOf: (item: K) => string,
  read: (item: K) => Promise<V | undefined>,
): Promise<PartialResult<V>> {
  const values = new Map<string, V>()
  const failed: ItemFailure[] = []
  await Promise.all(
    items.map(async item => {
      try {
        const value = await read(item)
        if (value !== undefined) values.set(keyOf(item), value)
      } catch (error) {
        failed.push({ key: keyOf(item), error: describeError(error) })
      }
    }),
  )
  if (failed.length > 0 && values.size === 0) {
    const reasons = [...new Set(failed.map(f => f.error))].slice(0, REASONS_NAMED)
    throw new Error(`none of ${failed.length} could be read: ${reasons.join('; ')}`)
  }
  return { values, failed }
}
