import type { HoloAdapterProjectAccessors } from '@holo-js/core'

export interface HoloRuntimeConnection {
  driver?: 'sqlite' | 'postgres' | 'mysql'
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging: boolean
}

export interface HoloRuntimeDatabaseGroup {
  defaultConnection: string
  connections: Record<string, { url?: string } | HoloRuntimeConnection>
}

export interface HoloRuntimeDefaultConnection extends HoloRuntimeConnection {
  defaultConnection: 'default'
  connections: {
    default: HoloRuntimeConnection
  }
}

export declare const holo: HoloAdapterProjectAccessors
export declare function configureHoloRuntimeConfig(config: {
  holo: {
    appUrl?: string
    projectRoot?: string
  }
}): void
export declare function resetHoloRuntimeConfig(): void
export type NuxtRuntime = {
  readonly useEvent: () => NuxtAuthRequestEvent | undefined
  readonly createAuthorizationError: (decision: {
    readonly message?: string
    readonly status: 200 | 403 | 404
  }) => Error
}
export declare function configureNuxtRuntime(runtime: NuxtRuntime): void
export type NuxtAuthRequestEvent = {
  readonly headers?: Pick<Headers, 'get'>
  readonly request?: {
    readonly headers?: Pick<Headers, 'get'>
  }
  readonly web?: {
    readonly request?: {
      readonly headers?: Pick<Headers, 'get'>
    }
  }
  readonly node?: {
    readonly req?: {
      readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>
    }
    readonly res?: {
      statusCode: number
      getHeader(name: string): number | string | readonly string[] | undefined
      setHeader(name: string, value: number | string | readonly string[]): void
      end(): void
    }
  }
}
export declare function runWithNuxtRequest<TValue>(event: NuxtAuthRequestEvent, callback: () => TValue): Promise<Awaited<TValue>>
export declare function useHoloDb(): HoloRuntimeDatabaseGroup | HoloRuntimeDefaultConnection
export declare function useHoloEnv(): 'production' | 'development' | 'test'
export declare function useHoloDebug(): boolean
