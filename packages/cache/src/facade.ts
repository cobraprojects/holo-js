import {
  resolveCacheKey,
  type CacheFacade,
  type CacheFallback,
  type CacheFallbackResolver,
  type CacheFlexibleTtlInput,
  type CacheKey,
  type CacheKeyInput,
  type CacheLockContract,
  type CacheRepository,
  type CacheTtlInput,
  type CacheValueResolver,
} from './contracts'
import {
  createFlexibleEnvelope,
  isFlexibleEnvelope,
  normalizeFlexibleTtl,
  resolveFlexibleCachedValue,
  type NormalizedFlexibleTtl,
} from './flexible'
import { cacheQueryBridgeInternals } from './query-bridge'
import { getCacheRuntime } from './runtime'
import {
  createCacheEntry,
  createCacheLock,
  forgetCacheEntry,
  readCacheEntry,
  readCachePayload,
  resolveDriverContext,
  resolveNormalizedKey,
  writeCacheEntry,
} from './entries'

const MAX_REFRESH_BLOCK_SECONDS = 30

function resolveFallback<TValue>(fallback: CacheFallback<TValue>): Promise<TValue> | TValue {
  return typeof fallback === 'function'
    ? (fallback as CacheFallbackResolver<TValue>)()
    : fallback
}

function resolveValue<TValue>(callback: CacheValueResolver<TValue>): Promise<Awaited<TValue>> {
  return Promise.resolve(callback()) as Promise<Awaited<TValue>>
}

function resolveDriverKey(
  driverName?: string,
): string {
  const normalized = driverName?.trim()
  return normalized || '__default__'
}

