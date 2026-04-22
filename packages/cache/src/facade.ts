import {
  CacheInvalidTtlError,
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
import { cacheQueryBridgeInternals } from './query-bridge'
import { cacheRuntimeInternals, getCacheRuntime } from './runtime'

type FlexibleEnvelope<TValue> = {
  readonly __holo_cache_flexible: true
  readonly value: TValue
  readonly freshUntil: number
  readonly staleUntil: number
}

type NormalizedFlexibleTtl = {
  readonly freshSeconds: number
  readonly staleSeconds: number
}

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

function normalizeFlexibleTtl(ttl: CacheFlexibleTtlInput): NormalizedFlexibleTtl {
  const freshSeconds = 'fresh' in ttl ? ttl.fresh : ttl[0]
  const staleSeconds = 'stale' in ttl ? ttl.stale : ttl[1]

  if (!Number.isInteger(freshSeconds) || freshSeconds < 0) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Flexible fresh TTL must be an integer greater than or equal to 0.')
  }

  if (!Number.isInteger(staleSeconds) || staleSeconds < freshSeconds) {
    throw new CacheInvalidTtlError('[@holo-js/cache] Flexible stale TTL must be an integer greater than or equal to the fresh TTL.')
  }

  return Object.freeze({
    freshSeconds,
    staleSeconds,
  })
}

function isFlexibleEnvelope<TValue>(value: unknown): value is FlexibleEnvelope<TValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const envelope = value as Partial<FlexibleEnvelope<TValue>>
  return envelope.__holo_cache_flexible === true
    && typeof envelope.freshUntil === 'number'
    && Number.isFinite(envelope.freshUntil)
    && typeof envelope.staleUntil === 'number'
    && Number.isFinite(envelope.staleUntil)
    && 'value' in envelope
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

  async function getCachedValue<TValue>(key: CacheKeyInput<TValue>): Promise<TValue | null> {
    const payload = await getEntryPayload(key)
    return typeof payload === 'string'
      ? deserializeCacheValue<TValue>(payload)
      : null
  }

  async function putFlexibleEnvelope<TValue>(
    key: CacheKeyInput<TValue>,
    ttl: NormalizedFlexibleTtl,
    value: Awaited<TValue>,
  ): Promise<Awaited<TValue>> {
    const now = Date.now()
    const envelope = {
      __holo_cache_flexible: true,
      value,
      freshUntil: now + (ttl.freshSeconds * 1000),
      staleUntil: now + (ttl.staleSeconds * 1000),
    } satisfies FlexibleEnvelope<TValue>

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
      if (cached !== null) {
        return cached
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
      if (cached !== null) {
        return cached
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
      const normalizedTtl = normalizeFlexibleTtl(ttl)
      const now = Date.now()
      const cached = await getCachedValue<unknown>(key)

      if (isFlexibleEnvelope<Awaited<TValue>>(cached)) {
        if (now <= cached.freshUntil) {
          return cached.value
        }

        if (now <= cached.staleUntil) {
          const refreshLock = createRefreshLock(key, normalizedTtl.staleSeconds)
          void refreshLock.get(async () => {
            await refreshFlexibleValue(key, normalizedTtl, callback)
            return true
          }).catch(() => undefined)

          return cached.value
        }
      }

      const refreshLock = createRefreshLock(key, normalizedTtl.staleSeconds)
      const refreshed = await refreshLock.block(
        Math.max(1, Math.ceil(normalizedTtl.staleSeconds / 300)),
        async () => refreshFlexibleValue(key, normalizedTtl, callback),
      )

      if (refreshed !== false) {
        return refreshed as Awaited<TValue>
      }

      const retried = await getCachedValue<unknown>(key)
      if (isFlexibleEnvelope<Awaited<TValue>>(retried)) {
        if (Date.now() <= retried.staleUntil) {
          return retried.value
        }
      }

      return refreshFlexibleValue(key, normalizedTtl, callback)
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
