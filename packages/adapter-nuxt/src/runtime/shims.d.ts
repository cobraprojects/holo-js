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
  export const createError: typeof import('h3').createError
  export const defineEventHandler: typeof import('h3').defineEventHandler
  export const getHeaders: typeof import('h3').getHeaders
  export const getRequestURL: typeof import('h3').getRequestURL
  export const readRawBody: typeof import('h3').readRawBody
  export const send: typeof import('h3').send
  export const sendRedirect: typeof import('h3').sendRedirect
  export const sendWebResponse: typeof import('h3').sendWebResponse
  export const setHeader: typeof import('h3').setHeader
  export const setResponseStatus: typeof import('h3').setResponseStatus
  export const toWebRequest: typeof import('h3').toWebRequest
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
