import type { NormalizedHoloDatabaseConfig } from '@holo-js/db'
import type { NormalizedHoloRedisConfig } from '@holo-js/kernel'
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'

export type CacheDriver = 'memory' | 'file' | 'redis' | 'database' | (string & {})

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    cache: NormalizedHoloCacheConfig
  }
}

export interface CacheMemoryDriverConfig {
  readonly driver: 'memory'
  readonly maxEntries?: number | string
  readonly prefix?: string
}

export interface CacheFileDriverConfig {
  readonly driver: 'file'
  readonly path?: string
  readonly prefix?: string
}

export interface CacheRedisDriverConfig {
  readonly driver: 'redis'
  readonly connection?: string
  readonly prefix?: string
}

export interface CacheDatabaseDriverConfig {
  readonly driver: 'database'
  readonly connection?: string
  readonly table?: string
  readonly lockTable?: string
  readonly prefix?: string
}

export interface CachePluginDriverConfig {
  readonly driver: string
  readonly prefix?: string
  readonly [key: string]: unknown
}

export type CacheDriverConfig
  = CacheMemoryDriverConfig
  | CacheFileDriverConfig
  | CacheRedisDriverConfig
  | CacheDatabaseDriverConfig
  | CachePluginDriverConfig

export interface HoloCacheConfig {
  readonly default?: string
  readonly prefix?: string
  readonly drivers?: Readonly<Record<string, CacheDriverConfig>>
}

export interface NormalizedCacheMemoryDriverConfig {
  readonly name: string
  readonly driver: 'memory'
  readonly prefix: string
  readonly maxEntries?: number
}

export interface NormalizedCacheFileDriverConfig {
  readonly name: string
  readonly driver: 'file'
  readonly path: string
  readonly prefix: string
}

export interface NormalizedCacheRedisDriverConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly connection: string
  readonly prefix: string
}

export interface NormalizedCacheDatabaseDriverConfig {
  readonly name: string
  readonly driver: 'database'
  readonly connection: string
  readonly table: string
  readonly lockTable: string
  readonly prefix: string
}

export interface NormalizedCachePluginDriverConfig {
  readonly name: string
  readonly driver: string
  readonly prefix: string
  readonly [key: string]: unknown
}

export type NormalizedCacheDriverConfig
  = NormalizedCacheMemoryDriverConfig
  | NormalizedCacheFileDriverConfig
  | NormalizedCacheRedisDriverConfig
  | NormalizedCacheDatabaseDriverConfig
  | NormalizedCachePluginDriverConfig

export interface NormalizedHoloCacheConfig {
  readonly default: string
  readonly prefix: string
  readonly drivers: Readonly<Record<string, NormalizedCacheDriverConfig>>
}

export type CacheNormalizationOptions = {
  readonly database?: NormalizedHoloDatabaseConfig
  readonly redis?: NormalizedHoloRedisConfig
}

export const DEFAULT_CACHE_DRIVER = 'file'
export const DEFAULT_CACHE_PREFIX = ''
export const DEFAULT_CACHE_FILE_PATH = './storage/framework/cache/data'
export const DEFAULT_CACHE_REDIS_CONNECTION = 'default'
export const DEFAULT_CACHE_DATABASE_CONNECTION = 'default'
export const DEFAULT_CACHE_DATABASE_TABLE = 'cache'
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = 'cache_locks'

export const holoCacheDefaults: Readonly<NormalizedHoloCacheConfig> = Object.freeze({
  default: DEFAULT_CACHE_DRIVER,
  prefix: DEFAULT_CACHE_PREFIX,
  drivers: Object.freeze({
    file: Object.freeze({
      name: 'file',
      driver: 'file' as const,
      path: DEFAULT_CACHE_FILE_PATH,
      prefix: DEFAULT_CACHE_PREFIX,
    }),
    memory: Object.freeze({
      name: 'memory',
      driver: 'memory' as const,
      maxEntries: undefined,
      prefix: DEFAULT_CACHE_PREFIX,
    }),
  }),
})

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function normalizeName(value: string | undefined, label: string): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`[Holo Cache] ${label} must be a non-empty string.`)
  }
  return normalized
}

function parseOptionalInteger(value: number | string | undefined, label: string): number | undefined {
  if (typeof value === 'undefined') return undefined
  const normalized = typeof value === 'number'
    ? value
    : value.trim()
      ? Number(value.trim())
      : Number.NaN
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) {
    throw new Error(`[Holo Cache] ${label} must be an integer.`)
  }
  if (normalized < 1) {
    throw new Error(`[Holo Cache] ${label} must be greater than or equal to 1.`)
  }
  return normalized
}

