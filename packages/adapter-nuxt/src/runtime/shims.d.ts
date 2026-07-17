import type { RuntimeConfigInput, RuntimeConnectionConfig, RuntimeDatabaseConfig } from '@holo-js/db'

type HoloConnectionRuntimeConfig = RuntimeConnectionConfig
type HoloDatabaseRuntimeConfig = RuntimeDatabaseConfig

interface StorageRuntimeDriverShim {
  name: string
  driver: 'local' | 'public' | 's3'
  visibility: 'private' | 'public'
  root?: string
  url?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

interface HoloRuntimeConfig extends RuntimeConfigInput {
  holo: NonNullable<RuntimeConfigInput['holo']> & {
    appEnv: 'production' | 'development' | 'test'
    appDebug: boolean
    appUrl?: string
    projectRoot?: string
  }
  db?: HoloDatabaseRuntimeConfig
  holoStorage: {
    defaultDisk: string | undefined
    diskNames: string[]
    routePrefix: string
    disks: Record<string, StorageRuntimeDriverShim>
  }
}

/**
 * Minimal Nuxt runtime shims for adapter typechecking.
 *
 * Keep these declarations limited to the fields consumed by adapter runtime code:
 * runtime config, storage access, and Nitro route/plugin globals.
 */
declare module '#app' {
  export function defineNuxtPlugin<T>(plugin: T): T
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useCookie<T = string | null>(name: string): { value: T | null | undefined }
}

declare module '#imports' {
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useStorage(base: string): unknown
}

declare module 'nitropack/runtime/config' {
  export function useRuntimeConfig(): HoloRuntimeConfig
}

declare module 'nitropack/runtime/context' {
  export function useEvent(): unknown
}

declare module 'nitropack/runtime/plugin' {
  export function defineNitroPlugin<T>(plugin: T): T
}

declare module 'nitropack/runtime/storage' {
  export function useStorage(base: string): unknown
}

declare global {
  interface ImportMeta {
    glob<TModule>(
      pattern: string,
      options: { readonly eager: true },
    ): Record<string, TModule>
  }

}

export {}
