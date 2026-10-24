import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import realtimeDefinitionLoader from '../src/realtime-definition-loader'
import { browserBuildSecret, createSecretRealtimeProject } from '../../../tests/support/realtime-browser-build'

type WebpackStats = { hasErrors(): boolean, toString(options: string): string }
type Webpack = (config: object, callback: (error: Error | null, stats?: WebpackStats) => void) => void

const loadWebpack = (): Webpack => {
  const require = createRequire(import.meta.url)
  const bundle = require('next/dist/compiled/webpack/bundle5') as () => { webpack: Webpack }
  return bundle().webpack
}

describe('Next realtime browser build', () => {
  it('keeps handler source out of the webpack browser bundle and its source maps', async () => {
    const root = await createSecretRealtimeProject()
    const loaderKey = Symbol.for('holo.test.realtimeDefinitionLoader')
    Reflect.set(globalThis, loaderKey, realtimeDefinitionLoader)
    try {
      await writeFile(join(root, 'loader.cjs'), [
        `module.exports = function (source) { return globalThis[Symbol.for('holo.test.realtimeDefinitionLoader')].call(this, source) }`,
        '',
      ].join('\n'))
      await writeFile(join(root, 'client.ts'), `export { posts } from './server/realtime/posts'\n`)
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
        module: { rules: [{ test: /server[\\/]realtime[\\/].*\.ts$/, use: [join(root, 'loader.cjs')] }, { test: /client\.ts$/, type: 'javascript/esm' }] },
      }, (error, result) => error || !result ? reject(error ?? new Error('webpack returned no stats')) : resolve(result)))
      expect(stats.hasErrors(), stats.toString('errors-only')).toBe(false)
      const files = await readdir(join(root, 'dist'))
      const bundle = (await Promise.all(files.map(file => readFile(join(root, 'dist', file), 'utf8')))).join('\n')

      expect(files.some(file => file.endsWith('.map'))).toBe(true)
      expect(bundle).toContain('posts.list')
      expect(bundle).not.toContain(browserBuildSecret)
      expect(bundle).not.toContain('handler: async')
    } finally {
      Reflect.deleteProperty(globalThis, loaderKey)
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
