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

interface HoloRef<TValue> {
  value: TValue
}

interface HoloComputedRef<TValue> {
  readonly value: TValue
}

interface HoloUseFetchResult<TValue> {
  readonly data: HoloRef<TValue | null>
  readonly refresh: () => Promise<void>
}

interface HoloRouteLocation {
  readonly path: string
}

type HoloNavigateToResult = void | false | Promise<void | false>

/**
 * Minimal Nuxt runtime shims for adapter typechecking.
 *
 * Keep these declarations limited to the fields consumed by adapter runtime code:
 * composables/auth.ts uses HoloUseFetchResult.data/refresh, useFetch options.key,
 * useState key/init with HoloRef.value, and computed getter/value.
 */
declare module '#app' {
  export function useRuntimeConfig(): HoloRuntimeConfig
}

declare module '#imports' {
  export function computed<TValue>(getter: () => TValue): HoloComputedRef<TValue>
  export function defineNuxtRouteMiddleware<TValue>(
    middleware: (to: HoloRouteLocation, from: HoloRouteLocation) => TValue | Promise<TValue>,
  ): (to: HoloRouteLocation, from: HoloRouteLocation) => TValue | Promise<TValue>
  export function navigateTo(
    to: string,
    options?: { readonly redirectCode?: number },
  ): HoloNavigateToResult
  export function useFetch<TValue = unknown>(
    request: string,
    options?: { readonly key?: string },
  ): Promise<HoloUseFetchResult<TValue>>
  export function useRuntimeConfig(): HoloRuntimeConfig
  export function useState<TValue>(key: string, init: () => TValue): HoloRef<TValue>
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
