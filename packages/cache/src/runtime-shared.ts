import {
  holoCacheDefaults,
  normalizeCacheConfig,
  type HoloCacheConfig,
  type NormalizedCacheDatabaseDriverConfig,
  type NormalizedCacheFileDriverConfig,
  type NormalizedCacheMemoryDriverConfig,
  type NormalizedCacheRedisDriverConfig,
  type NormalizedHoloDatabaseConfig,
  type NormalizedHoloCacheConfig,
  type NormalizedHoloRedisConfig,
} from '@holo-js/config'
import {
  CacheDriverResolutionError,
  CacheRuntimeNotConfiguredError,
  type CacheDriverContract,
  type CacheRuntimeBindings,
} from './contracts'
import { cacheDbInternals, createDatabaseCacheDriver } from './db'
import { createFileCacheDriver } from './file'
import { createMemoryCacheDriver } from './memory'
import { cacheRedisInternals, createRedisCacheDriver } from './redis'

type CacheRuntimeFacade = {
  readonly config: NormalizedHoloCacheConfig
  readonly databaseConfig?: NormalizedHoloDatabaseConfig
  readonly redisConfig?: NormalizedHoloRedisConfig
  readonly drivers: Map<string, CacheDriverContract>
  readonly dependencyIndex?: CacheRuntimeBindings['dependencyIndex']
  readonly queryBridge?: CacheRuntimeBindings['queryBridge']
}

type RuntimeCacheState = {
  bindings?: CacheRuntimeFacade
}

const CACHE_DRIVER_DISPOSE_SYMBOL = Symbol.for('holo.cache.driver.dispose')

type DisposableCacheDriver = CacheDriverContract & {
  readonly [CACHE_DRIVER_DISPOSE_SYMBOL]?: () => void
}

function disposeDriver(driver: CacheDriverContract): void {
  const disposable = driver as DisposableCacheDriver
  disposable[CACHE_DRIVER_DISPOSE_SYMBOL]?.()
}

export function disposeCacheRuntimeBindings(bindings: CacheRuntimeFacade | undefined): void {
  if (!bindings) {
    return
  }

  for (const [driverName, driver] of bindings.drivers.entries()) {
    try {
      disposeDriver(driver)
    } catch (error) {
      console.error(`[@holo-js/cache] Failed to dispose cache driver "${driverName}".`, error)
    }
  }
}

export function isNormalizedCacheConfig(
  config: HoloCacheConfig | NormalizedHoloCacheConfig,
): config is NormalizedHoloCacheConfig {
  return typeof config.default === 'string'
    && typeof config.prefix === 'string'
    && typeof config.drivers === 'object'
    && config.drivers !== null
    && Object.values(config.drivers).every((driver) => {
      return typeof driver === 'object'
        && driver !== null
        && 'name' in driver
        && 'prefix' in driver
        && typeof driver.name === 'string'
        && typeof driver.prefix === 'string'
    })
}

export function normalizeRuntimeConfig(
  config: HoloCacheConfig | NormalizedHoloCacheConfig | undefined,
): NormalizedHoloCacheConfig {
  if (!config) return holoCacheDefaults
  return isNormalizedCacheConfig(config) ? config : normalizeCacheConfig(config)
}

export function getCacheRuntimeState(): RuntimeCacheState {
  const runtime = globalThis as typeof globalThis & {
    __holoCacheRuntime__?: RuntimeCacheState
  }

  runtime.__holoCacheRuntime__ ??= {}
  return runtime.__holoCacheRuntime__
}

export function getCacheRuntimeBindings(): CacheRuntimeFacade | undefined {
  return getCacheRuntimeState().bindings
}

export function getCacheRuntime(): CacheRuntimeFacade {
  const bindings = getCacheRuntimeBindings()
  if (!bindings) {
    throw new CacheRuntimeNotConfiguredError()
  }

  return bindings
}

export function createDriverMap(
  drivers?: ReadonlyMap<string, CacheDriverContract>,
): Map<string, CacheDriverContract> {
  return drivers ? new Map<string, CacheDriverContract>(drivers.entries()) : new Map<string, CacheDriverContract>()
}

function cacheResolvedDriver(
  facade: CacheRuntimeFacade,
  driverName: string,
  driver: CacheDriverContract,
): CacheDriverContract {
  facade.drivers.set(driverName, driver)
  return driver
}

export function resolveConfiguredDriver(
  facade: CacheRuntimeFacade,
  requestedName?: string,
): CacheDriverContract {
  const driverName = requestedName?.trim() || facade.config.default
  const cachedDriver = facade.drivers.get(driverName)
  if (cachedDriver) {
    return cachedDriver
  }

  const driverConfig = facade.config.drivers[driverName]
  if (!driverConfig) {
    throw new CacheDriverResolutionError(`[@holo-js/cache] Cache driver "${driverName}" is not configured.`)
  }

  switch (driverConfig.driver) {
    case 'file': {
      const fileConfig = driverConfig as NormalizedCacheFileDriverConfig
      return cacheResolvedDriver(facade, driverName, createFileCacheDriver({
        name: fileConfig.name,
        path: fileConfig.path,
        prefix: fileConfig.prefix,
      }))
    }
    case 'memory': {
      const memoryConfig = driverConfig as NormalizedCacheMemoryDriverConfig
      return cacheResolvedDriver(facade, driverName, createMemoryCacheDriver({
        name: memoryConfig.name,
        maxEntries: memoryConfig.maxEntries,
      }))
    }
    case 'redis': {
      const redisConfig = driverConfig as NormalizedCacheRedisDriverConfig
      const connection = cacheRedisInternals.resolveSharedRedisConnection(
        facade.redisConfig,
        redisConfig.connection,
      )
      return cacheResolvedDriver(facade, driverName, createRedisCacheDriver({
        name: redisConfig.name,
        connectionName: connection.name,
        prefix: redisConfig.prefix,
        redis: connection,
      }))
    }
    case 'database': {
      const databaseConfig = driverConfig as NormalizedCacheDatabaseDriverConfig
      const connection = cacheDbInternals.resolveSharedDatabaseConnection(
        facade.databaseConfig,
        databaseConfig.connection,
      )
      return cacheResolvedDriver(facade, driverName, createDatabaseCacheDriver({
        name: databaseConfig.name,
        connectionName: databaseConfig.connection,
        table: databaseConfig.table,
        lockTable: databaseConfig.lockTable,
        prefix: databaseConfig.prefix,
        connection,
      }))
    }
    default:
      if (typeof driverConfig.driver === 'string') {
        const pluginDriver = facade.drivers.get(driverConfig.driver)
        if (pluginDriver) {
          return cacheResolvedDriver(facade, driverName, pluginDriver)
        }
      }

      throw new CacheDriverResolutionError(
        `[@holo-js/cache] Cache driver "${driverName}" uses unsupported driver "${String((driverConfig as { driver?: unknown }).driver)}" in this phase.`,
      )
  }
}
