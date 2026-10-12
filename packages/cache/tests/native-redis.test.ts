import { expect, it, onTestFinished } from 'vitest'
import { normalizeRedisConfig } from '@holo-js/kernel'
import '@holo-js/cache-redis'
import { startRedisService } from '../../session/tests/support/redis'
import cache, { configureCacheRuntime, resetCacheRuntime } from '../src'

it('uses the installed Redis adapter through shared project configuration and releases it on reset', async () => {
  const redis = await startRedisService()
  const port = redis.ports[0]
  const observer = redis.clients[0]
  if (!port || !observer) throw new Error('Redis did not start')
  const connections = async () => Number((await observer.info('clients')).match(/connected_clients:(\d+)/)?.[1])
  const baseline = await connections()
  configureCacheRuntime({
    config: { default: 'redis', prefix: 'native-cache:', drivers: { redis: { driver: 'redis', connection: 'shared' } } },
    redisConfig: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port, db: 0 } } }),
  })
  onTestFinished(resetCacheRuntime)
  await cache.put('profile', { name: 'Ava' }, 60)
  await expect(cache.get('profile')).resolves.toEqual({ name: 'Ava' })
  await expect(cache.increment('visits', 2)).resolves.toBe(2)
  await expect(cache.increment('visits', 3)).resolves.toBe(5)
  await expect(cache.decrement('visits')).resolves.toBe(4)
  const lease = cache.lock('native-work', 10)
  expect(await lease.get()).toBe(true)
  expect(await cache.lock('native-work', 10).get()).toBe(false)
  expect(await lease.release()).toBe(true)
  await expect(cache.forget('profile')).resolves.toBe(true)
  await expect(cache.get('profile')).resolves.toBeNull()
  await expect.poll(connections).toBeGreaterThan(baseline)
  resetCacheRuntime()
  await expect.poll(connections).toBe(baseline)
})
