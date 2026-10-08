import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { BUILT_IN_LABELS } from '../domain/labels.ts'
import { ALL_METRICS, PREFIX, renderMetricDocs, seriesKey } from './catalogue.ts'

describe('catalogue', () => {
  it('names every metric with the prefix and base units, and none with a reserved name', () => {
    for (const metric of ALL_METRICS) {
      assert.ok(metric.name.startsWith(PREFIX), metric.name)
      assert.match(metric.name, /^[a-z_]+$/)
      assert.ok(!metric.name.endsWith('_total'), `${metric.name}: gauges do not end in _total`)
      assert.notEqual(metric.name, `${PREFIX}up`, `"up" is Prometheus' own scrape health`)
    }
    assert.equal(new Set(ALL_METRICS.map(m => m.name)).size, ALL_METRICS.length)
  })

  it('keys a series the same whatever its label order', () => {
    assert.equal(
      seriesKey({ name: 'm', labels: { b: '2', a: '1' } }),
      seriesKey({ name: 'm', labels: { a: '1', b: '2' } }),
    )
  })

  it('reserves exactly the labels the metrics set (the module the same: parity.test.ts)', () => {
    const used = [...new Set(ALL_METRICS.flatMap(m => m.labels))].sort()
    assert.deepEqual([...BUILT_IN_LABELS].sort(), used)
  })

  it('keeps docs/metrics.md in step with the catalogue', () => {
    const docs = readFileSync(new URL('../../docs/metrics.md', import.meta.url), 'utf8')
    assert.equal(docs, renderMetricDocs(), 'run npm run docs:metrics and commit the result')
  })

  it('names only metrics that exist, in the hand-written docs and queries', () => {
    const known = new Set(ALL_METRICS.map(m => m.name))
    for (const file of ['README.md', 'docs/alternatives.md', 'CONTRIBUTING.md']) {
      const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
      for (const [name] of text.matchAll(new RegExp(`${PREFIX}[a-z_]+`, 'g'))) {
        assert.ok(known.has(name), `${file} names ${name}, which the catalogue does not define`)
      }
    }
  })
})
