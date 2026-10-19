import type { RuntimeConfigInput, RuntimeConnectionConfig, RuntimeDatabaseConfig } from '@holo-js/db'

type HoloConnectionRuntimeConfig = RuntimeConnectionConfig
type HoloDatabaseRuntimeConfig = RuntimeDatabaseConfig

interface HoloRuntimeConfig extends RuntimeConfigInput {
  holo: NonNullable<RuntimeConfigInput['holo']> & {
    appEnv: 'production' | 'development' | 'test'
    appDebug: boolean
    appUrl?: string
    projectRoot?: string
  }
  db?: HoloDatabaseRuntimeConfig
}

declare module '#app' {
  export function defineNuxtPlugin<T>(plugin: T): T
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useCookie<T = string | null>(name: string): { value: T | null | undefined }
}

declare module '#imports' {
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useEvent(): import('h3').H3Event
  export function defineNitroPlugin<T>(plugin: T): T
  export * from 'h3'
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
