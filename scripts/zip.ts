import { crc32, deflateRawSync } from 'node:zlib'

/**
 * A minimal, deterministic zip writer: the same files always give the same bytes. Entries are
 * sorted, timestamps are fixed at the zip epoch (1980-01-01), permissions are 0644, and there are
 * no extra fields - which is what lets CI build twice and compare, and lets anyone rebuild a
 * release and check it against the published checksum.
 */

const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1
const DOS_TIME_MIDNIGHT = 0
const UNIX_0644_REGULAR_FILE = (0o100644 << 16) >>> 0

export function deterministicZip(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1))
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const [name, data] of entries) {
    const compressed = deflateRawSync(data, { level: 9 })
    const nameBytes = Buffer.from(name, 'utf8')
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt16LE(DOS_TIME_MIDNIGHT, 10)
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // no extra field
    locals.push(local, nameBytes, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // central directory signature
    central.writeUInt16LE((3 << 8) | 20, 4) // made by: Unix, 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(DOS_TIME_MIDNIGHT, 12)
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // extra length, comment length, disk number, internal attributes: all zero (30-37)
    central.writeUInt32LE(UNIX_0644_REGULAR_FILE, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBytes)

    offset += local.length + nameBytes.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory signature
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
