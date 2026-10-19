import type { RuntimeConfigInput } from '@holo-js/db'

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
    appUrl?: string
    projectRoot?: string
  }
  holoStorage: {
    defaultDisk: string | undefined
    diskNames: string[]
    routePrefix: string
    disks: Record<string, StorageRuntimeDriverShim>
  }
}

declare module '#app' {
  export function defineNuxtPlugin<T>(plugin: T): T
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useCookie<T = string | null>(name: string): { value: T | null | undefined }
}

declare module '#imports' {
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useStorage(base: string): unknown
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
