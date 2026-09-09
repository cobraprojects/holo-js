import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = new URL('../', import.meta.url).pathname
const require = createRequire(join(root, 'packages/cli/package.json'))
const { build } = require('esbuild')
const entries = [
  '@holo-js/adapter-shared/client',
  ...['next', 'nuxt', 'sveltekit'].flatMap(adapter => ['client', 'realtime'].map(entry => `@holo-js/adapter-${adapter}/${entry}`)),
]

export async function verifyBrowserExports(staging, consumer) {
  const packages = JSON.parse(await readFile(join(staging, 'workspace-packages.json'), 'utf8'))
  const directory = join(consumer, 'browser-exports')
  for (const [name, archive] of Object.entries(packages)) {
    const target = join(directory, 'node_modules', name)
    await mkdir(target, { recursive: true })
    const result = spawnSync('tar', ['-xzf', archive, '--strip-components=1', '-C', target], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  for (const entry of entries) {
    const result = await build({
      stdin: { contents: `export * from '${entry}'`, resolveDir: directory },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      minify: true,
      write: false,
      metafile: true,
      nodePaths: [join(root, 'node_modules'), join(root, 'node_modules/.bun/node_modules')],
      external: ['react', 'react/*', 'next/*', 'vue', 'svelte/*', '#app', '$app/*'],
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    const inputs = Object.keys(result.metafile.inputs)
    assert.ok(inputs.some(input => input.includes('/browser-exports/node_modules/@holo-js/')), entry)
    for (const input of inputs) {
      assert.doesNotMatch(input, /node_modules\/(?:typescript|tsup|esbuild|nitropack|@nuxt\/kit)\//, `${entry} includes ${input}`)
      if (input.includes('/@holo-js/')) assert.ok(input.includes('/browser-exports/node_modules/@holo-js/'), input)
    }
    console.log(`${entry}: ${result.outputFiles[0].contents.length} bytes; no build dependencies`)
  }
  const shared = join(directory, 'node_modules/@holo-js/adapter-shared')
  const manifest = JSON.parse(await readFile(join(shared, 'package.json'), 'utf8'))
  const buildEntry = await import(pathToFileURL(join(shared, manifest.exports['./build'].import)).href)
  const rootEntry = await import(pathToFileURL(join(shared, manifest.exports['.'].import)).href)
  const clientEntry = await import(pathToFileURL(join(shared, manifest.exports['./client'].import)).href)
  for (const [name, value] of Object.entries({ ...buildEntry, ...clientEntry })) assert.equal(rootEntry[name], value, name)
  const source = "import { query } from '@holo-js/realtime'; export const quote = query({ name: 'quote', handler: () => 'server-secret' })"
  const transformed = buildEntry.createRealtimeClientDefinitionTransform(source, '@holo-js/adapter-next/realtime')
  assert.match(transformed.code, /@holo-js\/adapter-next\/realtime/)
  assert.doesNotMatch(transformed.code, /server-secret/)
  assert.deepEqual(transformed.map.sourcesContent, [source])
  assert.match(buildEntry.createRealtimeClientDefinitionTransform(source, '@holo-js/adapter-next/realtime', { preserveServerHandlers: true }).code, /server-secret/)
  assert.throws(() => buildEntry.createRealtimeClientDefinitionTransform('export const =', 'client'), SyntaxError)
  assert.equal(clientEntry.normalizeHoloHttpError({ status: 403, message: 'Forbidden' }).status, 403)
  console.log('Packaged root compatibility and compiler transformations passed')
}
