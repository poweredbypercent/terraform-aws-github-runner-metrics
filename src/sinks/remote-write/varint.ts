/**
 * An unsigned LEB128 varint, as protobuf and the snappy preamble both write lengths. BigInt so a
 * millisecond timestamp (beyond 2^32) encodes exactly.
 */
export function varint(n: number): Uint8Array {
  const bytes: number[] = []
  let v = BigInt(n)
  while (v >= 0x80n) {
    bytes.push(Number((v & 0x7fn) | 0x80n))
    v >>= 7n
  }
  bytes.push(Number(v))
  return Uint8Array.from(bytes)
}
