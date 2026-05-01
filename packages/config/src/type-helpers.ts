import type { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/db'
import type {
  HoloAppEnv,
  HoloMediaConfig,
  NormalizedHoloAppConfig,
  NormalizedHoloAuthConfig,
  NormalizedHoloBroadcastConfig,
  NormalizedHoloCacheConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloMailConfig,
  NormalizedHoloNotificationsConfig,
  NormalizedHoloQueueConfig,
  NormalizedHoloRedisConfig,
  NormalizedHoloSecurityConfig,
  NormalizedHoloSessionConfig,
  NormalizedHoloStorageConfig,
} from './types'

export interface HoloConfigRegistry {
  app: NormalizedHoloAppConfig
  database: NormalizedHoloDatabaseConfig
  redis: NormalizedHoloRedisConfig
  cache: NormalizedHoloCacheConfig
  storage: NormalizedHoloStorageConfig
  queue: NormalizedHoloQueueConfig
  broadcast: NormalizedHoloBroadcastConfig
  mail: NormalizedHoloMailConfig
  notifications: NormalizedHoloNotificationsConfig
  media: HoloMediaConfig
  session: NormalizedHoloSessionConfig
  security: NormalizedHoloSecurityConfig
  auth: NormalizedHoloAuthConfig
}

export type HoloConfigMap = object

export interface LoadedEnvironment {
  readonly name: HoloAppEnv
  readonly values: Readonly<Record<string, string>>
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export interface LoadedHoloConfig<TCustom extends HoloConfigMap = HoloConfigMap> {
  readonly app: NormalizedHoloAppConfig
  readonly database: NormalizedHoloDatabaseConfig
  readonly redis: NormalizedHoloRedisConfig
  readonly cache: NormalizedHoloCacheConfig
  readonly storage: NormalizedHoloStorageConfig
  readonly queue: NormalizedHoloQueueConfig
  readonly broadcast: NormalizedHoloBroadcastConfig
  readonly notifications: NormalizedHoloNotificationsConfig
  readonly mail: NormalizedHoloMailConfig
  readonly media: HoloMediaConfig
  readonly session: NormalizedHoloSessionConfig
  readonly security: NormalizedHoloSecurityConfig
  readonly auth: NormalizedHoloAuthConfig
  readonly custom: Readonly<TCustom>
  readonly all: Readonly<HoloConfigRegistry & TCustom>
  readonly environment: LoadedEnvironment
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export type ConfigFileName = keyof HoloConfigRegistry | (string & {})

type Primitive = string | number | boolean | bigint | symbol | null | undefined
type NonTraversable = Primitive | readonly unknown[] | ((...args: never[]) => unknown)
type KnownPathKey<T> = Extract<{
  [K in keyof T & string]:
    K extends `${number}`
      ? never
      : [T[K]] extends [undefined]
        ? never
        : K
}[keyof T & string], string>

export type DotPath<T> = T extends NonTraversable
  ? never
  : {
      [K in KnownPathKey<T>]:
        T[K] extends NonTraversable
          ? K
          : K | `${K}.${DotPath<T[K]>}`
    }[KnownPathKey<T>]

export type ValueAtPath<T, TPath extends string>
  = TPath extends `${infer THead}.${infer TTail}`
    ? THead extends keyof T
      ? ValueAtPath<T[THead], TTail>
      : never
    : TPath extends keyof T
      ? T[TPath]
      : never

export type DefineConfigValue<TConfig extends object> = Readonly<TConfig>

export type HoloProjectDefaults = typeof DEFAULT_HOLO_PROJECT_PATHS
