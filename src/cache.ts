/**
 * A value loaded on demand and kept for a while, in the warm Lambda container. Undefined (not
 * configured yet) is never kept, so it is noticed as soon as it changes; `invalidate` forgets the
 * value early, for when using it has just failed (a revoked key, a rotated secret).
 */
export interface Cached<T> {
  get(signal: AbortSignal): Promise<T | undefined>
  invalidate(): void
}

export function cached<T>(
  load: (signal: AbortSignal) => Promise<T | undefined>,
  ttlMs: number,
  now: () => number,
): Cached<T> {
  let entry: { value: T; loadedAt: number } | undefined
  return {
    async get(signal) {
      if (entry && now() - entry.loadedAt < ttlMs) return entry.value
      const value = await load(signal)
      entry = value === undefined ? undefined : { value, loadedAt: now() }
      return value
    },
    invalidate() {
      entry = undefined
    },
  }
}
