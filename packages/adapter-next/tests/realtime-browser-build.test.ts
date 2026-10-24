import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHolo } from '../src/config'
import realtimeDefinitionLoader from '../src/realtime-definition-loader'
import { addSymlinkedRealtimeFile, browserBuildSecret, createSecretRealtimeProject, realtimeProjectLayouts, symlinkedFileError, useFactoryNamedExports } from '../../../tests/support/realtime-browser-build'

type WebpackStats = { hasErrors(): boolean, toString(options: string): string }
type Webpack = (config: object, callback: (error: Error | null, stats?: WebpackStats) => void) => void
type WebpackRule = { readonly use: ReadonlyArray<{ readonly loader: string, readonly options?: object }> }
type ConfigureWebpack = (config: object, context: { readonly isServer: boolean }) => { readonly module: { readonly rules: readonly WebpackRule[] } }

const loadWebpack = (): Webpack => {
  const require = createRequire(import.meta.url)
  const bundle = require('next/dist/compiled/webpack/bundle5') as () => { webpack: Webpack }
  return bundle().webpack
}

function createClientRealtimeRule(root: string, loaderPath: string): WebpackRule {
  const previousCwd = process.cwd()
  process.chdir(root)
  try {
    const configureWebpack = withHolo().webpack as unknown as ConfigureWebpack
    const rule = configureWebpack({}, { isServer: false }).module.rules.find(entry => entry.use[0]?.loader.includes('realtime-definition-loader'))
    if (!rule) throw new Error('withHolo() did not add the realtime definition rule')
    return { ...rule, use: rule.use.map(entry => ({ ...entry, loader: loaderPath })) }
  } finally {
    process.chdir(previousCwd)
  }
}

async function buildBrowserBundleWithWebpack(root: string, clientSource: string): Promise<string> {
  const loaderKey = Symbol.for('holo.test.realtimeDefinitionLoader')
  Reflect.set(globalThis, loaderKey, realtimeDefinitionLoader)
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/realtime': 'workspace:*' } }))
    await writeFile(join(root, 'loader.cjs'), [
      `module.exports = function (source) { return globalThis[Symbol.for('holo.test.realtimeDefinitionLoader')].call(this, source) }`,
      '',
    ].join('\n'))
    await writeFile(join(root, 'client.ts'), clientSource)
    const webpack = loadWebpack()
    const stats = await new Promise<WebpackStats>((resolve, reject) => webpack({
      mode: 'development',
      context: root,
      entry: './client.ts',
      devtool: 'source-map',
      output: { path: join(root, 'dist'), library: { type: 'module' } },
      experiments: { outputModule: true },
      externalsType: 'module',
      externals: { '@holo-js/adapter-next/realtime': '@holo-js/adapter-next/realtime' },
      resolve: { extensions: ['.ts', '.js'] },
      module: { rules: [createClientRealtimeRule(root, join(root, 'loader.cjs')), { test: /client\.ts$/, type: 'javascript/esm' }] },
    }, (error, result) => error || !result ? reject(error ?? new Error('webpack returned no stats')) : resolve(result)))
    expect(stats.hasErrors(), stats.toString('errors-only')).toBe(false)
    const files = await readdir(join(root, 'dist'))
    expect(files.some(file => file.endsWith('.map'))).toBe(true)
    return (await Promise.all(files.map(file => readFile(join(root, 'dist', file), 'utf8')))).join('\n')
  } finally {
    Reflect.deleteProperty(globalThis, loaderKey)
  }
}

