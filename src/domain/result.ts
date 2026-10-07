/**
 * Running a source so that its failure, or its slowness, stays its own.
 *
 * Every source gets an AbortSignal that fires at its deadline and is passed down to the SDK call
 * or fetch, so a timed-out call is cancelled rather than left running; the race is a backstop for
 * anything that ignores the signal.
 */

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError'
}

/** The message only: errors can carry request details, and none of those belong in a log. */
export const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export async function settle<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<Result<T>> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError(`timed out after ${timeoutMs}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
  })
  try {
    return { ok: true, value: await Promise.race([run(controller.signal), deadline]) }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  } finally {
    clearTimeout(timer)
  }
}
