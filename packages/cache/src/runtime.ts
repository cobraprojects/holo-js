import type { NormalizedCachePluginDriverConfig } from '@holo-js/config'
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
import {
  loadConfiguredCachePluginDriverContracts,
  resetCachePluginDriverContracts,
} from './plugins'

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
  resetCachePluginDriverContracts()
}

export async function loadCachePluginDrivers(projectRoot = process.cwd()): Promise<void> {
  const bindings = getCacheRuntimeState().bindings
  if (!bindings) {
    return
  }

  const pluginDriverConfigs = Object.values(bindings.config.drivers)
    .filter((driver): driver is NormalizedCachePluginDriverConfig => {
      return driver.driver !== 'memory'
        && driver.driver !== 'file'
        && driver.driver !== 'redis'
        && driver.driver !== 'database'
    })

  for (const driver of await loadConfiguredCachePluginDriverContracts(projectRoot, pluginDriverConfigs)) {
    bindings.drivers.set(driver.name, driver)
  }

  if (pluginDriverConfigs.length > 0) {
    return
  }

  const { loadCachePluginDriverContracts } = await import('./plugins')
  for (const driver of await loadCachePluginDriverContracts(projectRoot)) {
    bindings.drivers.set(driver.name, driver)
  }
}

export const cacheRuntimeInternals = {
  getCacheRuntimeState,
  isNormalizedCacheConfig,
  normalizeRuntimeConfig,
  resolveConfiguredDriver,
}
