/** Writes docs/metrics.md from the metric catalogue: npm run docs:metrics */
import { writeFileSync } from 'node:fs'
import { renderMetricDocs } from '../src/model/catalogue.ts'

writeFileSync(new URL('../docs/metrics.md', import.meta.url), renderMetricDocs())
