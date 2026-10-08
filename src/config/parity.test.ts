import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BUILT_IN_LABELS, LABEL_NAME } from '../domain/labels.ts'
import { PATTERNS, RESERVED_HEADERS } from './patterns.ts'

/**
 * The Terraform module refuses what the Lambda would reject before it deploys, so its rules have
 * to be the Lambda's. They are written twice, in two languages; this keeps the copies the same.
 * Each of the Lambda's patterns must appear, character for character, in a regex() of the
 * module's, and the names both reserve must match. A copy loosened on one side fails here.
 */
const root = new URL('../../', import.meta.url)
const terraform = readdirSync(root)
  .filter(name => name.endsWith('.tf'))
  .map(name => readFileSync(new URL(name, root), 'utf8'))
  .join('\n')

/** The pattern of every regex("...") in the module, with HCL's string escapes undone. */
const modulePatterns = new Set(
  [...terraform.matchAll(/regex\("((?:[^"\\]|\\.)*)"/g)].map(([, quoted = '']) =>
    quoted.replace(/\\(.)/g, '$1'),
  ),
)

const moduleList = (pattern: RegExp, what: string): string[] => {
  const list = terraform.match(pattern)?.[1]
  assert.ok(list, `${what} not found in the Terraform module`)
  return JSON.parse(list) as string[]
}

describe('the Terraform module and the Lambda', () => {
  const patterns: [string, string][] = [
    ...Object.entries(PATTERNS),
    ['labelName', LABEL_NAME.source],
  ]
  for (const [name, source] of patterns) {
    it(`check a ${name} with the same pattern`, () => {
      assert.ok(
        modulePatterns.has(source),
        `no regex("${source}") in the module's .tf files: it would accept a ${name} the Lambda rejects`,
      )
    })
  }

  it('reserve the same headers', () => {
    assert.deepEqual(
      moduleList(/!contains\((\[[^\]]*\]), lower\(name\)\)/, 'The reserved headers (variables.tf)'),
      [...RESERVED_HEADERS],
    )
  })

  it('reserve the same built-in labels', () => {
    assert.deepEqual(
      moduleList(/built_in_labels\s*=\s*(\[[^\]]*\])/, 'local.built_in_labels (validation.tf)'),
      [...BUILT_IN_LABELS],
    )
  })
})
