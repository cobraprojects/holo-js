import {
  holoCacheDefaults,
  normalizeCacheConfig,
  type HoloCacheConfig,
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
      return cacheResolvedDriver(facade, driverName, createFileCacheDriver({
        name: driverConfig.name,
        path: driverConfig.path,
        prefix: driverConfig.prefix,
      }))
    }
    case 'memory': {
      return cacheResolvedDriver(facade, driverName, createMemoryCacheDriver({
        name: driverConfig.name,
        maxEntries: driverConfig.maxEntries,
      }))
    }
    case 'redis': {
      const connection = cacheRedisInternals.resolveSharedRedisConnection(
        facade.redisConfig,
        driverConfig.connection,
      )
      return cacheResolvedDriver(facade, driverName, createRedisCacheDriver({
        name: driverConfig.name,
        connectionName: connection.name,
        prefix: driverConfig.prefix,
        redis: connection,
      }))
    }
    case 'database': {
      const connection = cacheDbInternals.resolveSharedDatabaseConnection(
        facade.databaseConfig,
        driverConfig.connection,
      )
      return cacheResolvedDriver(facade, driverName, createDatabaseCacheDriver({
        name: driverConfig.name,
        connectionName: driverConfig.connection,
        table: driverConfig.table,
        lockTable: driverConfig.lockTable,
        prefix: driverConfig.prefix,
        connection,
      }))
    }
    default:
      /* v8 ignore next -- config normalization restricts the driver union before runtime resolution. */
      throw new CacheDriverResolutionError(
        `[@holo-js/cache] Cache driver "${driverName}" uses unsupported driver "${String((driverConfig as { driver?: unknown }).driver)}" in this phase.`,
      )
  }
}
