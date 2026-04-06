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
  export function useRuntimeConfig(): HoloRuntimeConfig
}

declare module '#imports' {
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useStorage(base: string): unknown
}

declare global {
  function createError(input: { statusCode: number, statusMessage: string }): Error
  function defineNitroPlugin<T>(plugin: T): T
  function defineEventHandler<T>(
    handler: (event: unknown) => T | Promise<T>,
  ): (event: unknown) => T | Promise<T>
  function getRequestURL(event: unknown): URL
  function setResponseHeader(event: unknown, name: string, value: string): void
  function useRuntimeConfig(): HoloRuntimeConfig
}

export {}
