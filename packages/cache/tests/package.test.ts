import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineCacheConfig, normalizeCacheConfig } from '@holo-js/config'
import { createFileCacheDriver } from '../src/file'
import cache, {
  CacheConfigError,
  cacheDbInternals,
  CacheDriverResolutionError,
  CacheInvalidNumericMutationError,
  CacheInvalidTtlError,
  CacheLockAcquisitionError,
  CacheOptionalPackageError,
  CacheQueryIntegrationError,
  CacheRuntimeNotConfiguredError,
  CacheSerializationError,
  cacheContractsInternals,
  cacheFacade,
  cacheFacadeInternals,
  cacheQueryBridgeInternals,
  cacheRedisInternals,
  fileDriverInternals,
  cacheRuntimeInternals,
  configureCacheRuntime,
  defineCacheKey,
  deserializeCacheValue,
  getCacheRuntime,
  getCacheRuntimeBindings,
  isCacheKey,
  normalizeCacheTtl,
  resetCacheRuntime,
  resolveCacheKey,
  serializeCacheValue,
} from '../src'

const typedThemeKey = defineCacheKey<'light' | 'dark'>('theme.current')

async function createTempCacheDirectory(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `holo-cache-${name}-`))
}

describe('@holo-js/cache package surface', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetCacheRuntime()
    cacheDbInternals.resetDatabaseDriverModuleLoader()
    cacheRedisInternals.resetRedisDriverModuleLoader()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetCacheRuntime()
    cacheDbInternals.resetDatabaseDriverModuleLoader()
    cacheRedisInternals.resetRedisDriverModuleLoader()
  })

  it('re-exports defineCacheConfig and cache key helpers', () => {
    const config = defineCacheConfig({
      default: 'memory',
      drivers: {
        memory: {
          driver: 'memory',
        },
      },
    })
    const key = defineCacheKey<number>(' users.count ')

    expect(Object.isFrozen(config)).toBe(true)
    expect(isCacheKey(key)).toBe(true)
    expect(resolveCacheKey(key)).toBe('users.count')
    expect(resolveCacheKey(' users.count ')).toBe('users.count')
    expect(() => defineCacheKey('   ')).toThrow(CacheConfigError)
  })

  it('normalizes ttl values from seconds and dates', () => {
    expect(normalizeCacheTtl(60, { now: 1_000 })).toEqual({
      seconds: 60,
      expiresAt: 61_000,
      isExpired: false,
    })

    expect(normalizeCacheTtl(new Date(2_000), { now: 1_000 })).toEqual({
      seconds: 1,
      expiresAt: 2_000,
      isExpired: false,
    })
    expect(normalizeCacheTtl(1, { now: new Date(1_000) }).expiresAt).toBe(2_000)

    expect(() => normalizeCacheTtl(-1)).toThrow(CacheInvalidTtlError)
    expect(() => normalizeCacheTtl(0)).toThrow('Cache TTL seconds must be > 0 or use a Date/forever option.')
    expect(() => normalizeCacheTtl(1.5)).toThrow(CacheInvalidTtlError)
    expect(() => normalizeCacheTtl(new Date('invalid'))).toThrow(CacheInvalidTtlError)
  })

  it('serializes plain JSON-safe values and dates without losing shape', () => {
    const createdAt = new Date('2026-04-21T00:00:00.000Z')
    const payload = {
      total: 2,
      createdAt,
      nested: {
        active: true,
        values: [1, null, 'ok'],
      },
    }

    const serialized = serializeCacheValue(payload)
    const restored = deserializeCacheValue<typeof payload>(serialized)

    expect(restored).toEqual(payload)
    expect(restored.createdAt).toBeInstanceOf(Date)
  })

  it('rejects unsupported serialized value shapes and malformed payloads', () => {
    expect(() => serializeCacheValue({
      run() {
        return true
      },
    })).toThrow(CacheSerializationError)

    expect(() => serializeCacheValue({
      value: undefined,
    })).toThrow(CacheSerializationError)
    expect(() => serializeCacheValue({
      __holo_cache_type: 'date',
    })).toThrow('uses a reserved key')
    expect(() => serializeCacheValue(Number.NaN)).toThrow(CacheSerializationError)
    expect(() => serializeCacheValue(new Date('invalid'))).toThrow(CacheSerializationError)

    const sparse = [] as unknown[]
    sparse[1] = 'value'
    expect(() => serializeCacheValue(sparse)).toThrow(CacheSerializationError)

    expect(() => deserializeCacheValue('{oops')).toThrow(CacheSerializationError)
    expect(() => deserializeCacheValue('{"__holo_cache_type":"date"}')).toThrow(CacheSerializationError)
    expect(() => deserializeCacheValue('{"__holo_cache_type":"date","value":"nope"}')).toThrow(CacheSerializationError)
    expect(() => cacheContractsInternals.decodeCacheValue(Symbol('bad'), '$')).toThrow(CacheSerializationError)
    expect(cacheContractsInternals.isPlainObject(Object.create(null) as Record<string, unknown>)).toBe(true)
  })

  it('normalizes runtime config and exposes resettable seams', async () => {
    const originalDependencyIndex = cacheQueryBridgeInternals.getOrCreateDependencyIndex()

    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
            prefix: 'runtime:',
            maxEntries: 2,
          },
        },
      },
    })

    expect(getCacheRuntime().config.default).toBe('memory')
    expect(getCacheRuntime().config.drivers.memory!.prefix).toBe('runtime:')
    expect(cacheRuntimeInternals.isNormalizedCacheConfig(getCacheRuntime().config)).toBe(true)

    await cache.put('alpha', 'one', 60)
    expect(await cache.get('alpha')).toBe('one')

    resetCacheRuntime()
    expect(getCacheRuntimeBindings()).toBeUndefined()
    expect(() => getCacheRuntime()).toThrow(CacheRuntimeNotConfiguredError)
    await expect(cache.get('alpha')).rejects.toThrow(CacheRuntimeNotConfiguredError)

    configureCacheRuntime(undefined)
    expect(getCacheRuntimeBindings()).toBeUndefined()
    expect(cacheQueryBridgeInternals.getOrCreateDependencyIndex()).not.toBe(originalDependencyIndex)
  })

  it('accepts normalized config objects and custom driver maps', async () => {
    const normalizedConfig = defineCacheConfig({
      default: 'memory',
      prefix: 'runtime:',
      drivers: {
        memory: {
          driver: 'memory',
        },
      },
    })

    const injectedDriver = {
      name: 'custom',
      driver: 'memory',
      async get(key: string) {
        return Object.freeze({
          hit: key === 'runtime:outside' || key === 'outside',
          payload: '"custom"',
        })
      },
      async put() {
        return true
      },
      async add() {
        return true
      },
      async forget() {
        return true
      },
      async flush() {},
      async increment(_key: string, amount: number) {
        return amount
      },
      async decrement(_key: string, amount: number) {
        return -amount
      },
      lock(name: string) {
        return {
          name,
          async get() {
            return true
          },
          async release() {
            return true
          },
          async block() {
            return true
          },
        }
      },
    }

    configureCacheRuntime({
      config: normalizedConfig,
      drivers: new Map([
        ['custom', injectedDriver],
      ]),
    })

    expect(cacheRuntimeInternals.normalizeRuntimeConfig(normalizeCacheConfig(normalizedConfig))).toMatchObject({
      default: 'memory',
      prefix: 'runtime:',
    })
    expect(await cache.driver('custom').get('outside')).toBe('custom')
    expect(cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'custom')).toBe(injectedDriver)
  })

  it('supports memory driver reads, writes, fallbacks, and key-specific typing', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    expect(await cache.get('missing')).toBeNull()
    expect(await cache.get('missing', 'fallback')).toBe('fallback')
    expect(await cache.get('missing', async () => 'lazy')).toBe('lazy')

    await cache.put(typedThemeKey, 'dark', 60)

    expect(await cache.get(typedThemeKey)).toBe('dark')
    expect(await cache.get(typedThemeKey, 'light')).toBe('dark')
    expect(await cache.has(typedThemeKey)).toBe(true)
    expect(await cache.missing('missing')).toBe(true)
  })

  it('applies per-driver prefixes and exposes named repositories', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'global:',
        drivers: {
          memory: {
            driver: 'memory',
            prefix: 'default:',
          },
          isolated: {
            driver: 'memory',
            prefix: 'isolated:',
          },
        },
      },
    })

    const defaultDriver = cache.driver()
    const isolatedDriver = cache.driver('isolated')

    await defaultDriver.put('shared', 'default', 60)
    await isolatedDriver.put('shared', 'isolated', 60)

    const runtime = getCacheRuntime()
    const defaultStore = cacheRuntimeInternals.resolveConfiguredDriver(runtime)
    const isolatedStore = cacheRuntimeInternals.resolveConfiguredDriver(runtime, 'isolated')

    expect(await defaultStore.get('default:shared')).toMatchObject({ hit: true, payload: '"default"' })
    expect(await isolatedStore.get('isolated:shared')).toMatchObject({ hit: true, payload: '"isolated"' })
    expect(await cache.get('shared')).toBe('default')
    expect(await isolatedDriver.get('shared')).toBe('isolated')
    expect(cacheFacade.driver('isolated')).toBe(isolatedDriver)
    expect(cacheFacadeInternals.resolveDriverKey()).toBe('__default__')
    expect(cacheFacadeInternals.resolveDriverKey(' isolated ')).toBe('isolated')
    expect(await cacheFacadeInternals.resolveFallback(async () => 'fallback')).toBe('fallback')
  })

  it('supports add, forever, forget, and flush semantics', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
          secondary: {
            driver: 'memory',
          },
        },
      },
    })

    expect(await cache.add('alpha', 1, 60)).toBe(true)
    expect(await cache.add('alpha', 2, 60)).toBe(false)

    expect(await cache.forever('persisted', { ok: true })).toBe(true)
    expect(await cache.get('persisted')).toEqual({ ok: true })

    expect(await cache.forget('alpha')).toBe(true)
    expect(await cache.forget('alpha')).toBe(false)

    await cache.driver('secondary').put('other', 'value', 60)
    await cache.flush()
    expect(await cache.get('persisted')).toBeNull()
    expect(await cache.driver('secondary').get('other')).toBe('value')

    await cache.driver('secondary').flush()
    expect(await cache.driver('secondary').get('other')).toBeNull()
  })

  it('supports remember and rememberForever with exact callback results', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    let rememberCalls = 0
    await expect(cache.remember('failing', 60, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await cache.get('failing')).toBeNull()

    const firstRemember = await cache.remember('report', 1, async () => {
      rememberCalls += 1
      return {
        version: rememberCalls,
      }
    })

    const secondRemember = await cache.remember('report', 1, async () => {
      rememberCalls += 1
      return {
        version: rememberCalls,
      }
    })

    vi.advanceTimersByTime(1_001)
    const thirdRemember = await cache.remember('report', 1, async () => {
      rememberCalls += 1
      return {
        version: rememberCalls,
      }
    })

    let foreverCalls = 0
    const firstForever = await cache.rememberForever('forever', async () => {
      foreverCalls += 1
      return {
        version: foreverCalls,
      }
    })
    const secondForever = await cache.rememberForever('forever', async () => {
      foreverCalls += 1
      return {
        version: foreverCalls,
      }
    })

    expect(firstRemember).toEqual({ version: 1 })
    expect(secondRemember).toEqual({ version: 1 })
    expect(thirdRemember).toEqual({ version: 2 })
    expect(firstForever).toEqual({ version: 1 })
    expect(secondForever).toEqual({ version: 1 })
    expect(rememberCalls).toBe(2)
    expect(foreverCalls).toBe(1)
  })

  it('supports flexible stale-while-revalidate and lock contention', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    let refreshCalls = 0
    const firstValue = await cache.flexible('homepage.posts', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    vi.advanceTimersByTime(30_000)
    const freshValue = await cache.flexible('homepage.posts', { fresh: 60, stale: 300 }, async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    vi.advanceTimersByTime(31_000)
    const staleLock = cache.lock(cacheFacadeInternals.createRefreshLockName('homepage.posts'), 10)
    expect(await staleLock.get()).toBe(true)

    const staleValue = await cache.flexible('homepage.posts', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    await Promise.resolve()
    expect(refreshCalls).toBe(1)
    expect(await staleLock.release()).toBe(true)

    const staleRefreshValue = await cache.flexible('homepage.posts', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    await Promise.resolve()
    await Promise.resolve()

    const refreshedValue = await cache.flexible('homepage.posts', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    vi.advanceTimersByTime(301_000)
    const expiredValue = await cache.flexible('homepage.posts', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })

    const blockedRefreshLock = cache.lock(cacheFacadeInternals.createRefreshLockName('blocked.flexible'), 2)
    expect(await blockedRefreshLock.get()).toBe(true)
    const blockedValuePromise = cache.flexible('blocked.flexible', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })
    await vi.advanceTimersByTimeAsync(1_001)
    const blockedValue = await blockedValuePromise

    const retriedRefreshLock = cache.lock(cacheFacadeInternals.createRefreshLockName('retried.flexible'), 2)
    expect(await retriedRefreshLock.get()).toBe(true)
    setTimeout(() => {
      void cache.put('retried.flexible', {
        __holo_cache_flexible: true,
        value: {
          version: 99,
        },
        freshUntil: Date.now() + 60_000,
        staleUntil: Date.now() + 300_000,
      }, 300)
    }, 500)
    const retriedValuePromise = cache.flexible('retried.flexible', [60, 300], async () => {
      refreshCalls += 1
      return {
        version: refreshCalls,
      }
    })
    await vi.advanceTimersByTimeAsync(1_001)
    const retriedValue = await retriedValuePromise

    expect(firstValue).toEqual({ version: 1 })
    expect(freshValue).toEqual({ version: 1 })
    expect(staleValue).toEqual({ version: 1 })
    expect(staleRefreshValue).toEqual({ version: 1 })
    expect(refreshedValue).toEqual({ version: 2 })
    expect(expiredValue).toEqual({ version: 3 })
    expect(blockedValue).toEqual({ version: 4 })
    expect(retriedValue).toEqual({ version: 99 })
    expect(refreshCalls).toBe(4)
    expect(cacheFacadeInternals.isFlexibleEnvelope({
      __holo_cache_flexible: true,
      value: 1,
      freshUntil: 1,
      staleUntil: 2,
    })).toBe(true)
    expect(cacheFacadeInternals.isFlexibleEnvelope({ value: 1 })).toBe(false)
    expect(cacheFacadeInternals.normalizeFlexibleTtl([10, 20])).toEqual({
      freshSeconds: 10,
      staleSeconds: 20,
    })
    expect(() => cacheFacadeInternals.normalizeFlexibleTtl([20, 10])).toThrow(CacheInvalidTtlError)
    expect(() => cacheFacadeInternals.normalizeFlexibleTtl({ fresh: -1, stale: 10 })).toThrow(CacheInvalidTtlError)
  })

  it('exposes the public lock api with callback return values and timeout behavior', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    expect(await cache.lock('report', 1).get(async () => 'locked')).toBe('locked')

    const heldLock = cache.lock('busy', 1)
    expect(await heldLock.get()).toBe(true)
    await expect(cache.lock('busy', 1).block(0)).resolves.toBe(false)
    expect(await heldLock.release()).toBe(true)
  })

  it('expires entries deterministically and resets process-local state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    await cache.put('short', 'ttl', 1)
    expect(await cache.get('short')).toBe('ttl')

    vi.advanceTimersByTime(1_001)
    expect(await cache.get('short')).toBeNull()

    await cache.put('leaks', 'no', 60)
    resetCacheRuntime()
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    expect(await cache.get('leaks')).toBeNull()
  })

  it('supports numeric mutations and rejects non-numeric values', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    expect(await cache.increment('counter')).toBe(1)
    expect(await cache.increment('counter', 4)).toBe(5)
    expect(await cache.decrement('counter', 2)).toBe(3)
    expect(await cache.decrement('missing', 2)).toBe(-2)

    await cache.forever('label', 'not-a-number')
    await expect(cache.increment('label')).rejects.toThrow(CacheInvalidNumericMutationError)
  })

  it('evicts oldest memory entries when maxEntries is reached', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
            maxEntries: 2,
          },
        },
      },
    })

    await cache.put('first', 1, 60)
    await cache.put('second', 2, 60)
    await cache.put('third', 3, 60)

    expect(await cache.get('first')).toBeNull()
    expect(await cache.get('second')).toBe(2)
    expect(await cache.get('third')).toBe(3)
  })

  it('prunes expired entries before max-entry eviction', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
            maxEntries: 2,
          },
        },
      },
    })

    await cache.put('expired', 1, 1)
    vi.advanceTimersByTime(1_001)
    await cache.put('second', 2, 60)
    await cache.put('third', 3, 60)

    expect(await cache.get('expired')).toBeNull()
    expect(await cache.get('second')).toBe(2)
    expect(await cache.get('third')).toBe(3)
  })

  it('provides internal memory lock behavior for later facade phases', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    const runtime = getCacheRuntime()
    const driver = cacheRuntimeInternals.resolveConfiguredDriver(runtime)
    const firstLock = driver.lock('build-report', 1)
    const secondLock = driver.lock('build-report', 1)

    expect(await firstLock.get()).toBe(true)
    expect(await secondLock.get()).toBe(false)
    expect(await firstLock.release()).toBe(true)
    expect(await secondLock.get(async () => 'fresh')).toBe('fresh')
    expect(await secondLock.release()).toBe(false)

    const blockingLock = driver.lock('blocking', 0.02)
    expect(await blockingLock.get()).toBe(true)

    const waitPromise = driver.lock('blocking', 0.02).block(0.1, async () => 'after-wait')
    await expect(waitPromise).resolves.toBe('after-wait')

    const heldLock = driver.lock('held', 1)
    expect(await heldLock.get()).toBe(true)
    await expect(driver.lock('held', 1).block(0)).resolves.toBe(false)
  })

  it('supports file driver reads, writes, expiration, forever values, and deletes', async () => {
    const cachePath = await createTempCacheDirectory('file-basic')

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

      configureCacheRuntime({
        config: {
          default: 'file',
          drivers: {
            file: {
              driver: 'file',
              path: cachePath,
            },
          },
        },
      })

      await cache.put('alpha', { ok: true }, 60)
      expect(await cache.get('alpha')).toEqual({ ok: true })
      expect(await cache.add('alpha', { ok: false }, 60)).toBe(false)
      expect(await cache.add('beta', { ok: 'fresh' }, 60)).toBe(true)
      expect(await cache.get('beta')).toEqual({ ok: 'fresh' })

      await cache.forever('persisted', 'value')
      expect(await cache.get('persisted')).toBe('value')

      await cache.put('short', 'ttl', 1)
      vi.advanceTimersByTime(1_001)
      expect(await cache.get('short')).toBeNull()

      expect(await cache.forget('alpha')).toBe(true)
      expect(await cache.get('alpha')).toBeNull()
    } finally {
      vi.useRealTimers()
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('uses deterministic hashed file paths and cleans malformed entries on read', async () => {
    const cachePath = await createTempCacheDirectory('file-hash')

    try {
      expect(fileDriverInternals.isFileCacheEntryEnvelope({ key: 'ok', payload: '"value"' })).toBe(true)
      expect(fileDriverInternals.isFileCacheEntryEnvelope(null)).toBe(false)
      expect(fileDriverInternals.isFileCacheLockEnvelope({ name: 'ok', owner: 'test', expiresAt: Date.now() })).toBe(true)
      expect(fileDriverInternals.isFileCacheLockEnvelope(null)).toBe(false)

      configureCacheRuntime({
        config: {
          default: 'file',
          drivers: {
            file: {
              driver: 'file',
              path: cachePath,
            },
          },
        },
      })

      await cache.put('user.profile', { name: 'Cobra' }, 60)

      const entryFilePath = fileDriverInternals.resolveEntryFilePath(cachePath, 'user.profile')
      const hashedFileName = fileDriverInternals.hashCacheKey('user.profile')
      const rawEntry = await readFile(entryFilePath, 'utf8')

      expect(entryFilePath).toContain(join('entries', hashedFileName.slice(0, 2)))
      expect(entryFilePath).toContain(`${hashedFileName}.json`)
      expect(entryFilePath).not.toContain('user.profile')
      expect(rawEntry).toContain('"key":"user.profile"')

      await writeFile(entryFilePath, '{"broken"', 'utf8')
      expect(await cache.get('user.profile')).toBeNull()
      await expect(readFile(entryFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('treats ENOTDIR file-driver reads as missing entries', async () => {
    const cachePath = await createTempCacheDirectory('file-enotdir')

    try {
      await writeFile(join(cachePath, 'entries'), 'blocked', 'utf8')

      configureCacheRuntime({
        config: {
          default: 'file',
          drivers: {
            file: {
              driver: 'file',
              path: cachePath,
            },
          },
        },
      })

      expect(await cache.get('missing')).toBeNull()
    } finally {
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('covers direct file-driver sleep and unexpected read errors', async () => {
    const cachePath = await createTempCacheDirectory('file-direct')

    try {
      let now = 0
      const driver = createFileCacheDriver({
        name: 'file',
        path: cachePath,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds
        },
      })

      const delayedLock = driver.lock('slow', 0.02)
      expect(await delayedLock.get()).toBe(true)
      await expect(driver.lock('slow', 0.02).block(0.01)).resolves.toBe(false)

      const defaultSleepDriver = createFileCacheDriver({
        name: 'file',
        path: cachePath,
      })
      const longLock = defaultSleepDriver.lock('slow-default', 1)
      expect(await longLock.get()).toBe(true)
      await expect(defaultSleepDriver.lock('slow-default', 0.02).block(0.01)).resolves.toBe(false)

      const entryFilePath = fileDriverInternals.resolveEntryFilePath(cachePath, 'directory-error')
      await mkdir(entryFilePath, { recursive: true })

      await expect(driver.get('directory-error')).rejects.toMatchObject({ code: 'EISDIR' })
    } finally {
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('isolates file driver flush behavior by configured path', async () => {
    const firstPath = await createTempCacheDirectory('file-flush-a')
    const secondPath = await createTempCacheDirectory('file-flush-b')

    try {
      configureCacheRuntime({
        config: {
          default: 'primary',
          drivers: {
            primary: {
              driver: 'file',
              path: firstPath,
            },
            secondary: {
              driver: 'file',
              path: secondPath,
            },
          },
        },
      })

      await cache.put('shared', 'first', 60)
      await cache.driver('secondary').put('shared', 'second', 60)

      await cache.flush()

      expect(await cache.get('shared')).toBeNull()
      expect(await cache.driver('secondary').get('shared')).toBe('second')
    } finally {
      await rm(firstPath, { recursive: true, force: true })
      await rm(secondPath, { recursive: true, force: true })
    }
  })

  it('preserves differently prefixed file entries when flushing a shared path', async () => {
    const cachePath = await createTempCacheDirectory('file-shared-prefix')

    try {
      const primary = createFileCacheDriver({
        name: 'primary',
        path: cachePath,
        prefix: 'primary:',
      })
      const secondary = createFileCacheDriver({
        name: 'secondary',
        path: cachePath,
        prefix: 'secondary:',
      })

      await primary.put({
        key: 'primary:shared',
        payload: '"first"',
        expiresAt: Date.now() + 60_000,
      })
      await secondary.put({
        key: 'secondary:shared',
        payload: '"second"',
        expiresAt: Date.now() + 60_000,
      })

      await primary.flush()

      expect(await primary.get('primary:shared')).toEqual({ hit: false })
      expect(await secondary.get('secondary:shared')).toEqual({
        hit: true,
        payload: '"second"',
        expiresAt: expect.any(Number),
      })
    } finally {
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('ignores malformed shared-path files while flushing a prefixed file driver', async () => {
    const cachePath = await createTempCacheDirectory('file-shared-malformed')

    try {
      const primary = createFileCacheDriver({
        name: 'primary',
        path: cachePath,
        prefix: 'primary:',
      })
      const secondary = createFileCacheDriver({
        name: 'secondary',
        path: cachePath,
        prefix: 'secondary:',
      })

      await primary.put({
        key: 'primary:shared',
        payload: '"first"',
        expiresAt: Date.now() + 60_000,
      })
      await secondary.put({
        key: 'secondary:shared',
        payload: '"second"',
        expiresAt: Date.now() + 60_000,
      })
      await mkdir(join(cachePath, 'entries', 'ff'), { recursive: true })
      await writeFile(join(cachePath, 'entries', 'ff', 'broken.json'), '{not-json', 'utf8')

      await primary.flush()

      expect(await secondary.get('secondary:shared')).toEqual({
        hit: true,
        payload: '"second"',
        expiresAt: expect.any(Number),
      })
    } finally {
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('surfaces non-directory traversal errors while flushing a prefixed file driver', async () => {
    const parentDirectory = await createTempCacheDirectory('file-flush-enotdir')
    const cachePath = join(parentDirectory, 'cache-root')

    try {
      await writeFile(cachePath, 'not-a-directory', 'utf8')

      const driver = createFileCacheDriver({
        name: 'primary',
        path: cachePath,
        prefix: 'primary:',
      })

      await expect(driver.flush()).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(parentDirectory, { recursive: true, force: true })
    }
  })

  it('supports file locks, expiration recovery, and numeric mutation', async () => {
    const cachePath = await createTempCacheDirectory('file-locks')

    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-04-21T00:00:00.000Z'))

      configureCacheRuntime({
        config: {
          default: 'file',
          drivers: {
            file: {
              driver: 'file',
              path: cachePath,
            },
          },
        },
      })

      const runtime = getCacheRuntime()
      const driver = cacheRuntimeInternals.resolveConfiguredDriver(runtime)
      const firstLock = driver.lock('report', 1)
      const secondLock = driver.lock('report', 1)

      expect(await firstLock.get()).toBe(true)
      expect(await secondLock.get()).toBe(false)
      expect(await secondLock.release()).toBe(false)
      expect(await firstLock.release()).toBe(true)

      const staleLockPath = fileDriverInternals.resolveLockFilePath(cachePath, 'report')
      await mkdir(dirname(staleLockPath), { recursive: true })
      await writeFile(staleLockPath, JSON.stringify({
        name: 'report',
        owner: 'stale-owner',
        expiresAt: Date.now() + 1_000,
      }), 'utf8')

      vi.advanceTimersByTime(1_001)
      expect(await secondLock.get(async () => 'recovered')).toBe('recovered')

      const malformedLock = driver.lock('malformed', 1)
      const malformedLockPath = fileDriverInternals.resolveLockFilePath(cachePath, 'malformed')
      await mkdir(dirname(malformedLockPath), { recursive: true })
      await writeFile(malformedLockPath, '{"broken"', 'utf8')
      expect(await malformedLock.get(async () => 'after-cleanup')).toBe('after-cleanup')

      const blockingLock = driver.lock('blocking', 0.02)
      expect(await blockingLock.get()).toBe(true)
      const delayedAcquire = driver.lock('blocking', 0.02).block(0.05, async () => 'after-expiry')
      await vi.advanceTimersByTimeAsync(25)
      await expect(delayedAcquire).resolves.toBe('after-expiry')

      const heldNumericLock = driver.lock('__numeric__:blocked', 5)
      expect(await heldNumericLock.get()).toBe(true)
      const blockedIncrement = driver.increment('blocked', 1)
      await vi.advanceTimersByTimeAsync(2_001)
      await expect(blockedIncrement).rejects.toThrow(CacheLockAcquisitionError)

      expect(await cache.increment('counter')).toBe(1)
      expect(await cache.decrement('counter', 2)).toBe(-1)

      await cache.forever('label', 'nope')
      await expect(cache.increment('label')).rejects.toThrow(CacheInvalidNumericMutationError)
    } finally {
      vi.useRealTimers()
      await rm(cachePath, { recursive: true, force: true })
    }
  })

  it('throws clear resolution errors for unsupported or missing drivers', async () => {
    expect(cacheRuntimeInternals.normalizeRuntimeConfig(undefined).default).toBe('file')

    configureCacheRuntime({
      config: {},
    })

    expect(getCacheRuntime().config.default).toBe('file')
    expect(cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime()).driver).toBe('file')
    expect(await cache.forget('missing')).toBe(false)

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
          },
        },
      },
    })

    await expect(cache.get('value')).rejects.toThrow(CacheDriverResolutionError)

    configureCacheRuntime({
      config: {
        default: 'memory',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    await expect(cache.driver('missing').get('value')).rejects.toThrow(CacheDriverResolutionError)
  })

  it('lazy-loads redis drivers through shared redis config resolution', async () => {
    const values = new Map<string, string>()
    const createRedisCacheDriver = vi.fn((options: {
      readonly name: string
      readonly connectionName: string
      readonly prefix: string
      readonly redis: {
        readonly url?: string
        readonly host: string
        readonly port: number
        readonly db: number
      }
    }) => {
      expect(options.connectionName).toBe('cache')
      expect(options.prefix).toBe('holo:cache:')
      expect(options.redis.url).toBe('redis://cache.internal:6380/0')

      return {
        name: options.name,
        driver: 'redis' as const,
        async get(key: string) {
          return values.has(key)
            ? Object.freeze({
                hit: true,
                payload: values.get(key),
              })
            : Object.freeze({
                hit: false,
              })
        },
        async put(input: { key: string, payload: string }) {
          values.set(input.key, input.payload)
          return true
        },
        async add(input: { key: string, payload: string }) {
          if (values.has(input.key)) {
            return false
          }

          values.set(input.key, input.payload)
          return true
        },
        async forget(key: string) {
          return values.delete(key)
        },
        async flush() {
          values.clear()
        },
        async increment() {
          return 1
        },
        async decrement() {
          return -1
        },
        lock(name: string) {
          return {
            name,
            async get<TValue>(callback?: () => TValue | Promise<TValue>) {
              return callback ? callback() : true
            },
            async release() {
              return true
            },
            async block<TValue>(_waitSeconds: number, callback?: () => TValue | Promise<TValue>) {
              return callback ? callback() : true
            },
          }
        },
      }
    })

    cacheRedisInternals.setRedisDriverModuleLoader(async () => ({
      createRedisCacheDriver,
    }))

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            connection: 'cache',
            prefix: 'holo:cache:',
          },
        },
      },
      redisConfig: {
        default: 'cache',
        connections: {
          cache: {
            url: 'redis://cache.internal:6380/0',
          },
        },
      },
    })

    await cache.put('alpha', 'one', 60)
    expect(await cache.get('alpha')).toBe('one')
    expect(await cache.add('beta', 'two', 60)).toBe(true)
    expect(await cache.decrement('counter', 2)).toBe(-1)
    expect(await cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime()).increment('counter', 2)).toBe(1)
    expect(await cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime()).decrement('counter', 2)).toBe(-1)
    expect(await cache.forget('beta')).toBe(true)
    await cache.flush()
    const lock = cache.lock('report', 1)
    expect(await lock.get()).toBe(true)
    expect(await lock.release()).toBe(true)
    await expect(cache.lock('report', 1).block(0)).resolves.toBe(true)
    expect(createRedisCacheDriver).toHaveBeenCalledTimes(1)
    expect(cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime()).driver).toBe('redis')
  })

  it('throws a clear error when redis cache support is configured without the optional package', async () => {
    cacheRedisInternals.setRedisDriverModuleLoader(async () => {
      throw cacheRedisInternals.normalizeRedisModuleLoadError({
        code: 'ERR_MODULE_NOT_FOUND',
      })
    })

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            connection: 'cache',
          },
        },
      },
      redisConfig: {
        default: 'cache',
        connections: {
          cache: {
            host: '127.0.0.1',
            port: 6379,
          },
        },
      },
    })

    await expect(cache.get('missing')).rejects.toThrow(CacheOptionalPackageError)
  })

  it('lazy-loads database drivers through shared database config resolution', async () => {
    const values = new Map<string, string>()
    const lockFactory = vi.fn((name: string) => ({
      name,
      async get<TValue>(callback?: () => TValue | Promise<TValue>) {
        return callback ? callback() : true
      },
      async release() {
        return true
      },
      async block<TValue>(_: number, callback?: () => TValue | Promise<TValue>) {
        return callback ? callback() : true
      },
    }))
    const createDatabaseCacheDriver = vi.fn((options: {
      readonly name: string
      readonly connectionName: string
      readonly table: string
      readonly lockTable: string
      readonly connection: { readonly filename?: string } | string
    }) => {
      expect(options.connectionName).toBe('main')
      expect(options.table).toBe('cache_entries')
      expect(options.lockTable).toBe('cache_entry_locks')
      expect(typeof options.connection).toBe('object')

      return {
        name: options.name,
        driver: 'database' as const,
        async get(key: string) {
          return values.has(key)
            ? Object.freeze({
                hit: true,
                payload: values.get(key),
              })
            : Object.freeze({ hit: false })
        },
        async put(input: { key: string, payload: string }) {
          values.set(input.key, input.payload)
          return true
        },
        async add(input: { key: string, payload: string }) {
          if (values.has(input.key)) {
            return false
          }

          values.set(input.key, input.payload)
          return true
        },
        async forget(key: string) {
          return values.delete(key)
        },
        async flush() {
          values.clear()
        },
        async increment() {
          return 1
        },
        async decrement() {
          return -1
        },
        lock(name: string) {
          return lockFactory(name)
        },
      }
    })

    cacheDbInternals.setDatabaseDriverModuleLoader(async () => ({
      createDatabaseCacheDriver,
    }))

    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
            connection: 'main',
            table: 'cache_entries',
            lockTable: 'cache_entry_locks',
          },
        },
      },
      databaseConfig: {
        defaultConnection: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            filename: ':memory:',
          },
        },
      },
    })

    await cache.put('alpha', 'one', 60)
    expect(await cache.get('alpha')).toBe('one')
    expect(await cache.add('beta', 'two', 60)).toBe(true)
    expect(await cache.forget('beta')).toBe(true)
    await expect(cache.flush()).resolves.toBeUndefined()
    expect(await cache.increment('alpha', 2)).toBe(1)
    expect(await cache.decrement('alpha', 1)).toBe(-1)
    const lock = cache.lock('reports', 1)
    expect(await lock.get(async () => 'locked')).toBe('locked')
    expect(await lock.release()).toBe(true)
    expect(await lock.block(1, async () => 'blocked')).toBe('blocked')
    expect(createDatabaseCacheDriver).toHaveBeenCalledTimes(1)
    expect(lockFactory).toHaveBeenCalledTimes(1)
    expect(cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime()).driver).toBe('database')
  })

  it('throws a clear error when database cache support is configured without the optional package', async () => {
    cacheDbInternals.setDatabaseDriverModuleLoader(async () => {
      throw cacheDbInternals.normalizeDatabaseModuleLoadError({
        code: 'ERR_MODULE_NOT_FOUND',
        message: 'Cannot find package \'@holo-js/cache-db\' imported from /tmp/cache-loader.mjs',
      })
    })

    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
            connection: 'main',
          },
        },
      },
      databaseConfig: {
        defaultConnection: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            filename: ':memory:',
          },
        },
      },
    })

    await expect(cache.get('missing')).rejects.toThrow(CacheOptionalPackageError)
  })

  it('requires database cache drivers to resolve named connections from config/database.ts', () => {
    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
            connection: 'main',
          },
        },
      },
    })

    expect(() => cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'database')).toThrow(
      'requires a top-level database config from config/database.ts',
    )

    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
            connection: 'missing',
          },
        },
      },
      databaseConfig: {
        defaultConnection: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            filename: ':memory:',
          },
        },
      },
    })

    expect(() => cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'database')).toThrow(
      'Available connections: main',
    )
  })

  it('requires redis cache drivers to resolve named connections from config/redis.ts', () => {
    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            connection: 'cache',
          },
        },
      },
    })

    expect(() => cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'redis')).toThrow(
      'requires a top-level redis config from config/redis.ts',
    )

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            connection: 'missing',
          },
        },
      },
      redisConfig: {
        default: 'cache',
        connections: {
          cache: {
            host: '127.0.0.1',
            port: 6379,
          },
        },
      },
    })

    expect(() => cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'redis')).toThrow(
      'Available connections: cache',
    )

    expect(() => cacheRedisInternals.resolveSharedRedisConnection({
      default: 'cache',
      connections: {},
    }, 'missing')).toThrow('(none)')
  })

  it('throws the database-config resolution error for database cache drivers without shared db config', () => {
    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
          },
        },
      },
    })

    expect(() => cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime(), 'database')).toThrow(
      'requires a top-level database config from config/database.ts',
    )
  })

  it('exposes stable error subclasses for contract-level failure paths', () => {
    expect(new CacheDriverResolutionError('driver').code).toBe('CACHE_DRIVER_RESOLUTION_FAILED')
    expect(new CacheOptionalPackageError('package').code).toBe('CACHE_OPTIONAL_PACKAGE_MISSING')
    expect(new CacheInvalidNumericMutationError('numeric').code).toBe('CACHE_INVALID_NUMERIC_MUTATION')
    expect(new CacheLockAcquisitionError('lock').code).toBe('CACHE_LOCK_ACQUISITION_FAILED')
    expect(new CacheQueryIntegrationError('query').code).toBe('CACHE_QUERY_INTEGRATION_MISUSE')
  })

  it('exposes redis runtime internals for normalization and optional-package errors', () => {
    const normalizedRedisConfig = Object.freeze({
      default: 'cache',
      connections: Object.freeze({
        cache: Object.freeze({
          name: 'cache',
          host: '127.0.0.1',
          port: 6379,
          db: 0,
        }),
      }),
    })

    expect(cacheRedisInternals.normalizeRuntimeRedisConfig({
      default: 'cache',
      connections: {
        cache: {
          url: 'redis://cache.internal:6379/0',
        },
      },
    })?.connections.cache?.url).toBe('redis://cache.internal:6379/0')
    expect(cacheRedisInternals.normalizeRuntimeRedisConfig(undefined)).toBeUndefined()
    expect(cacheRedisInternals.isNormalizedRedisConfig(normalizedRedisConfig)).toBe(true)
    expect(cacheRedisInternals.normalizeRuntimeRedisConfig(normalizedRedisConfig)).toBe(normalizedRedisConfig)
    expect(cacheRedisInternals.isModuleNotFoundError({ code: 'ERR_MODULE_NOT_FOUND' })).toBe(true)
    expect(cacheRedisInternals.isModuleNotFoundError(new Error('nope'))).toBe(false)

    const missingPackageError = cacheRedisInternals.normalizeRedisModuleLoadError({
      code: 'ERR_MODULE_NOT_FOUND',
    })
    expect(missingPackageError).toBeInstanceOf(CacheOptionalPackageError)
    expect((missingPackageError as CacheOptionalPackageError).message).toContain('@holo-js/cache-redis')

    const passthroughError = new Error('boom')
    expect(cacheRedisInternals.normalizeRedisModuleLoadError(passthroughError)).toBe(passthroughError)
  })

  it('loads the optional redis module through the runtime loader and exposes lazy driver metadata', async () => {
    const module = await cacheRedisInternals.loadRedisDriverModule()

    expect(typeof module.createRedisCacheDriver).toBe('function')

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            connection: 'cache',
          },
        },
      },
      redisConfig: {
        default: 'cache',
        connections: {
          cache: {
            url: 'redis://cache.internal:6379/0',
          },
        },
      },
    })

    const driver = cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime())
    expect(driver.name).toBe('redis')
  })

  it('loads the optional database module through the runtime loader and exposes lazy driver metadata', async () => {
    const module = await cacheDbInternals.loadDatabaseDriverModule()

    expect(typeof module.createDatabaseCacheDriver).toBe('function')

    configureCacheRuntime({
      config: {
        default: 'database',
        drivers: {
          database: {
            driver: 'database',
            connection: 'main',
          },
        },
      },
      databaseConfig: {
        defaultConnection: 'main',
        connections: {
          main: {
            driver: 'sqlite',
            filename: ':memory:',
          },
        },
      },
    })

    const driver = cacheRuntimeInternals.resolveConfiguredDriver(getCacheRuntime())
    expect(driver.name).toBe('database')
  })

  it('covers the defensive unsupported-driver branch for malformed runtime config', () => {
    expect(() => cacheRuntimeInternals.resolveConfiguredDriver({
      config: {
        default: 'custom',
        prefix: '',
        drivers: {
          custom: {
            name: 'custom',
            driver: 'custom',
          },
        },
      },
      drivers: new Map(),
    } as never, 'custom')).toThrow(
      'uses unsupported driver "custom"',
    )
  })

  it('exposes database runtime internals for normalization and optional-package errors', () => {
    const normalizedDatabaseConfig = Object.freeze({
      defaultConnection: 'main',
      connections: Object.freeze({
        main: Object.freeze({
          driver: 'sqlite',
          filename: ':memory:',
        }),
      }),
    })

    expect(cacheDbInternals.normalizeRuntimeDatabaseConfig({
      defaultConnection: 'main',
      connections: {
        main: {
          driver: 'sqlite',
          filename: ':memory:',
        },
      },
    })).toEqual(normalizedDatabaseConfig)
    expect(cacheDbInternals.normalizeRuntimeDatabaseConfig(undefined)).toBeUndefined()
    expect(cacheDbInternals.isNormalizedDatabaseConfig(normalizedDatabaseConfig)).toBe(true)
    expect(cacheDbInternals.isModuleNotFoundError({
      code: 'ERR_MODULE_NOT_FOUND',
      message: 'Cannot find package "@holo-js/cache-db" imported from "/tmp/app.mjs"',
    })).toBe(true)
    expect(cacheDbInternals.isModuleNotFoundError(new Error('nope'))).toBe(false)
    expect(cacheDbInternals.isModuleNotFoundError({
      cause: {
        code: 'ERR_MODULE_NOT_FOUND',
        message: 'Could not resolve "@holo-js/cache-db"',
      },
    })).toBe(true)
    expect(() => cacheDbInternals.resolveSharedDatabaseConnection({
      defaultConnection: 'main',
      connections: {},
    }, 'missing')).toThrow('(none)')

    const missingPackageError = cacheDbInternals.normalizeDatabaseModuleLoadError({
      code: 'ERR_MODULE_NOT_FOUND',
      message: 'Cannot find module "@holo-js/cache-db"',
    })
    expect(missingPackageError).toBeInstanceOf(CacheOptionalPackageError)
    expect((missingPackageError as CacheOptionalPackageError).message).toContain('@holo-js/cache-db')

    const passthroughError = Object.assign(new Error('boom'), {
      code: 'ERR_MODULE_NOT_FOUND',
      message: 'Cannot find package "@holo-js/other"',
    })
    expect(cacheDbInternals.normalizeDatabaseModuleLoadError(passthroughError)).toBe(passthroughError)
  })

  it('creates a default query bridge that tracks dependency registrations and invalidates entries across drivers', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
          },
          secondary: {
            driver: 'memory',
            prefix: 'secondary:',
          },
        },
      },
    })

    const queryBridge = getCacheRuntime().queryBridge
    const dependencyIndex = getCacheRuntime().dependencyIndex
    if (!queryBridge || !dependencyIndex) {
      throw new Error('Expected cache query bridge bindings.')
    }

    await queryBridge.put('users:list', [{ id: 1 }], {
      ttl: 60,
      dependencies: ['db:main:users'],
    })
    await queryBridge.put('posts:list', [{ id: 1 }], {
      ttl: 60,
      driver: 'secondary',
      dependencies: ['db:main:posts'],
    })

    expect(await queryBridge.get<{ id: number }[]>('users:list')).toEqual([{ id: 1 }])
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([
      'memory\u0000app:users:list',
      'secondary\u0000secondary:posts:list',
    ])

    await queryBridge.invalidateDependencies(['db:main:users', 'db:main:posts'])

    expect(await cache.get('users:list')).toBeNull()
    expect(await cache.driver('secondary').get('posts:list')).toBeNull()
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([])
  })

  it('cleans dependency registrations on query-bridge forget, flexible writes, and repository flush', async () => {
    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
    })

    const queryBridge = getCacheRuntime().queryBridge
    const dependencyIndex = getCacheRuntime().dependencyIndex
    if (!queryBridge || !dependencyIndex) {
      throw new Error('Expected cache query bridge bindings.')
    }

    await queryBridge.put('users:list', [{ id: 1 }], {
      ttl: 60,
      dependencies: ['db:main:users'],
    })
    await queryBridge.forget('users:list')
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([])

    await queryBridge.flexible('users:flexible', [60, 300], async () => [{ id: 2 }], {
      dependencies: ['db:main:users'],
    })
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([
      'memory\u0000app:users:flexible',
    ])

    await cache.flush()
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([])
  })

  it('covers dependency-index helper edge cases and indexed-key parsing fallbacks', async () => {
    configureCacheRuntime({
      config: {
        default: 'file',
        prefix: 'app:',
        drivers: {
          file: {
            driver: 'file',
            path: await createTempCacheDirectory('query-bridge-parse'),
          },
        },
      },
    })

    const dependencyIndex = cacheQueryBridgeInternals.createMemoryDependencyIndex()

    await dependencyIndex.removeKey('missing')
    await dependencyIndex.register('empty', [])
    await dependencyIndex.register('memory\u0000app:key', ['db:main:users', 'db:main:users'])
    expect(await dependencyIndex.listKeys('db:main:users')).toEqual(['memory\u0000app:key'])
    await dependencyIndex.clear()
    expect(await dependencyIndex.listRegisteredKeys()).toEqual([])
    expect(cacheQueryBridgeInternals.parseIndexedKey('plain-key')).toEqual({
      driverName: 'file',
      normalizedKey: 'plain-key',
    })

    const inconsistentIndex = cacheQueryBridgeInternals.createMemoryDependencyIndex({
      keyToDependencies: new Map([['dangling', new Set(['db:main:dangling'])]]),
      dependencyToKeys: new Map(),
    })
    await inconsistentIndex.removeKey('dangling')
  })

  it('covers query-bridge flexible retries, duplicate invalidation suppression, and ttl validation', async () => {
    const driver = {
      name: 'memory',
      driver: 'memory',
      forget: vi.fn(async () => true),
      flush: vi.fn(async () => undefined),
      increment: vi.fn(async () => 0),
      decrement: vi.fn(async () => 0),
      put: vi.fn(async () => true),
      add: vi.fn(async () => true),
      get: vi.fn()
        .mockResolvedValueOnce({
          hit: true,
          payload: serializeCacheValue({
            __holo_cache_flexible: true,
            value: 'stale-window',
            freshUntil: Date.now() - 10_000,
            staleUntil: Date.now() + 300_000,
          }),
        })
        .mockResolvedValueOnce({
          hit: true,
          payload: serializeCacheValue({
            __holo_cache_flexible: true,
            value: 'stale',
            freshUntil: Date.now() - 10_000,
            staleUntil: Date.now() - 1_000,
          }),
        })
        .mockResolvedValueOnce({
          hit: true,
          payload: serializeCacheValue({
            __holo_cache_flexible: true,
            value: 'retried',
            freshUntil: Date.now() + 60_000,
            staleUntil: Date.now() + 300_000,
          }),
        })
        .mockResolvedValueOnce({
          hit: true,
          payload: serializeCacheValue({
            __holo_cache_flexible: true,
            value: 'expired',
            freshUntil: Date.now() - 10_000,
            staleUntil: Date.now() - 1_000,
          }),
        })
        .mockResolvedValueOnce({ hit: false }),
      refreshValue: 'callback-expired-retry',
      lock: vi.fn(() => ({
        name: 'lock',
        async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
          return callback ? callback() : true
        },
        async release(): Promise<boolean> {
          return true
        },
        async block(): Promise<boolean> {
          return false
        },
      })),
    }

    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
      drivers: new Map([['memory', driver as never]]),
      dependencyIndex: cacheQueryBridgeInternals.createMemoryDependencyIndex(),
    })

    const queryBridge = getCacheRuntime().queryBridge
    if (!queryBridge) {
      throw new Error('Expected cache query bridge bindings.')
    }

    await expect(queryBridge.flexible('invalid', [-1, 1], async () => 'nope')).rejects.toBeInstanceOf(CacheInvalidTtlError)
    await expect(queryBridge.flexible('invalid', [2, 1], async () => 'nope')).rejects.toBeInstanceOf(CacheInvalidTtlError)
    await queryBridge.put('forever', 'value', {})
    expect(driver.put).toHaveBeenCalledWith({
      key: 'app:forever',
      payload: serializeCacheValue('value'),
      expiresAt: undefined,
    })
    await expect(queryBridge.flexible('stale', [60, 300], async () => 'callback')).resolves.toBe('stale-window')
    await expect(queryBridge.flexible('retried', [60, 300], async () => 'callback')).resolves.toBe('retried')
    await expect(queryBridge.flexible('refreshed', [60, 300], async () => driver.refreshValue)).resolves.toBe('callback-expired-retry')

    await queryBridge.put('duplicate', 'value', {
      ttl: 60,
      dependencies: ['db:main:users', 'db:main:posts'],
    })
    await queryBridge.invalidateDependencies(['db:main:users', 'db:main:posts'])

    expect(driver.forget).toHaveBeenCalledTimes(1)
    expect(driver.forget).toHaveBeenNthCalledWith(1, 'app:duplicate')
    expect(driver.put).toHaveBeenCalled()
  })

  it('covers direct query-bridge get, forget, and object flexible ttl paths', async () => {
    const store = new Map<string, string>()
    const driver = {
      name: 'memory',
      driver: 'memory',
      forget: vi.fn(async (key: string) => store.delete(key)),
      flush: vi.fn(async () => undefined),
      increment: vi.fn(async () => 0),
      decrement: vi.fn(async () => 0),
      put: vi.fn(async (input: { key: string, payload: string }) => {
        store.set(input.key, input.payload)
        return true
      }),
      add: vi.fn(async () => true),
      get: vi.fn(async (key: string) => {
        const payload = store.get(key)
        return payload ? { hit: true as const, payload } : { hit: false as const }
      }),
      lock: vi.fn(() => ({
        name: 'lock',
        async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
          return callback ? callback() : true
        },
        async release(): Promise<boolean> {
          return true
        },
        async block<TValue>(_: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
          return callback ? callback() : true
        },
      })),
    }

    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
          },
          secondary: {
            driver: 'memory',
            prefix: 'sec:',
          },
        },
      },
      drivers: new Map([
        ['memory', driver as never],
        ['secondary', driver as never],
      ]),
      dependencyIndex: cacheQueryBridgeInternals.createMemoryDependencyIndex(),
    })

    const queryBridge = getCacheRuntime().queryBridge
    if (!queryBridge) {
      throw new Error('Expected cache query bridge bindings.')
    }

    await queryBridge.put('plain', 'value', { ttl: 60 })
    await expect(queryBridge.get('plain')).resolves.toBe('value')
    await queryBridge.put('named', 'secondary-value', {
      ttl: 60,
      driver: 'secondary',
    })
    await expect(queryBridge.get('named', { driver: 'secondary' })).resolves.toBe('secondary-value')
    await expect(queryBridge.flexible('object-ttl', { fresh: 60, stale: 300 }, async () => 'object-value')).resolves.toBe('object-value')
    await queryBridge.forget('plain')
    await queryBridge.forget('named', { driver: 'secondary' })

    expect(driver.forget).toHaveBeenCalledWith('app:plain')
    expect(driver.forget).toHaveBeenCalledWith('sec:named')
  })

  it('returns fresh flexible query-bridge envelopes without scheduling a refresh', async () => {
    const driver = {
      name: 'memory',
      driver: 'memory',
      forget: vi.fn(async () => true),
      flush: vi.fn(async () => undefined),
      increment: vi.fn(async () => 0),
      decrement: vi.fn(async () => 0),
      put: vi.fn(async () => true),
      add: vi.fn(async () => true),
      get: vi.fn().mockResolvedValue({
        hit: true,
        payload: serializeCacheValue({
          __holo_cache_flexible: true,
          value: 'fresh',
          freshUntil: Date.now() + 60_000,
          staleUntil: Date.now() + 300_000,
        }),
      }),
      lock: vi.fn(() => ({
        name: 'lock',
        async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
          return callback ? callback() : true
        },
        async release(): Promise<boolean> {
          return true
        },
        async block<TValue>(_: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
          return callback ? callback() : true
        },
      })),
    }

    configureCacheRuntime({
      config: {
        default: 'memory',
        prefix: 'app:',
        drivers: {
          memory: {
            driver: 'memory',
          },
        },
      },
      drivers: new Map([['memory', driver as never]]),
    })

    const queryBridge = getCacheRuntime().queryBridge
    if (!queryBridge) {
      throw new Error('Expected cache query bridge bindings.')
    }

    await expect(queryBridge.flexible('fresh', [60, 300], async () => 'callback')).resolves.toBe('fresh')
    expect(driver.lock).not.toHaveBeenCalled()
  })
})
