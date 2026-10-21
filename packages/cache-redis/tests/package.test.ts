import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import cache, { CacheInvalidNumericMutationError, configureCacheRuntime, resetCacheRuntime } from '@holo-js/cache'
import Redis from 'ioredis'
import { startRedisService } from '../../session/tests/support/redis'
import { createRedisCacheDriver, type RedisCacheDriverOptions } from '../src'

async function configureRealCache(options: { cluster?: boolean; socket?: boolean; url?: boolean; db?: number } = {}) {
  const service = await startRedisService(options)
  const port = service.ports[0]
  if (!port) throw new Error('Expected Redis port')
  const redis: RedisCacheDriverOptions['redis'] = options.cluster
    ? { clusters: service.ports.map(port => ({ host: '127.0.0.1', port })), db: 0 }
    : options.socket
      ? { socketPath: service.socket, db: options.db ?? 0 }
      : options.url
        ? { url: `redis://127.0.0.1:${port}`, db: options.db ?? 0 }
        : { host: '127.0.0.1', port, db: options.db ?? 0 }
  const prefix = `holo:cache:${randomUUID()}:`
  const driver = createRedisCacheDriver({ name: 'redis', connectionName: 'cache', redis })
  configureCacheRuntime({ config: { default: 'redis', drivers: { redis: { driver: 'redis', prefix } } }, drivers: new Map([['redis', driver]]) })
  return { service, port }
}

describe('Redis cache behavior', () => {
  it.each([{}, { url: true, db: 2 }, { socket: true, db: 3 }])('stores exact values and conditionally inserts through %j', async options => {
    await configureRealCache(options)
    try {
      expect(await cache.get('missing')).toBeNull()
      await cache.put('value', { items: [], metadata: {}, userId: 42 }, 60)
      expect(await cache.get('value')).toEqual({ items: [], metadata: {}, userId: 42 })
      expect(await cache.add('value', { replaced: true }, 60)).toBe(false)
      expect(await cache.add('new', null, 60)).toBe(true)
      expect(await cache.get('new')).toBeNull()
      expect(await cache.has('new')).toBe(true)
      expect(await cache.forget('value')).toBe(true)
      expect(await cache.forget('value')).toBe(false)
    } finally {
      resetCacheRuntime()
    }
  })

  it('expires values in Redis and removes immediate-expiry writes', async () => {
    await configureRealCache()
    try {
      await cache.put('value', 'first', new Date(Date.now() + 150))
      expect(await cache.get('value')).toBe('first')
      await vi.waitFor(async () => {
        expect(await cache.get('value')).toBeNull()
      }, { timeout: 5_000, interval: 10 })
      await cache.forever('value', 'persisted')
      await cache.put('value', 'expired', new Date(Date.now() - 1))
      expect(await cache.has('value')).toBe(false)
    } finally {
      resetCacheRuntime()
    }
  })

  it('atomically counts concurrent mutations and rejects non-numeric values', async () => {
    await configureRealCache()
    try {
      const counters = await Promise.all(Array.from({ length: 16 }, () => cache.increment('counter')))
      expect(counters.sort((left, right) => left - right)).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
      expect(await cache.decrement('counter', 3)).toBe(13)
      await cache.forever('text', 'not a number')
      await expect(cache.increment('text')).rejects.toThrow(CacheInvalidNumericMutationError)
      await expect(cache.decrement('text')).rejects.toThrow(CacheInvalidNumericMutationError)
      expect(await cache.get('text')).toBe('not a number')
    } finally {
      resetCacheRuntime()
    }
  })

  it('releases callback locks on success and failure and prevents a non-owner from releasing them', async () => {
    await configureRealCache()
    try {
      const owner = cache.lock('shared', 1)
      const contender = cache.lock('shared', 1)
      expect(await owner.get()).toBe(true)
      expect(await contender.get()).toBe(false)
      expect(await contender.release()).toBe(false)
      expect(await owner.release()).toBe(true)
      expect(await contender.get(async () => 'completed')).toBe('completed')
      await expect(owner.get(async () => { throw new Error('task failed') })).rejects.toThrow('task failed')
      expect(await contender.get()).toBe(true)
      await contender.release()
    } finally {
      resetCacheRuntime()
    }
  })

  it('does not let an expired lock owner release its successor', async () => {
    await configureRealCache()
    try {
      const previous = cache.lock('shared', 0.1)
      expect(await previous.get()).toBe(true)
      await setTimeout(150)
      const current = cache.lock('shared', 1)
      expect(await current.get()).toBe(true)
      expect(await previous.release()).toBe(false)
      expect(await cache.lock('shared', 1).get()).toBe(false)
      expect(await current.release()).toBe(true)
    } finally {
      resetCacheRuntime()
    }
  })

  it('blocks until a real owner releases the lock and respects the wait deadline', async () => {
    await configureRealCache()
    try {
      const owner = cache.lock('shared', 1)
      expect(await owner.get()).toBe(true)
      expect(await cache.lock('shared', 1).block(0.05)).toBe(false)
      const waiting = cache.lock('shared', 1).block(0.5, async () => 'acquired')
      await setTimeout(50)
      await owner.release()
      expect(await waiting).toBe('acquired')
    } finally {
      resetCacheRuntime()
    }
  })

  it('flushes the configured Redis database and leaves other databases untouched', async () => {
    const { service, port } = await configureRealCache({ db: 2 })
    const cacheDatabase = new Redis({ host: '127.0.0.1', port, db: 2, maxRetriesPerRequest: 1 })
    const defaultDatabase = service.clients[0]
    if (!defaultDatabase) throw new Error('Expected Redis client')
    try {
      for (let index = 0; index < 30; index += 1) await cache.forever(`item:${index}`, index)
      await cacheDatabase.set('unprefixed:neighbor', 'cleared')
      await defaultDatabase.set('unrelated:sentinel', 'preserved')

      await cache.flush()

      for (let index = 0; index < 30; index += 1) expect(await cache.has(`item:${index}`)).toBe(false)
      expect(await cacheDatabase.dbsize()).toBe(0)
      expect(await defaultDatabase.get('unrelated:sentinel')).toBe('preserved')
    } finally {
      cacheDatabase.disconnect()
      resetCacheRuntime()
    }
  }, 30_000)

  it('flushes every primary node of a Redis cluster', async () => {
    const { service } = await configureRealCache({ cluster: true })
    try {
      for (let index = 0; index < 30; index += 1) await cache.forever(`item:${index}`, index)
      expect((await Promise.all(service.clients.map(client => client.dbsize()))).every(size => size > 0)).toBe(true)

      await cache.flush()

      expect(await Promise.all(service.clients.map(client => client.dbsize()))).toEqual(service.clients.map(() => 0))
    } finally {
      resetCacheRuntime()
    }
  }, 30_000)

  it.each(['redis://user:pass@127.0.0.1:6379', 'redis://127.0.0.1:6379/2', 'http://127.0.0.1:6379', 'redis:///'])('rejects invalid cluster targets: %s', url => {
    expect(() => createRedisCacheDriver({ name: 'redis', connectionName: 'cache', redis: { clusters: [{ url }], db: 0 } })).toThrow()
  })
})