function resolvePrefix(globalPrefix: string, localPrefix: string | undefined): string {
  return normalizeOptionalString(localPrefix) ?? globalPrefix
}

function normalizeDriverConfig(
  name: string,
  config: CacheDriverConfig,
  globalPrefix: string,
  defaultRedisConnection: string,
  defaultDatabaseConnection: string,
): NormalizedCacheDriverConfig {
  switch (config.driver) {
    case 'memory': {
      const memoryConfig = config as CacheMemoryDriverConfig
      return Object.freeze({
        name,
        driver: 'memory',
        prefix: resolvePrefix(globalPrefix, memoryConfig.prefix),
        maxEntries: parseOptionalInteger(memoryConfig.maxEntries, `cache driver "${name}" maxEntries`),
      })
    }
    case 'file': {
      const fileConfig = config as CacheFileDriverConfig
      return Object.freeze({
        name,
        driver: 'file',
        path: normalizeOptionalString(fileConfig.path) || DEFAULT_CACHE_FILE_PATH,
        prefix: resolvePrefix(globalPrefix, fileConfig.prefix),
      })
    }
    case 'redis': {
      const redisConfig = config as CacheRedisDriverConfig
      return Object.freeze({
        name,
        driver: 'redis',
        connection: normalizeOptionalString(redisConfig.connection) ?? defaultRedisConnection,
        prefix: resolvePrefix(globalPrefix, redisConfig.prefix),
      })
    }
    case 'database': {
      const databaseConfig = config as CacheDatabaseDriverConfig
      return Object.freeze({
        name,
        driver: 'database',
        connection: normalizeOptionalString(databaseConfig.connection) ?? defaultDatabaseConnection,
        table: normalizeOptionalString(databaseConfig.table) || DEFAULT_CACHE_DATABASE_TABLE,
        lockTable: normalizeOptionalString(databaseConfig.lockTable) || DEFAULT_CACHE_DATABASE_LOCK_TABLE,
        prefix: resolvePrefix(globalPrefix, databaseConfig.prefix),
      })
    }
    default: {
      const { driver, prefix, ...options } = config
      return Object.freeze({
        ...options,
        name,
        driver: normalizeName(driver, `Cache driver "${name}" driver`),
        prefix: resolvePrefix(globalPrefix, prefix),
      })
    }
  }
}

export function normalizeCacheConfig(
  config: HoloCacheConfig = {},
  options: CacheNormalizationOptions = {},
): NormalizedHoloCacheConfig {
  const prefix = normalizeOptionalString(config.prefix) ?? DEFAULT_CACHE_PREFIX
  const defaultRedisConnection = options.redis?.default ?? DEFAULT_CACHE_REDIS_CONNECTION
  const defaultDatabaseConnection = options.database?.defaultConnection ?? DEFAULT_CACHE_DATABASE_CONNECTION
  const driverEntries = !config.drivers || Object.keys(config.drivers).length === 0
    ? Object.entries(holoCacheDefaults.drivers)
    : Object.entries(config.drivers)
  const normalizedDriverEntries = driverEntries.map(([name, driver]) => {
    const normalizedName = normalizeName(name, 'Cache driver name')
    return [normalizedName, normalizeDriverConfig(
      normalizedName,
      driver,
      prefix,
      defaultRedisConnection,
      defaultDatabaseConnection,
    )] as const
  })
  const drivers = Object.freeze(Object.fromEntries(normalizedDriverEntries))
  const configuredDefault = normalizeOptionalString(config.default)
  if (configuredDefault && !Object.hasOwn(drivers, configuredDefault)) {
    throw new Error(`[Holo Cache] default cache driver "${configuredDefault}" is not configured.`)
  }
  const defaultDriver = configuredDefault
    ?? normalizedDriverEntries.find(([name]) => name === DEFAULT_CACHE_DRIVER)?.[0]
    ?? normalizedDriverEntries[0]![0]
  return Object.freeze({ default: defaultDriver, prefix, drivers })
}

export function defineCacheConfig<TConfig extends HoloCacheConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloCacheConfig, NormalizedHoloCacheConfig>({
  name: 'cache',
  dependencies: ['database', 'redis'],
  normalize(config, context) {
    return normalizeCacheConfig(config, {
      database: context.get<NormalizedHoloDatabaseConfig>('database'),
      redis: context.has('redis') ? context.get<NormalizedHoloRedisConfig>('redis') : undefined,
    })
  },
})
