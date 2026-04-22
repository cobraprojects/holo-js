import { describe, expectTypeOf, it } from 'vitest'
import cache, {
  defineCacheConfig,
  defineCacheKey,
  type CacheFacade,
  type CacheKey,
  type CacheLockContract,
  type CacheRepository,
} from '../src'

type CacheValue = {
  total: number
  createdAt: Date | null
}

describe('@holo-js/cache typing', () => {
  it('preserves typed-key inference, config inference, and facade overloads', () => {
    const config = defineCacheConfig({
      default: 'redis',
      prefix: 'app',
      drivers: {
        memory: {
          driver: 'memory',
          maxEntries: 100,
        },
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    })

    const reportKey = defineCacheKey<CacheValue>('reports.monthly')

    const cacheKey: CacheKey<CacheValue> = reportKey
    const defaultDriver: string = config.default
    const redisConnection: string = config.drivers.redis.connection
    const memoryEntries: number = config.drivers.memory.maxEntries
    const getTyped = (key: typeof reportKey) => cache.get(key)
    const getTypedWithFallback = (key: typeof reportKey, fallback: CacheValue) => cache.get(key, fallback)
    const getString = (key: string) => cache.get(key)
    const getStringWithFallback = (key: string, fallback: number) => cache.get(key, fallback)
    const getStringWithResolver = (key: string, fallback: () => Promise<number>) => cache.get(key, fallback)
    const putTyped = (key: typeof reportKey, value: CacheValue, ttl: number) => cache.put(key, value, ttl)
    const addTyped = (key: typeof reportKey, value: CacheValue, ttl: number) => cache.add(key, value, ttl)
    const foreverTyped = (key: typeof reportKey, value: CacheValue) => cache.forever(key, value)
    const incrementCounter = (key: CacheKey<number>) => cache.increment(key)
    const decrementCounter = (key: CacheKey<number>, amount: number) => cache.decrement(key, amount)
    const rememberTyped = (key: typeof reportKey) => cache.remember(key, 60, async () => ({ total: 1, createdAt: null }))
    const rememberForeverTyped = (key: typeof reportKey) => cache.rememberForever(key, async () => ({ total: 1, createdAt: null }))
    const flexibleTyped = (key: typeof reportKey) => cache.flexible(key, [60, 300] as const, async () => ({ total: 1, createdAt: null }))

    expectTypeOf(cache).toExtend<CacheFacade>()
    expectTypeOf(cache.driver('memory')).toExtend<CacheRepository>()
    expectTypeOf(getTyped).returns.toEqualTypeOf<Promise<CacheValue | null>>()
    expectTypeOf(getTypedWithFallback).returns.toEqualTypeOf<Promise<CacheValue>>()
    expectTypeOf(getString).returns.toEqualTypeOf<Promise<unknown | null>>()
    expectTypeOf(getStringWithFallback).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(getStringWithResolver).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(putTyped).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(addTyped).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(foreverTyped).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(incrementCounter).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(decrementCounter).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(rememberTyped).returns.toEqualTypeOf<Promise<CacheValue>>()
    expectTypeOf(rememberForeverTyped).returns.toEqualTypeOf<Promise<CacheValue>>()
    expectTypeOf(flexibleTyped).returns.toEqualTypeOf<Promise<CacheValue>>()
    expectTypeOf<ReturnType<typeof cache.lock>>().toExtend<CacheLockContract>()

    void cacheKey
    void defaultDriver
    void redisConnection
    void memoryEntries
  })
})