describe('Next realtime browser build', () => {
  it.each(realtimeProjectLayouts)('keeps handler source out of the webpack browser bundle and its source maps with a %s project', async (layout) => {
    const { root, cleanup } = await createSecretRealtimeProject(layout)
    try {
      const bundle = await buildBrowserBundleWithWebpack(root, `export { posts } from './server/realtime/posts'\n`)
      expect(bundle).toContain('posts.list')
      expect(bundle).not.toContain(browserBuildSecret)
      expect(bundle).not.toContain('handler: async')
    } finally {
      await cleanup()
    }
  }, 60_000)

  it('builds exports named after the factories', async () => {
    const { root, cleanup } = await createSecretRealtimeProject()
    try {
      await useFactoryNamedExports(root)
      const bundle = await buildBrowserBundleWithWebpack(root, `export { query, mutation } from './server/realtime/posts'\n`)
      expect(bundle).toContain('posts.list')
      expect(bundle).toContain('posts.rename')
      expect(bundle).not.toContain(browserBuildSecret)
    } finally {
      await cleanup()
    }
  }, 60_000)

  it('applies the browser Turbopack rule to a symlinked realtime directory under the configured Turbopack root', async () => {
    const { root, cleanup } = await createSecretRealtimeProject('symlinked-realtime-directory')
    const previousCwd = process.cwd()
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/realtime': 'workspace:*' } }))
      process.chdir(root)
      const workspace = join(root, '..')
      const turbopack = (withHolo({ turbopack: { root: workspace } }) as { readonly turbopack?: { readonly rules?: Record<string, unknown> } }).turbopack
      const [browserRule] = turbopack?.rules?.['*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'] as Array<{ condition: { all: [unknown, { any: Array<{ path: RegExp }> }] } }>
      const patterns = browserRule?.condition.all[1].any.map(entry => entry.path) ?? []
      const realFile = join(await realpath(join(root, 'server/realtime')), 'posts.ts')
      const matches = (path: string) => patterns.some(pattern => pattern.test(path))

      expect(matches(realFile)).toBe(true)
      expect(matches(relative(workspace, realFile))).toBe(true)
      expect(matches(`.${sep}${relative(workspace, realFile)}`)).toBe(true)
      expect(matches(relative(workspace, join(root, 'server/models/Post.ts')))).toBe(false)
      expect(matches('posts.ts')).toBe(false)
    } finally {
      process.chdir(previousCwd)
      await cleanup()
    }
  })

  it('refuses a symlinked file inside server/realtime at config time and when a realtime module compiles', async () => {
    const { root, cleanup } = await createSecretRealtimeProject()
    const previousCwd = process.cwd()
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/realtime': 'workspace:*' } }))
      process.chdir(root)
      const configureWebpack = withHolo().webpack as unknown as ConfigureWebpack
      const watchRunCallbacks: Array<() => void> = []
      const hook = { tap: (_name: string, callback: () => void) => watchRunCallbacks.push(callback) }
      const { plugins } = configureWebpack({}, { isServer: false }) as unknown as { readonly plugins: ReadonlyArray<{ apply(compiler: object): void }> }
      for (const plugin of plugins) plugin.apply({ hooks: { beforeRun: hook, watchRun: hook } })
      expect(watchRunCallbacks).toHaveLength(2)
      await addSymlinkedRealtimeFile(root)

      for (const callback of watchRunCallbacks) expect(callback).toThrow(symlinkedFileError)

      expect(() => withHolo()).toThrow(symlinkedFileError)
      expect(() => configureWebpack({}, { isServer: false })).toThrow(symlinkedFileError)
      expect(() => realtimeDefinitionLoader.call({ resourcePath: join(root, 'server/realtime/posts.ts') }, `export const posts = query({ name: 'posts.list' })`)).toThrow(symlinkedFileError)
    } finally {
      process.chdir(previousCwd)
      await cleanup()
    }
  })

  it('matches a symlinked realtime folder only at its path under the Turbopack root', async () => {
    const { root, cleanup } = await createSecretRealtimeProject()
    const previousCwd = process.cwd()
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/realtime': 'workspace:*' } }))
      await writeFile(join(root, 'package-lock.json'), '{}')
      await mkdir(join(root, 'shared'), { recursive: true })
      await rm(join(root, 'server/realtime'), { recursive: true })
      await mkdir(join(root, 'shared/src'))
      await writeFile(join(root, 'shared/src/posts.ts'), `export const posts = query({ name: 'posts.list' })\n`)
      await symlink(join(root, 'shared/src'), join(root, 'server/realtime'), 'dir')
      process.chdir(root)
      const turbopack = (withHolo() as { readonly turbopack?: { readonly rules?: Record<string, unknown> } }).turbopack
      const [browserRule] = turbopack?.rules?.['*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}'] as Array<{ condition: { all: [unknown, { any: Array<{ path: RegExp }> }] } }>
      const matches = (path: string) => browserRule?.condition.all[1].any.some(entry => entry.path.test(path)) ?? false

      expect(matches('shared/src/posts.ts')).toBe(true)
      expect(matches('./shared/src/posts.ts')).toBe(true)
      expect(matches('src/app/page.tsx')).toBe(false)
      expect(matches('packages/web/src/app/page.tsx')).toBe(false)
    } finally {
      process.chdir(previousCwd)
      await cleanup()
    }
  })

  it('fails closed when a symlinked realtime folder resolves outside the Turbopack root', async () => {
    const { root, cleanup } = await createSecretRealtimeProject('symlinked-realtime-directory')
    const previousCwd = process.cwd()
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { '@holo-js/realtime': 'workspace:*' } }))
      process.chdir(root)
      expect(() => withHolo({ turbopack: { root } })).toThrow(/server\/realtime resolves to .* outside the Turbopack root/)
    } finally {
      process.chdir(previousCwd)
      await cleanup()
    }
  })
})
