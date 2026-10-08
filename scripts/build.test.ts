import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { bundle, zip } from './build.ts'
import { deterministicZip } from './zip.ts'

// An independent reader checks the archive; CI runners have unzip, minimal images may not.
const hasUnzip = (() => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

describe('deterministicZip', () => {
  it('is byte-for-byte stable and readable by unzip', {
    skip: !hasUnzip && 'unzip is not installed',
  }, () => {
    const files = new Map([
      ['b.txt', Buffer.from('second')],
      ['a.txt', Buffer.from('first '.repeat(1000))],
    ])
    const first = deterministicZip(files)
    assert.deepEqual(first, deterministicZip(new Map([...files].reverse())))
    const dir = mkdtempSync(join(tmpdir(), 'zip-'))
    try {
      const file = join(dir, 'test.zip')
      writeFileSync(file, first)
      assert.equal(execFileSync('unzip', ['-p', file, 'a.txt']).toString(), 'first '.repeat(1000))
      assert.match(execFileSync('unzip', ['-Z1', file]).toString(), /^a\.txt\nb\.txt\n$/)
    } finally {
      rmSync(dir, { recursive: true })
    }
  })
})

describe('the release bundle', () => {
  it('builds reproducibly, and the bundle loads and refuses a missing config', async () => {
    await bundle()
    const first = zip().sha256
    await bundle()
    assert.equal(zip().sha256, first, 'two builds of the same source differ')

    const bundled = new URL('../dist/lambda/index.mjs', import.meta.url)
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )
    assert.ok(
      readFileSync(bundled, 'utf8').includes(JSON.stringify(version)),
      'the package version is stamped into the bundle',
    )
    const { handler } = (await import(bundled.href)) as { handler: () => Promise<unknown> }
    const saved = process.env.CONFIG
    delete process.env.CONFIG
    try {
      await assert.rejects(handler(), /CONFIG must be set/)
    } finally {
      if (saved !== undefined) process.env.CONFIG = saved
    }
  })
})
