import { compileBrowserValidation } from '@holo-js/adapter-shared/build'
import { assertRealtimeDefinitionTree, isInRealtimeDefinitionDirectory, resolveRealtimeDefinitionDirectories } from '@holo-js/adapter-shared/realtime-directories'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type ConfiguredPlugin = { readonly name: string, readonly api?: unknown }

type VitePlugin = {
  readonly name: string
  readonly enforce: 'pre'
  configResolved(config: { readonly plugins: readonly ConfiguredPlugin[] }): void
  buildStart(): void
  configureServer(server: { readonly watcher: { on(event: 'all', listener: (event: string, path: string) => void): unknown } }): void
  resolveId(id: string): null | string
  readonly load: {
    readonly order: 'pre'
    handler(id: string, options?: { readonly ssr?: boolean }): null | string
  }
  transform(code: string, id: string, options?: { readonly ssr?: boolean }): null | {
    readonly code: string
    readonly map: object | null
  }
}

const realtimeFileExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function isRealtimeDefinitionModule(
  rootDir: string,
  id: string,
  directories: readonly string[] = resolveRealtimeDefinitionDirectories(rootDir),
): boolean {
  return isInRealtimeDefinitionDirectory(directories, id)
    && realtimeFileExtensions.has(extname(id.split('?')[0] as string))
}

const SVELTEKIT_PATHS_MODULE = 'virtual:holo-sveltekit/paths'
const RESOLVED_SVELTEKIT_PATHS_MODULE = `\0${SVELTEKIT_PATHS_MODULE}`

function property(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function svelteKitBase(plugins: readonly ConfiguredPlugin[]): string {
  const setup = plugins.find(plugin => plugin.name === 'vite-plugin-sveltekit-setup')
  const base = ['options', 'paths', 'base'].reduce(property, setup?.api)
  return typeof base === 'string' ? base : ''
}

export function holoSvelteKit(rootDir = process.cwd()): VitePlugin {
  const browserDefinitionIds = new Set<string>()
  let base = ''
  const directories = resolveRealtimeDefinitionDirectories(rootDir)
  let realtimeTreeChanged = false
  return {
    name: 'holo-sveltekit',
    enforce: 'pre',
    configResolved(config) {
      base = svelteKitBase(config.plugins)
    },
    buildStart() {
      assertRealtimeDefinitionTree(rootDir)
    },
    configureServer(server) {
      server.watcher.on('all', (_event, path) => {
        if (isInRealtimeDefinitionDirectory(directories, path)) realtimeTreeChanged = true
      })
    },
    resolveId(id) {
      return id === SVELTEKIT_PATHS_MODULE ? RESOLVED_SVELTEKIT_PATHS_MODULE : null
    },
    load: {
      order: 'pre',
      handler(id, options) {
        if (id === RESOLVED_SVELTEKIT_PATHS_MODULE) return `export const base = ${JSON.stringify(base)}\n`
        if (!options?.ssr && realtimeTreeChanged) {
          assertRealtimeDefinitionTree(rootDir)
          realtimeTreeChanged = false
        }
        const path = id.split('?')[0] as string
        if (options?.ssr || !isRealtimeDefinitionModule(rootDir, path, directories)) {
          return null
        }

        browserDefinitionIds.add(id)
        return createRealtimeClientDefinitionTransform(readFileSync(path, 'utf8'), path).code
      },
    },
    transform(code, id, options) {
      if (!options?.ssr && !id.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(id)) {
        const compiled = compileBrowserValidation(code, id)
        if (compiled) return { code: compiled, map: null }
      }
      if (options?.ssr || !isRealtimeDefinitionModule(rootDir, id, directories) || browserDefinitionIds.has(id)) {
        return null
      }

      return createRealtimeClientDefinitionTransform(code, id)
    },
  }
}
