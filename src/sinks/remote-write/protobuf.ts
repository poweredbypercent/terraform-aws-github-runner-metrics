import type { Sample } from '../../model/catalogue.ts'
import { varint } from './varint.ts'

/**
 * Prometheus remote_write 1.0 request body (prometheus.WriteRequest), hand-encoded: four message
 * types and three wire types are all it takes, and a protobuf library would be most of the bundle.
 *
 *   WriteRequest { repeated TimeSeries timeseries = 1 }
 *   TimeSeries   { repeated Label labels = 1; repeated Sample samples = 2 }
 *   Label        { string name = 1; string value = 2 }
 *   Sample       { double value = 1; int64 timestamp = 2 }
 *
 * The spec requires labels sorted by name with __name__ among them, and no empty values: an empty
 * value means "no such label", so those are dropped here rather than sent.
 */

const concat = (parts: readonly Uint8Array[]): Uint8Array => Buffer.concat(parts)
const utf8 = (s: string): Uint8Array => Buffer.from(s, 'utf8')

const lengthDelimited = (field: number, payload: Uint8Array): Uint8Array =>
  concat([varint((field << 3) | 2), varint(payload.length), payload])

function double(field: number, value: number): Uint8Array {
  const b = Buffer.alloc(8)
  b.writeDoubleLE(value)
  return concat([varint((field << 3) | 1), b])
}

const int64 = (field: number, value: number): Uint8Array =>
  concat([varint(field << 3), varint(value)])

const label = (name: string, value: string): Uint8Array =>
  lengthDelimited(1, concat([lengthDelimited(1, utf8(name)), lengthDelimited(2, utf8(value))]))

export function encodeWriteRequest(samples: readonly Sample[]): Uint8Array {
  return concat(
    samples.map(s => {
      const encoded = Object.entries({ ...s.labels, __name__: s.name })
        .filter(([, value]) => value !== '')
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([name, value]) => label(name, value))
      const point = lengthDelimited(2, concat([double(1, s.value), int64(2, s.timestamp)]))
      return lengthDelimited(1, concat([...encoded, point]))
    }),
  )
}
