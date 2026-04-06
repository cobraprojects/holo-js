import type { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/db'
import type { NormalizedHoloQueueConfig, HoloQueueConfig } from '@holo-js/queue'

export interface HoloProjectPaths {
  models: string
  migrations: string
  generatedSchema: string
  seeders: string
  observers: string
  factories: string
  commands: string
  jobs: string
}

export interface HoloProjectConnectionConfig {
  driver?: SupportedDatabaseDriver
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  filename?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging?: boolean
}

export interface HoloProjectDatabaseConfig {
  defaultConnection?: string
  connections?: Record<string, HoloProjectConnectionConfig | string>
}

export interface HoloProjectConfig {
  paths?: Partial<HoloProjectPaths>
  database?: HoloProjectDatabaseConfig
  models?: readonly string[]
  migrations?: readonly string[]
  seeders?: readonly string[]
}

export type SupportedDatabaseDriver = 'sqlite' | 'postgres' | 'mysql'
export type HoloAppEnv = 'development' | 'production' | 'test'

export interface HoloAppConfig extends HoloProjectConfig {
  name?: string
  key?: string
  url?: string
  debug?: boolean
  env?: HoloAppEnv
}

export type HoloDatabaseConnectionConfig = HoloProjectConnectionConfig
export type HoloDatabaseConfig = HoloProjectDatabaseConfig

export type StorageDriver = 'local' | 'public' | 's3'
export type StorageVisibility = 'private' | 'public'

export interface BaseDiskConfig {
  driver: StorageDriver
  visibility?: StorageVisibility
  root?: string
  url?: string
  [key: string]: unknown
}

export interface LocalDiskConfig extends BaseDiskConfig {
  driver: 'local' | 'public'
}

export interface S3DiskConfig extends BaseDiskConfig {
  driver: 's3'
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

export type DiskConfig = LocalDiskConfig | S3DiskConfig

export interface HoloStorageConfig {
  defaultDisk?: string
  routePrefix?: string
  disks?: Record<string, DiskConfig>
}

export interface HoloMediaConfig {
  [key: string]: unknown
}

export type { HoloQueueConfig, NormalizedHoloQueueConfig }

export interface NormalizedHoloAppConfig {
  readonly name: string
  readonly key: string
  readonly url: string
  readonly debug: boolean
  readonly env: HoloAppEnv
  readonly paths: Readonly<HoloProjectPaths>
  readonly models: readonly string[]
  readonly migrations: readonly string[]
  readonly seeders: readonly string[]
}

export interface NormalizedHoloDatabaseConfig {
  readonly defaultConnection?: string
  readonly connections: Readonly<Record<string, HoloDatabaseConnectionConfig | string>>
}

export interface NormalizedHoloStorageConfig {
  readonly defaultDisk?: string
  readonly routePrefix: string
  readonly disks: Readonly<Record<string, DiskConfig>>
}

export interface HoloConfigRegistry {
  app: NormalizedHoloAppConfig
  database: NormalizedHoloDatabaseConfig
  storage: NormalizedHoloStorageConfig
  queue: NormalizedHoloQueueConfig
  media: HoloMediaConfig
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
  readonly storage: NormalizedHoloStorageConfig
  readonly queue: NormalizedHoloQueueConfig
  readonly media: HoloMediaConfig
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
  [K in keyof T]:
  K extends string
    ? string extends K
      ? never
      : K
    : never
}[keyof T], string>

export type DotPath<T> = T extends NonTraversable
  ? never
  : {
      [K in KnownPathKey<T>]:
      T[K] extends NonTraversable
        ? K
        : T[K] extends object
          ? K | `${K}.${DotPath<T[K]>}`
          : K
    }[KnownPathKey<T>]

export type ValueAtPath<T, TPath extends string>
  = TPath extends `${infer Head}.${infer Tail}`
    ? Head extends keyof T
      ? ValueAtPath<T[Head], Tail>
      : never
    : TPath extends keyof T
      ? T[TPath]
      : never

export type DefineConfigValue<TConfig extends object> = Readonly<TConfig>

export type HoloProjectDefaults = typeof DEFAULT_HOLO_PROJECT_PATHS
