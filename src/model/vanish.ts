import type { SourceName } from '../domain/types.ts'
import { ALL_METRICS, type Sample, seriesKey } from './catalogue.ts'

/**
 * Series whose label values come and go (an instance type nobody runs any more, an owner with no
 * runners left) would otherwise linger at their last value for Prometheus' five-minute lookback.
 * For a few samples after one disappears, while its source is up, it is sent as 0; then it is
 * forgotten. Zeros rather than stale markers because every remote-write receiver accepts them.
 *
 * `apply` only proposes: the tracker's memory changes when `commit` is called, after the push has
 * succeeded, so a failed push does not use up a vanished series' zeros. The memory lives in the
 * warm Lambda container (reserved concurrency 1 keeps it to one); a cold start forgets it, and the
 * worst case is one series lingering for five minutes.
 */
export interface VanishTracker {
  apply(
    samples: readonly Sample[],
    up: { readonly [S in SourceName]?: boolean },
    now: number,
  ): { readonly samples: Sample[]; commit(): void }
}

const vanishesWith = new Map(
  ALL_METRICS.flatMap(m => (m.vanishWith ? [[m.name, m.vanishWith] as const] : [])),
)

interface Remembered {
  readonly sample: Sample
  readonly remaining: number
}

export function createVanishTracker(samplesToZero = 5): VanishTracker {
  let remembered: ReadonlyMap<string, Remembered> = new Map()
  return {
    apply(samples, up, now) {
      const next = new Map<string, Remembered>()
      for (const s of samples) {
        if (vanishesWith.has(s.name))
          next.set(seriesKey(s), { sample: s, remaining: samplesToZero })
      }
      const zeros: Sample[] = []
      for (const [key, entry] of remembered) {
        if (next.has(key)) continue
        // A failed source says nothing about whether the series went away: keep remembering it.
        const source = vanishesWith.get(entry.sample.name)
        if (!source || up[source] !== true) {
          next.set(key, entry)
          continue
        }
        zeros.push({ ...entry.sample, value: 0, timestamp: now })
        if (entry.remaining > 1) next.set(key, { ...entry, remaining: entry.remaining - 1 })
      }
      return {
        samples: [...samples, ...zeros],
        commit: () => {
          remembered = next
        },
      }
    },
  }
}
