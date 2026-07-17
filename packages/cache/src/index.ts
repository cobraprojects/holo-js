export {
  defineCacheConfig,
  holoCacheDefaults,
  normalizeCacheConfig,
} from './config'
export type {
  CacheDatabaseDriverConfig,
  CacheDriver,
  CacheDriverConfig,
  CacheFileDriverConfig,
  CacheMemoryDriverConfig,
  CachePluginDriverConfig,
  CacheRedisDriverConfig,
  HoloCacheConfig,
  NormalizedCacheDatabaseDriverConfig,
  NormalizedCacheDriverConfig,
  NormalizedCacheFileDriverConfig,
  NormalizedCacheMemoryDriverConfig,
  NormalizedCachePluginDriverConfig,
  NormalizedCacheRedisDriverConfig,
  NormalizedHoloCacheConfig,
} from './config'

export {
  CacheConfigError,
  CacheDriverResolutionError,
  CacheError,
  CacheInvalidNumericMutationError,
  CacheInvalidTtlError,
  CacheLockAcquisitionError,
  CacheOptionalPackageError,
  CacheQueryIntegrationError,
  CacheRuntimeNotConfiguredError,
  CacheSerializationError,
  cacheContractsInternals,
  defineCacheKey,
  deserializeCacheValue,
  isCacheKey,
  normalizeCacheTtl,
  resolveCacheKey,
  serializeCacheValue,
} from './contracts'
export type {
  CacheDependencyDescriptor,
  CacheDependencyIndex,
  CacheDriverContract,
  CacheDriverGetResult,
  CacheDriverPutInput,
  CacheErrorCode,
  CacheFacade,
  CacheFallback,
  CacheFallbackResolver,
  CacheFlexibleTtlInput,
  CacheKey,
  CacheKeyInput,
  CacheLockContract,
  CacheQueryBridge,
  CacheRepository,
  CacheRuntimeBindings,
  CacheTtlInput,
  CacheValueResolver,
  NormalizedCacheTtl,
} from './contracts'
export { cacheFacade, cacheFacadeInternals } from './facade'
export { cacheDbInternals } from './db'
export { fileDriverInternals } from './file'
export { cacheQueryBridgeInternals } from './query-bridge'
export { cacheRedisInternals } from './redis'
export {
  registerCacheDriverFactory,
  requireCacheDriverFactory,
  unregisterCacheDriverFactory,
  type CacheDriverFactory,
} from './driver-registry'
export type { DatabaseCacheDriverOptions } from './db'
export type { RedisCacheDriverOptions } from './redis'
export {
  cacheRuntimeInternals,
  getCacheRuntime,
  getCacheRuntimeBindings,
  loadCachePluginDrivers,
} from './runtime'
export {
  loadConfiguredCachePluginDriverContracts,
  loadCachePluginDriverContracts,
  resetCachePluginDriverContracts,
} from './plugins'

import {
  defineCacheKey,
  deserializeCacheValue,
  normalizeCacheTtl,
  serializeCacheValue,
} from './contracts'
import { cacheFacade, resetCacheFacadeRepositories } from './facade'
import {
  configureCacheRuntime as configureCacheRuntimeInternal,
  getCacheRuntime,
  getCacheRuntimeBindings,
  loadCachePluginDrivers,
  resetCacheRuntime as resetCacheRuntimeInternal,
} from './runtime'

export function configureCacheRuntime(...parameters: Parameters<typeof configureCacheRuntimeInternal>): void {
  configureCacheRuntimeInternal(...parameters)
}

export function resetCacheRuntime(): void {
  resetCacheRuntimeInternal()
  resetCacheFacadeRepositories()
}

const cache = Object.freeze({
  defineCacheKey,
  normalizeCacheTtl,
  serializeCacheValue,
  deserializeCacheValue,
  configureCacheRuntime,
  getCacheRuntime,
  getCacheRuntimeBindings,
  loadCachePluginDrivers,
  resetCacheRuntime,
  ...cacheFacade,
})

export default cache
