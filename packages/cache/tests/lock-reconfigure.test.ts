import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import cache, {
  CacheDriverResolutionError,
  configureCacheRuntime,
  resetCacheRuntime,
  type CacheDriverContract,
} from '../src'
import { cacheRedisInternals } from '../src/redis'

const DISPOSE = Symbol.for('holo.cache.driver.dispose')

const config = { default: 'redis', prefix: 'lock:', drivers: { redis: { driver: 'redis', connection: 'shared' } } } as const
const redisConfig = normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: 6379, db: 0 } } })

function createTaggedRedisDriver(tag: string, events: string[]) {
  return {
    name: 'redis',
    driver: 'redis',
    async get() { return { hit: false } },
    async put() { return true },
    async add() { return true },
    async forget() { return true },
    async flush() {},
    async increment() { return 0 },
    async decrement() { return 0 },
    lock(name: string) {
      return {
        name,
        async get() {
          events.push(`${tag}:get`)
          return true
        },
        async release() {
          events.push(`${tag}:release`)
          return true
        },
        async block() {
          events.push(`${tag}:block`)
          return true
        },
      }
    },
    [DISPOSE]() {
      events.push(`${tag}:dispose`)
    },
  } satisfies CacheDriverContract & { [DISPOSE](): void }
}

function useTaggedRedisDrivers(events: string[]): void {
  const drivers = ['first', 'second']
  let created = 0
  cacheRedisInternals.setRedisDriverModuleLoader(async () => ({
    createRedisCacheDriver: () => {
      const tag = drivers[created] ?? `driver-${created}`
      created += 1
      return createTaggedRedisDriver(tag, events)
    },
  }))
  onTestFinished(() => cacheRedisInternals.resetRedisDriverModuleLoader())
  onTestFinished(resetCacheRuntime)
}

it('does not run lock operations on the old store after the cache store is reconfigured', async () => {
  const events: string[] = []
  useTaggedRedisDrivers(events)
  configureCacheRuntime({ config, redisConfig })

  const lock = cache.lock('work', 10)
  expect(await lock.get()).toBe(true)

  configureCacheRuntime({ config, redisConfig })
  await vi.waitUntil(() => events.includes('first:dispose'))

  await expect(lock.release()).rejects.toThrow(/replaced/)
  await expect(lock.get()).rejects.toBeInstanceOf(CacheDriverResolutionError)
  expect(events).toEqual(['first:get', 'first:dispose'])
})

it.each(['memory', 'file'] as const)('rejects a %s store lock used after the cache store is reconfigured', async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-cache-lock-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  onTestFinished(resetCacheRuntime)
  const configure = (): void => {
    configureCacheRuntime({
      config: kind === 'file'
        ? { default: 'file', drivers: { file: { driver: 'file', path: directory } } }
        : { default: 'memory', drivers: { memory: { driver: 'memory' } } },
    })
  }
  configure()

  const lock = cache.lock('work', 10)
  expect(await lock.get()).toBe(true)

  configure()

  await expect(lock.release()).rejects.toBeInstanceOf(CacheDriverResolutionError)
  await expect(lock.get()).rejects.toBeInstanceOf(CacheDriverResolutionError)
  expect(await cache.lock('fresh', 10).get()).toBe(true)
})

it('does not open a driver for a lock taken before the cache store was reconfigured and first used after', async () => {
  const events: string[] = []
  useTaggedRedisDrivers(events)
  configureCacheRuntime({ config, redisConfig })

  const lock = cache.lock('work', 10)
  configureCacheRuntime({ config, redisConfig })

  await expect(lock.get()).rejects.toBeInstanceOf(CacheDriverResolutionError)
  await expect(lock.release()).rejects.toBeInstanceOf(CacheDriverResolutionError)
  expect(events).toEqual([])
})

it('acquires a new lock on the current store after the cache store is reconfigured', async () => {
  const events: string[] = []
  useTaggedRedisDrivers(events)
  configureCacheRuntime({ config, redisConfig })

  await cache.lock('work', 10).get()
  configureCacheRuntime({ config, redisConfig })

  expect(await cache.lock('work', 10).get()).toBe(true)
  expect(events).toEqual(['first:get', 'first:dispose', 'second:get'])
})
