/**
 * A value or the reason there is none, for code paths whose failure is an expected outcome rather
 * than an exception: a source that did not answer, an ARN that does not parse. Narrow on `ok`.
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const err = <E = string>(error: E): Result<never, E> => ({ ok: false, error })

/** The message only: errors can carry request details, and none of those belong in a log. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