function createCacheRepository(driverName?: string): CacheRepository {
  function getCachedValue<TValue>(key: CacheKeyInput<TValue>) {
    return readCacheEntry(key, driverName)
  }

  async function putFlexibleEnvelope<TValue>(
    key: CacheKeyInput<TValue>,
    ttl: NormalizedFlexibleTtl,
    value: Awaited<TValue>,
  ): Promise<Awaited<TValue>> {
    const envelope = createFlexibleEnvelope(ttl, value)
    await writeCacheEntry(key, envelope, ttl.staleSeconds, driverName)
    return value
  }

  async function refreshFlexibleValue<TValue>(
    key: CacheKeyInput<TValue>,
    ttl: NormalizedFlexibleTtl,
    callback: CacheValueResolver<TValue>,
  ): Promise<Awaited<TValue>> {
    const value = await resolveValue(callback)
    return putFlexibleEnvelope(key, ttl, value)
  }

  function createRefreshLock<TValue>(key: CacheKeyInput<TValue>, staleSeconds: number): CacheLockContract {
    return repository.lock(`__flexible__:${resolveCacheKey(key)}`, Math.max(1, staleSeconds))
  }

  const repository: CacheRepository = Object.freeze({
    async get<TValue>(
      key: string | CacheKey<TValue>,
      fallback?: CacheFallback<TValue>,
    ): Promise<TValue | unknown | null> {
      const entry = await getCachedValue<TValue>(key)
      if (entry.hit) {
        return entry.value
      }

      if (typeof fallback === 'undefined') {
        return null
      }

      return await resolveFallback(fallback)
    },
    async put<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean> {
      return writeCacheEntry(key, value, ttl, driverName)
    },
    async add<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean> {
      const context = resolveDriverContext(driverName)
      return context.driver.add(createCacheEntry(context, key, value, ttl))
    },
    async forever<TValue>(key: CacheKeyInput<TValue>, value: TValue): Promise<boolean> {
      return writeCacheEntry(key, value, undefined, driverName)
    },
    async has(key: CacheKeyInput<unknown>): Promise<boolean> {
      return typeof await readCachePayload(key, driverName) === 'string'
    },
    async missing(key: CacheKeyInput<unknown>): Promise<boolean> {
      return !(await this.has(key))
    },
    async forget(key: CacheKeyInput<unknown>): Promise<boolean> {
      return forgetCacheEntry(key, driverName, getCacheRuntime().dependencyIndex)
    },
    async flush(): Promise<void> {
      const runtime = getCacheRuntime()
      const { driverName: configuredDriverName, driver } = resolveDriverContext(driverName)
      await driver.flush()
      const dependencyIndex = runtime.dependencyIndex
      if (!dependencyIndex) {
        return
      }

      const registeredKeys = await dependencyIndex.listRegisteredKeys()
      for (const indexedKey of registeredKeys) {
        if (cacheQueryBridgeInternals.parseIndexedKey(indexedKey).driverName === configuredDriverName) {
          await dependencyIndex.removeKey(indexedKey)
        }
      }
    },
    async increment(key: CacheKeyInput<number>, amount = 1): Promise<number> {
      const context = resolveDriverContext(driverName)
      return context.driver.increment(resolveNormalizedKey(context, key), amount)
    },
    async decrement(key: CacheKeyInput<number>, amount = 1): Promise<number> {
      const context = resolveDriverContext(driverName)
      return context.driver.decrement(resolveNormalizedKey(context, key), amount)
    },
    async remember<TValue>(
      key: CacheKeyInput<Awaited<TValue>>,
      ttl: CacheTtlInput,
      callback: CacheValueResolver<TValue>,
    ): Promise<Awaited<TValue>> {
      const cached = await getCachedValue<Awaited<TValue>>(key)
      if (cached.hit) {
        return cached.value
      }

      const value = await resolveValue(callback)
      await repository.put(key, value, ttl)
      return value
    },
    async rememberForever<TValue>(
      key: CacheKeyInput<Awaited<TValue>>,
      callback: CacheValueResolver<TValue>,
    ): Promise<Awaited<TValue>> {
      const cached = await getCachedValue<Awaited<TValue>>(key)
      if (cached.hit) {
        return cached.value
      }

      const value = await resolveValue(callback)
      await repository.forever(key, value)
      return value
    },
    async flexible<TValue>(
      key: CacheKeyInput<Awaited<TValue>>,
      ttl: CacheFlexibleTtlInput,
      callback: CacheValueResolver<TValue>,
    ): Promise<Awaited<TValue>> {
      return resolveFlexibleCachedValue<Awaited<TValue>>({
        ttl,
        read: async () => {
          const cached = await getCachedValue<unknown>(key)
          return cached.hit ? cached.value : undefined
        },
        refresh: normalizedTtl => refreshFlexibleValue(key, normalizedTtl, callback),
        createLock: normalizedTtl => createRefreshLock(key, normalizedTtl.staleSeconds),
        blockSeconds: normalizedTtl => Math.min(
          MAX_REFRESH_BLOCK_SECONDS,
          Math.max(1, Math.ceil(normalizedTtl.staleSeconds / 300)),
        ),
      })
    },
    lock(name: string, seconds: number): CacheLockContract {
      return createCacheLock(name, seconds, driverName)
    },
  })

  return repository
}

const repositories = new Map<string, CacheRepository>()

function getOrCreateRepository(driverName?: string): CacheRepository {
  const key = resolveDriverKey(driverName)
  const existing = repositories.get(key)
  if (existing) {
    return existing
  }

  const repository = createCacheRepository(driverName)
  repositories.set(key, repository)
  return repository
}

export function resetCacheFacadeRepositories(): void {
  repositories.clear()
}

const defaultRepository = getOrCreateRepository()

export const cacheFacade: CacheFacade = Object.freeze({
  ...defaultRepository,
  driver(name?: string): CacheRepository {
    return getOrCreateRepository(name)
  },
})

export const cacheFacadeInternals = {
  createRefreshLockName(key: string): string {
    return `__flexible__:${resolveCacheKey(key)}`
  },
  getOrCreateRepository,
  isFlexibleEnvelope,
  normalizeFlexibleTtl,
  resolveDriverKey,
  resolveFallback,
  resolveValue,
}
