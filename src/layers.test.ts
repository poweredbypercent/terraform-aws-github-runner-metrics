import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The layers depend inwards only: the domain on nothing but itself, the model on the domain. Both
 * stay free of configuration, SDKs and I/O, so they are tested with plain values. Nothing else
 * would stop the next convenient import across the line.
 */
const src = dirname(fileURLToPath(import.meta.url))

/** What each layer may import: directories under src/, and nothing from outside src/. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  domain: ['domain'],
  model: ['domain', 'model'],
}

const importsOf = (file: string): string[] =>
  [
    ...readFileSync(file, 'utf8').matchAll(
      /^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]/gm,
    ),
  ].map(([, specifier = '']) => specifier)

describe('layers', () => {
  for (const [layer, allowed] of Object.entries(ALLOWED)) {
    it(`${layer} imports only from ${allowed.join(' and ')}`, () => {
      const files = readdirSync(join(src, layer)).filter(
        name => name.endsWith('.ts') && !name.endsWith('.test.ts'),
      )
      assert.ok(files.length > 0, `no files in src/${layer}`)
      for (const name of files) {
        for (const specifier of importsOf(join(src, layer, name))) {
          const target = specifier.startsWith('.')
            ? relative(src, join(src, layer, specifier)).split('/')[0]
            : specifier
          assert.ok(
            allowed.includes(target ?? ''),
            `src/${layer}/${name} imports ${specifier}: ${layer} may import only from ${allowed.join(', ')}`,
          )
        }
      }
    })
  }
})
