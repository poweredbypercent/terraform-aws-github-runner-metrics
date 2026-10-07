import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

/**
 * ci-ok is the one check branch protection requires, so a job missing from its `needs` would not
 * block a merge when it fails. GitHub has no "every other job" form for `needs`; this keeps the
 * hand-written list complete.
 */
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

const jobsSection = ci.slice(ci.indexOf('\njobs:\n'))
/** Job ids: the keys indented two spaces under `jobs:`. */
const jobIds = [...jobsSection.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map(m => m[1] ?? '')

describe('ci.yml', () => {
  it('requires every job in ci-ok', () => {
    assert.ok(jobIds.includes('ci-ok'), 'ci-ok job not found')
    const ciOk = jobsSection.slice(jobsSection.indexOf('\n  ci-ok:\n'))
    const needs = ciOk.match(/needs: \[([^\]]*)\]/)?.[1]
    assert.ok(needs, 'ci-ok has no needs list')
    assert.deepEqual(
      needs
        .split(',')
        .map(s => s.trim())
        .sort(),
      jobIds.filter(id => id !== 'ci-ok').sort(),
    )
  })
})
