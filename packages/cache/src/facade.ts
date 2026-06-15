import {
  deserializeCacheValue,
  normalizeCacheTtl,
  resolveCacheKey,
  serializeCacheValue,
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
import { cacheRuntimeInternals, getCacheRuntime } from './runtime'

type CachedValueLookup<TValue> =
  | {
      readonly hit: true
      readonly value: TValue
    }
  | {
      readonly hit: false
    }

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
  function resolveDriverContext() {
    const runtime = getCacheRuntime()
    const configuredDriverName = driverName?.trim() || runtime.config.default
    const driver = cacheRuntimeInternals.resolveConfiguredDriver(runtime, configuredDriverName)
    const config = runtime.config.drivers[configuredDriverName]
    return {
      configuredDriverName,
      driver,
      prefix: config?.prefix ?? runtime.config.prefix,
    }
  }

  function resolveNormalizedKey<TValue>(key: CacheKeyInput<TValue>): string {
    const { prefix } = resolveDriverContext()
    return `${prefix}${resolveCacheKey(key)}`
  }

  function resolveNormalizedLockName(name: string): string {
    const { prefix } = resolveDriverContext()
    return `${prefix}${resolveCacheKey(name)}`
  }

  async function getEntryPayload<TValue>(key: CacheKeyInput<TValue>): Promise<string | undefined> {
    const { driver } = resolveDriverContext()
    const entry = await driver.get(resolveNormalizedKey(key))
    return entry.hit ? entry.payload : undefined
  }

  async function putSerializedValue<TValue>(
    key: CacheKeyInput<TValue>,
    payload: string,
    ttl: CacheTtlInput,
  ): Promise<boolean> {
    const { driver } = resolveDriverContext()
    const normalizedTtl = normalizeCacheTtl(ttl)

    return driver.put({
      key: resolveNormalizedKey(key),
      payload,
      expiresAt: normalizedTtl.expiresAt,
    })
  }

  async function getCachedValue<TValue>(key: CacheKeyInput<TValue>): Promise<CachedValueLookup<TValue>> {
    const payload = await getEntryPayload(key)
    if (typeof payload !== 'string') {
      return Object.freeze({ hit: false })
    }

    return Object.freeze({
      hit: true,
      value: deserializeCacheValue<TValue>(payload),
    })
  }

  async function putFlexibleEnvelope<TValue>(
    key: CacheKeyInput<TValue>,
    ttl: NormalizedFlexibleTtl,
    value: Awaited<TValue>,
  ): Promise<Awaited<TValue>> {
    const envelope = createFlexibleEnvelope(ttl, value)
    await putSerializedValue(key, serializeCacheValue(envelope), ttl.staleSeconds)
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
      const payload = await getEntryPayload(key)
      if (typeof payload === 'string') {
        return deserializeCacheValue<TValue>(payload)
      }

      if (typeof fallback === 'undefined') {
        return null
      }

      return await resolveFallback(fallback)
    },
    async put<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean> {
      return putSerializedValue(key, serializeCacheValue(value), ttl)
    },
    async add<TValue>(key: CacheKeyInput<TValue>, value: TValue, ttl: CacheTtlInput): Promise<boolean> {
      const { driver } = resolveDriverContext()
      const normalizedTtl = normalizeCacheTtl(ttl)

      return driver.add({
        key: resolveNormalizedKey(key),
        payload: serializeCacheValue(value),
        expiresAt: normalizedTtl.expiresAt,
      })
    },
    async forever<TValue>(key: CacheKeyInput<TValue>, value: TValue): Promise<boolean> {
      const { driver } = resolveDriverContext()

      return driver.put({
        key: resolveNormalizedKey(key),
        payload: serializeCacheValue(value),
      })
    },
    async has(key: CacheKeyInput<unknown>): Promise<boolean> {
      return typeof await getEntryPayload(key) === 'string'
    },
    async missing(key: CacheKeyInput<unknown>): Promise<boolean> {
      return !(await this.has(key))
    },
    async forget(key: CacheKeyInput<unknown>): Promise<boolean> {
      const runtime = getCacheRuntime()
      const { configuredDriverName, driver } = resolveDriverContext()
      const forgotten = await driver.forget(resolveNormalizedKey(key))
      const dependencyIndex = runtime.dependencyIndex
      if (!dependencyIndex) {
        return forgotten
      }

      await dependencyIndex.removeKey(cacheQueryBridgeInternals.createIndexedKey(key, configuredDriverName))
      return forgotten
    },
    async flush(): Promise<void> {
      const runtime = getCacheRuntime()
      const { configuredDriverName, driver } = resolveDriverContext()
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
      const { driver } = resolveDriverContext()
      return driver.increment(resolveNormalizedKey(key), amount)
    },
    async decrement(key: CacheKeyInput<number>, amount = 1): Promise<number> {
      const { driver } = resolveDriverContext()
      return driver.decrement(resolveNormalizedKey(key), amount)
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
      const { driver } = resolveDriverContext()
      return driver.lock(resolveNormalizedLockName(name), seconds)
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
