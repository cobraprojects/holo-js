import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createServer } from 'vite'
import { expect, it, onTestFinished } from 'vitest'
import { runtimeModuleInternals } from '../../core/src/runtimeModule'
import { bundleProjectModule } from '../src/project/runtime'

const execute = promisify(execFile)

const bundlers = [
  { name: 'CLI', bundle: bundleProjectModule, runtimeRoot: '.holo-js/runtime/cli' },
  { name: 'core', bundle: runtimeModuleInternals.bundleRuntimeModule, runtimeRoot: '.holo-js/runtime' },
]

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-bundle-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'node_modules/bundle-dependency'), { recursive: true })
  await writeFile(join(root, 'node_modules/bundle-dependency/package.json'), JSON.stringify({
    name: 'bundle-dependency', type: 'module', exports: './index.mjs',
  }))
  await writeFile(join(root, 'node_modules/bundle-dependency/index.mjs'), "export default 'external'\n")
  await mkdir(join(root, 'node_modules/legacy-dependency/client'), { recursive: true })
  await writeFile(join(root, 'node_modules/legacy-dependency/package.json'), JSON.stringify({ name: 'legacy-dependency' }))
  await writeFile(join(root, 'node_modules/legacy-dependency/headers.js'), "exports.headers = () => 'legacy headers'\n")
  await writeFile(join(root, 'node_modules/legacy-dependency/client/index.js'), "exports.client = 'legacy client'\n")
  await writeFile(join(root, 'src/value.ts'), "export default 'alias'\n")
  await writeFile(join(root, 'src/asset.txt'), 'source asset')
  return root
}

it.each(['default', 'application', 'nuxt'] as const)(
  'bundles with %s config without creating workspace tsconfigs and preserves aliases, external dependencies and source assets',
  async (layout) => {
    const root = await createProject()
    if (layout === 'application') {
      await writeFile(join(root, 'base.json'), JSON.stringify({ compilerOptions: { paths: { '@value': ['./src/value.ts'] } } }))
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json' }))
    } else if (layout === 'nuxt') {
      await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
        extends: './.nuxt/tsconfig.json',
        compilerOptions: { paths: { '@value': ['./src/value.ts'] } },
      }))
    }
    const alias = layout === 'default' ? '~/src/value' : '@value'
    const entry = join(root, 'src/entry.ts')
    await writeFile(entry, `
import { readFile } from 'node:fs/promises'
import dependency from 'bundle-dependency'
import value from '${alias}'
export const result = [value, dependency, await readFile(new URL('./asset.txt', import.meta.url), 'utf8')]
`)
    const originalConfig = layout === 'default' ? undefined : await readFile(join(root, 'tsconfig.json'), 'utf8')
    const bundled = await bundleProjectModule(root, entry)
    onTestFinished(() => bundled.cleanup())

    expect((await readdir(root, { recursive: true })).filter(path => path.endsWith('tsconfig.json')))
      .toEqual(layout === 'default' ? [] : ['tsconfig.json'])
    const loaded = await import(pathToFileURL(bundled.path).href) as { result: string[] }
    expect(loaded.result).toEqual(['alias', 'external', 'source asset'])
    if (originalConfig) expect(await readFile(join(root, 'tsconfig.json'), 'utf8')).toBe(originalConfig)

    await bundled.cleanup()
    await expect(readdir(dirname(dirname(bundled.path)))).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(bundlers)('$name loads deep imports into installed packages with and without exports maps', async ({ bundle }) => {
  const root = await createProject()
  await writeFile(join(root, 'node_modules/bundle-dependency/package.json'), JSON.stringify({
    name: 'bundle-dependency', type: 'module', exports: { '.': './index.mjs', './feature': './feature.mjs' },
  }))
  await writeFile(join(root, 'node_modules/bundle-dependency/feature.mjs'), "export const feature = 'exported feature'\n")
  await writeFile(join(root, 'src/service.ts'), `
import { headers } from 'legacy-dependency/headers'
import { client } from 'legacy-dependency/client'
import { feature } from 'bundle-dependency/feature'
export const result = [headers(), client, feature]
`)
  const entry = join(root, 'src/entry.ts')
  await writeFile(entry, "export { result } from './service'\n")
  const bundled = await bundle(root, entry)
  onTestFinished(() => bundled.cleanup())

  const { stdout } = await execute(process.execPath, [
    '--input-type=module',
    '--eval',
    'const { result } = await import(process.argv[1]); console.log(JSON.stringify(result))',
    pathToFileURL(bundled.path).href,
  ])
  expect(JSON.parse(stdout)).toEqual(['legacy headers', 'legacy client', 'exported feature'])
})

it.each(bundlers)('$name keeps TypeScript path aliases that look like package subpaths pointed at app files', async ({ bundle }) => {
  const root = await createProject()
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { paths: { 'legacy-dependency/headers': ['./src/headers.ts'] } },
  }))
  await writeFile(join(root, 'src/headers.ts'), "export const headers = () => 'app headers'\n")
  const entry = join(root, 'src/entry.ts')
  await writeFile(entry, "import { headers } from 'legacy-dependency/headers'\nexport const result = headers()\n")
  const bundled = await bundle(root, entry)
  onTestFinished(() => bundled.cleanup())

  const loaded = await import(pathToFileURL(bundled.path).href) as { result: string }
  expect(loaded.result).toBe('app headers')
})

it.each(bundlers)('$name cleans up the runtime bundle when application config resolution fails', async ({ bundle, runtimeRoot }) => {
  const root = await createProject()
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    extends: ['./.nuxt/tsconfig.json', './missing.json'],
  }))
  const entry = join(root, 'src/entry.ts')
  await writeFile(entry, 'export default 1\n')

  await expect(bundle(root, entry)).rejects.toThrow('missing.json')
  expect(await readdir(join(root, runtimeRoot))).toEqual([])
})

it.each(bundlers)('$name preserves the Vite module graph throughout bundle creation and cleanup', async ({ bundle }) => {
  const root = await createProject()
  const entry = join(root, 'src/entry.ts')
  await writeFile(entry, 'export default 1\n')
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  onTestFinished(() => server.close())
  const waitForFileEvent = (event: 'add' | 'change' | 'unlink', suffix: string): Promise<void> => new Promise((resolve) => {
    const listener = (path: string) => {
      if (!path.replaceAll('\\', '/').endsWith(suffix)) return
      server.watcher.off(event, listener)
      resolve()
    }
    server.watcher.on(event, listener)
    onTestFinished(() => { server.watcher.off(event, listener) })
  })

  await expect.poll(() => server.watcher.getWatched()[join(server.config.root, 'src')] ?? []).toContain('entry.ts')
  const sourceChanged = waitForFileEvent('change', '/src/entry.ts')
  await writeFile(entry, 'export default 2\n')
  await sourceChanged
  await server.transformRequest('/src/entry.ts')
  const module = await server.environments.client.moduleGraph.getModuleByUrl('/src/entry.ts')
  const transformed = module?.transformResult
  expect(transformed).toBeTruthy()

  const added = waitForFileEvent('add', '/entry.mjs')
  const bundled = await bundle(root, entry)
  onTestFinished(() => bundled.cleanup())
  await added
  expect(module?.transformResult).toBe(transformed)

  const removed = waitForFileEvent('unlink', '/entry.mjs')
  await bundled.cleanup()
  await removed
  expect(module?.transformResult).toBe(transformed)

  const configAdded = waitForFileEvent('add', '/tsconfig.json')
  await writeFile(join(root, 'tsconfig.json'), '{}\n')
  await configAdded
  expect(module?.transformResult).toBeNull()
})
