import { describeError, err, ok, type Result } from './result.ts'
import type { PartialResult } from './types.ts'

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
 * Reads each item on its own, so one that fails (a queue, a GitHub scope) fails alone. `read`
 * returns undefined for an item that turned out not to exist, which is neither a value nor a
 * failure. When every item failed, the source as a whole has failed.
 */
export async function readEach<K, V>(
  items: readonly K[],
  keyOf: (item: K) => string,
  read: (item: K) => Promise<V | undefined>,
): Promise<PartialResult<V>> {
  const values = new Map<string, V>()
  const failed: string[] = []
  await Promise.all(
    items.map(async item => {
      try {
        const value = await read(item)
        if (value !== undefined) values.set(keyOf(item), value)
      } catch {
        failed.push(keyOf(item))
      }
    }),
  )
  if (failed.length > 0 && values.size === 0) {
    throw new Error(`none of ${failed.length} could be read`)
  }
  return { values, failed }
}
