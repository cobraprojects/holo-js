import { compileBrowserValidation } from '@holo-js/adapter-shared/build'
import { readFileSync } from 'node:fs'
import { extname } from 'node:path'
import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type VitePlugin = {
  readonly name: string
  readonly enforce: 'pre'
  load(id: string, options?: { readonly ssr?: boolean }): null | string
  transform(code: string, id: string, options?: { readonly ssr?: boolean }): null | {
    readonly code: string
    readonly map: object | null
  }
}

const realtimeFileExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])

export function isRealtimeDefinitionModule(rootDir: string, id: string): boolean {
  const normalizedRoot = rootDir.replaceAll('\\', '/').replace(/\/+$/, '')
  const normalizedId = (id.split('?')[0] as string).replaceAll('\\', '/')
  return normalizedId.startsWith(`${normalizedRoot}/server/realtime/`)
    && realtimeFileExtensions.has(extname(normalizedId))
}

export function holoSvelteKitRealtime(rootDir = process.cwd()): VitePlugin {
  const browserDefinitionIds = new Set<string>()
  return {
    name: 'holo-sveltekit-realtime-client-definitions',
    enforce: 'pre',
    load(id, options) {
      const path = id.split('?')[0] as string
      if (options?.ssr || !isRealtimeDefinitionModule(rootDir, path)) {
        return null
      }

      browserDefinitionIds.add(id)
      return createRealtimeClientDefinitionTransform(readFileSync(path, 'utf8'), { failClosed: path }).code
    },
    transform(code, id, options) {
      if (!options?.ssr && !id.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(id)) {
        const compiled = compileBrowserValidation(code, id)
        if (compiled) return { code: compiled, map: null }
      }
      if (options?.ssr || !isRealtimeDefinitionModule(rootDir, id) || browserDefinitionIds.has(id)) {
        return null
      }

      return createRealtimeClientDefinitionTransform(code)
    },
  }
}
