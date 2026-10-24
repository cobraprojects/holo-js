import { compileBrowserValidation } from '@holo-js/adapter-shared/build'
import { assertRealtimeDefinitionTree, isInRealtimeDefinitionDirectory, resolveRealtimeDefinitionDirectories } from '@holo-js/adapter-shared/realtime-directories'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type VitePlugin = {
  readonly name: string
  readonly enforce: 'pre'
  buildStart(): void
  configureServer(server: { readonly watcher: { on(event: 'all', listener: (event: string, path: string) => void): unknown } }): void
  load(id: string, options?: { readonly ssr?: boolean }): null | string
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

export function holoSvelteKitRealtime(rootDir = process.cwd()): VitePlugin {
  const browserDefinitionIds = new Set<string>()
  const directories = resolveRealtimeDefinitionDirectories(rootDir)
  let realtimeTreeChanged = false
  return {
    name: 'holo-sveltekit-realtime-client-definitions',
    enforce: 'pre',
    buildStart() {
      assertRealtimeDefinitionTree(rootDir)
    },
    configureServer(server) {
      server.watcher.on('all', (_event, path) => {
        if (isInRealtimeDefinitionDirectory(directories, path)) realtimeTreeChanged = true
      })
    },
    load(id, options) {
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
