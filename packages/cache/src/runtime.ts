import type { CacheRuntimeBindings } from './contracts'
import { cacheDbInternals } from './db'
import {
  createCacheQueryBridge,
  getOrCreateDependencyIndex,
  resetDefaultDependencyIndex,
  setGlobalDatabaseQueryCacheBridge,
} from './query-bridge'
import { cacheRedisInternals } from './redis'
import {
  createDriverMap,
  disposeCacheRuntimeBindings,
  getCacheRuntimeState,
  isNormalizedCacheConfig,
  normalizeRuntimeConfig,
  resolveConfiguredDriver,
} from './runtime-shared'

export { getCacheRuntime, getCacheRuntimeBindings } from './runtime-shared'

export function configureCacheRuntime(bindings?: CacheRuntimeBindings): void {
  disposeCacheRuntimeBindings(getCacheRuntimeState().bindings)

  if (!bindings) {
    getCacheRuntimeState().bindings = undefined
    resetDefaultDependencyIndex()
    setGlobalDatabaseQueryCacheBridge(undefined)
    return
  }

  const dependencyIndex = bindings.dependencyIndex ?? getOrCreateDependencyIndex()
  const queryBridge = bindings.queryBridge ?? createCacheQueryBridge(dependencyIndex)

  getCacheRuntimeState().bindings = Object.freeze({
    config: normalizeRuntimeConfig(bindings.config),
    databaseConfig: cacheDbInternals.normalizeRuntimeDatabaseConfig(bindings.databaseConfig),
    redisConfig: cacheRedisInternals.normalizeRuntimeRedisConfig(bindings.redisConfig),
    drivers: createDriverMap(bindings.drivers),
    dependencyIndex,
    queryBridge,
  })
  setGlobalDatabaseQueryCacheBridge(queryBridge)
}

export function resetCacheRuntime(): void {
  disposeCacheRuntimeBindings(getCacheRuntimeState().bindings)
  getCacheRuntimeState().bindings = undefined
  resetDefaultDependencyIndex()
  setGlobalDatabaseQueryCacheBridge(undefined)
}

export const cacheRuntimeInternals = {
  getCacheRuntimeState,
  isNormalizedCacheConfig,
  normalizeRuntimeConfig,
  resolveConfiguredDriver,
}
