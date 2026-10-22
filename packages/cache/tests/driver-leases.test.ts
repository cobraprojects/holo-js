import { expect, it, onTestFinished, vi } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import cache, { configureCacheRuntime, resetCacheRuntime, type CacheDriverContract } from '../src'
import { cacheRedisInternals } from '../src/redis'

const DISPOSE = Symbol.for('holo.cache.driver.dispose')

const config = { default: 'redis', prefix: 'lease:', drivers: { redis: { driver: 'redis', connection: 'shared' } } } as const
const redisConfig = normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: 6379, db: 0 } } })

function createFakeRedisDriver(
  events: string[],
  pendingGet: Promise<{ readonly hit: boolean, readonly payload?: string }>,
  pendingRelease: Promise<boolean> = Promise.resolve(true),
) {
  return {
    name: 'redis',
    driver: 'redis',
    async get() {
      events.push('get:start')
      const result = await pendingGet
      events.push('get:settled')
      return result
    },
    async put() { return true },
    async add() { return true },
    async forget() { return true },
    async flush() {},
    async increment() { return 0 },
    async decrement() { return 0 },
    lock(name: string) {
      return {
        name,
        async get() { return true },
        async release() {
          events.push('release:start')
          const released = await pendingRelease
          events.push('release:settled')
          return released
        },
        async block() { return true },
      }
    },
    [DISPOSE]() {
      events.push('dispose')
    },
  } satisfies CacheDriverContract & { [DISPOSE](): void }
}

it('keeps a replaced Redis cache driver open until the call in flight on it settles', async () => {
  const events: string[] = []
  let resolveGet!: (result: { readonly hit: boolean, readonly payload?: string }) => void
  const pendingGet = new Promise<{ readonly hit: boolean, readonly payload?: string }>(resolve => {
    resolveGet = resolve
  })
  cacheRedisInternals.setRedisDriverModuleLoader(async () => ({
    createRedisCacheDriver: () => createFakeRedisDriver(events, pendingGet),
  }))
  onTestFinished(() => cacheRedisInternals.resetRedisDriverModuleLoader())
  onTestFinished(resetCacheRuntime)
  configureCacheRuntime({ config, redisConfig })

  const inFlight = cache.get('profile')
  await vi.waitUntil(() => events.includes('get:start'))

  configureCacheRuntime({ config, redisConfig })
  await Promise.resolve()
  expect(events).not.toContain('dispose')

  resolveGet({ hit: false })
  await expect(inFlight).resolves.toBeNull()
  await vi.waitUntil(() => events.includes('dispose'))
  expect(events).toEqual(['get:start', 'get:settled', 'dispose'])
})

it('keeps a replaced Redis cache driver open until a lock release in flight on it settles', async () => {
  const events: string[] = []
  let resolveRelease!: (released: boolean) => void
  const pendingRelease = new Promise<boolean>(resolve => {
    resolveRelease = resolve
  })
  cacheRedisInternals.setRedisDriverModuleLoader(async () => ({
    createRedisCacheDriver: () => createFakeRedisDriver(events, Promise.resolve({ hit: false }), pendingRelease),
  }))
  onTestFinished(() => cacheRedisInternals.resetRedisDriverModuleLoader())
  onTestFinished(resetCacheRuntime)
  configureCacheRuntime({ config, redisConfig })

  const lock = cache.lock('work', 10)
  expect(await lock.get()).toBe(true)
  const released = lock.release()
  await vi.waitUntil(() => events.includes('release:start'))

  configureCacheRuntime({ config, redisConfig })
  await Promise.resolve()
  expect(events).not.toContain('dispose')

  resolveRelease(true)
  await expect(released).resolves.toBe(true)
  await vi.waitUntil(() => events.includes('dispose'))
  expect(events).toEqual(['release:start', 'release:settled', 'dispose'])
})
