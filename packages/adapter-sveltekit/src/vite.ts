import { extname } from 'node:path'
import { createRealtimeClientDefinitionTransform } from './realtime-definition-transform'

type VitePlugin = {
  readonly name: string
  readonly enforce: 'pre'
  transform(code: string, id: string, options?: { readonly ssr?: boolean }): null | {
    readonly code: string
    readonly map: object
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
  return {
    name: 'holo-sveltekit-realtime-client-definitions',
    enforce: 'pre',
    transform(code, id, options) {
      if (options?.ssr || !isRealtimeDefinitionModule(rootDir, id)) {
        return null
      }

      return createRealtimeClientDefinitionTransform(code)
    },
  }
}
