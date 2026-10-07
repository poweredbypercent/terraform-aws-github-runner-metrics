/**
 * Bundles the Lambda, and with --zip packages it the way releases ship it.
 *
 *   npm run build   dist/lambda/index.mjs (+ source map, bundled licences)
 *   npm run zip     ...and dist/terraform-aws-github-runner-metrics.zip + .sha256
 *
 * The bundle includes the AWS SDK rather than relying on the copy in the Lambda runtime, so a
 * release behaves the same whatever version AWS ships, and is not minified so it can be read. It
 * targets Node 22, the oldest runtime supported, and runs unchanged on newer ones. Output is
 * deterministic: building the same commit twice gives the same zip, byte for byte.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { deterministicZip } from './zip.ts'

const root = new URL('..', import.meta.url).pathname
const outdir = join(root, 'dist', 'lambda')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string
}
export const ZIP_NAME = 'terraform-aws-github-runner-metrics.zip'

/**
 * The licence of every package the bundle includes, as redistributing them requires (the AWS SDK
 * is Apache-2.0): name, version, licence and the licence text, from esbuild's list of inputs.
 */
function thirdPartyLicences(inputs: readonly string[]): string {
  const packages = new Map<string, string>()
  for (const input of inputs) {
    const match = input.match(/^(.*node_modules\/(@[^/]+\/[^/]+|[^@/][^/]*))\//)
    if (match?.[1] && match[2]) packages.set(match[2], join(root, match[1]))
  }
  const sections = [...packages.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, dir]) => {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        version: string
        license?: string
      }
      const file = readdirSync(dir).find(f => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f))
      const text = file
        ? readFileSync(join(dir, file), 'utf8').trim()
        : pkg.license === 'Apache-2.0'
          ? 'Licensed under the Apache License, Version 2.0: the full text is included above with the other Apache-2.0 packages.'
          : '(the package ships no licence file)'
      return `${name}@${pkg.version} (${pkg.license ?? 'unknown'})\n\n${text}\n`
    })
  return [
    'Third-party software bundled into index.mjs, with its licences.',
    '',
    ...sections.map(s => `${'-'.repeat(78)}\n${s}`),
  ].join('\n')
}

export async function bundle(): Promise<void> {
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  const result = await build({
    entryPoints: [join(root, 'src', 'handler.ts')],
    outfile: join(outdir, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Some bundled SDK internals still call require(); give ESM one.
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    define: { __VERSION__: JSON.stringify(version) },
    sourcemap: 'external',
    sourcesContent: false,
    legalComments: 'none',
    metafile: true,
    minify: false,
    keepNames: true,
    logLevel: 'warning',
  })
  writeFileSync(
    join(outdir, 'THIRD_PARTY_LICENSES.txt'),
    thirdPartyLicences(Object.keys(result.metafile.inputs)),
  )
}

export function zip(): { file: string; sha256: string } {
  const files = new Map(
    readdirSync(outdir).map(name => [name, readFileSync(join(outdir, name))] as const),
  )
  const archive = deterministicZip(files)
  const file = join(root, 'dist', ZIP_NAME)
  writeFileSync(file, archive)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  writeFileSync(`${file}.sha256`, `${sha256}  ${ZIP_NAME}\n`)
  return { file, sha256 }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await bundle()
  if (process.argv.includes('--zip')) {
    const { file, sha256 } = zip()
    console.log(`${file}\n${sha256}`)
  }
}
