import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { encodeWriteRequest } from './protobuf.ts'
import { snappyLiterals } from './snappy.ts'

// The decode side is proven against a real Prometheus in e2e/; these pin the wire details.
describe('encodeWriteRequest', () => {
  it('adds __name__, sorts labels by name and drops empty values', () => {
    const bytes = encodeWriteRequest([
      { name: 'm', labels: { zeta: 'z', alpha: 'a', repository: '' }, value: 2, timestamp: 1000 },
    ])
    const text = Buffer.from(bytes).toString('latin1')
    assert.equal(bytes[0], 0x0a, 'field 1 (timeseries), length-delimited')
    const order = ['__name__', 'alpha', 'zeta'].map(name => text.indexOf(name))
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'labels are sorted',
    )
    assert.equal(text.includes('repository'), false, 'empty label values are dropped')
  })

  it('encodes the sample value as a double and the timestamp as a varint', () => {
    const bytes = Buffer.from(
      encodeWriteRequest([{ name: 'm', labels: {}, value: 1.5, timestamp: 300 }]),
    )
    const sampleAt = bytes.lastIndexOf(0x12)
    // Sample { 0x09 <8-byte double> 0x10 <varint 300 = 0xac 0x02> }
    assert.equal(bytes[sampleAt + 2], 0x09)
    assert.equal(bytes.readDoubleLE(sampleAt + 3), 1.5)
    assert.deepEqual([...bytes.subarray(sampleAt + 11)], [0x10, 0xac, 0x02])
  })
})

describe('snappyLiterals', () => {
  it('frames data as a length preamble and 64KiB literal chunks', () => {
    const data = Buffer.alloc(70000, 7)
    const framed = Buffer.from(snappyLiterals(data))
    // varint(70000) = 0xf0 0xa2 0x04
    assert.deepEqual([...framed.subarray(0, 3)], [0xf0, 0xa2, 0x04])
    assert.equal(framed[3], 61 << 2)
    assert.equal(framed.readUInt16LE(4), 65535)
    assert.equal(framed.length, 3 + (3 + 65536) + (3 + (70000 - 65536)))
  })

  it('frames an empty body', () => {
    assert.deepEqual([...snappyLiterals(new Uint8Array())], [0])
  })
})
