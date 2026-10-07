import type { SourceName } from '../domain/types.ts'
import { ALL_METRICS, type Sample, seriesKey } from './catalogue.ts'

/**
 * Series whose label values come and go (an instance type nobody runs any more, an owner with no
 * runners left) would otherwise linger at their last value for Prometheus' five-minute lookback.
 * For a few samples after one disappears, while its source is up, it is sent as 0; then it is
 * forgotten. Zeros rather than stale markers because every remote-write receiver accepts them.
 *
 * The memory lives in the warm Lambda container (reserved concurrency 1 keeps it to one); a cold
 * start forgets it, and the worst case is one series lingering for five minutes.
 */
export interface VanishTracker {
  apply(
    samples: readonly Sample[],
    up: { readonly [S in SourceName]?: boolean },
    now: number,
  ): Sample[]
}

const sourceOf = new Map(
  ALL_METRICS.filter(m => m.vanishes).map(m => [m.name, m.source as SourceName]),
)

export function createVanishTracker(samplesToZero = 5): VanishTracker {
  const remembered = new Map<string, { sample: Sample; remaining: number }>()
  return {
    apply(samples, up, now) {
      const present = new Set<string>()
      for (const s of samples) {
        if (!sourceOf.has(s.name)) continue
        const key = seriesKey(s)
        present.add(key)
        remembered.set(key, { sample: s, remaining: samplesToZero })
      }
      const zeros: Sample[] = []
      for (const [key, entry] of remembered) {
        if (present.has(key)) continue
        // A failed source says nothing about whether the series went away: keep remembering it.
        if (up[sourceOf.get(entry.sample.name) as SourceName] !== true) continue
        zeros.push({ ...entry.sample, value: 0, timestamp: now })
        entry.remaining--
        if (entry.remaining <= 0) remembered.delete(key)
      }
      return [...samples, ...zeros]
    },
  }
}
