import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import cache, { configureCacheRuntime, resetCacheRuntime } from '@holo-js/cache'
import { createRedisCacheDriver } from '../src/index'

describe('@holo-js/cache-redis real redis integration', () => {
  afterEach(() => {
    resetCacheRuntime()
  })

  it('works through the public cache facade and releases redis through runtime reset', async () => {
    const prefix = `holo:test:cache:${randomUUID()}:`

    configureCacheRuntime({
      config: {
        default: 'redis',
        drivers: {
          redis: {
            driver: 'redis',
            prefix,
          },
        },
      },
      drivers: new Map([
        ['redis', createRedisCacheDriver({
          name: 'redis',
          connectionName: 'cache',
          prefix,
          redis: {
            host: '127.0.0.1',
            port: 6379,
            db: 0,
          },
        })],
      ]),
    })

    try {
      await cache.put('children', { count: 2 }, 60)
      expect(await cache.get('children')).toEqual({ count: 2 })

      expect(await cache.add('children', { count: 3 }, 60)).toBe(false)
      expect(await cache.increment('counter', 3)).toBe(3)
      expect(await cache.decrement('counter')).toBe(2)
      expect(await cache.lock('children:refresh', 1).get(async () => 'locked')).toBe('locked')

      await cache.flush()
      expect(await cache.get('children')).toBeNull()
    } finally {
      try {
        await cache.flush()
      } finally {
        resetCacheRuntime()
      }
    }
  })
})
