import { varint } from './varint.ts'

/**
 * Snappy block format with every byte emitted as a literal: a valid block that any decoder reads
 * back unchanged. Remote write requires snappy framing of the body, not compression ratio; a
 * sample is a few kilobytes, so compressing it buys nothing worth a dependency.
 *
 * Layout: the uncompressed length as a varint, then literal chunks of up to 65536 bytes, each
 * with tag byte 61<<2 (literal, length-1 in the next two bytes, little-endian).
 */
const MAX_LITERAL = 65536

export function snappyLiterals(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [varint(data.length)]
  for (let offset = 0; offset < data.length; offset += MAX_LITERAL) {
    const chunk = data.subarray(offset, offset + MAX_LITERAL)
    const header = Buffer.alloc(3)
    header[0] = 61 << 2
    header.writeUInt16LE(chunk.length - 1, 1)
    parts.push(header, chunk)
  }
  return Buffer.concat(parts)
}
