import { expect, it, onTestFinished, vi } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import cache, { configureCacheRuntime, resetCacheRuntime, type CacheDriverContract } from '../src'
import { cacheRedisInternals } from '../src/redis'

const DISPOSE = Symbol.for('holo.cache.driver.dispose')

const config = { default: 'redis', prefix: 'lease:', drivers: { redis: { driver: 'redis', connection: 'shared' } } } as const
const redisConfig = normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: 6379, db: 0 } } })

function createFakeRedisDriver(events: string[], pendingGet: Promise<{ readonly hit: boolean, readonly payload?: string }>) {
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
    lock() { throw new Error('locks are not used in this test') },
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
