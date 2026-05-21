import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRedisRateLimitStore } from '../src'
import { createSecurityRedisAdapter } from '../src/drivers/redis-adapter'

const realRedisUrl = process.env.HOLO_SECURITY_REAL_REDIS_URL?.trim() ?? ''
const runWithRealRedis = realRedisUrl ? it : it.skip

describe('@holo-js/security real Redis usage', () => {
  runWithRealRedis('stores rate-limit hits through the public Redis store adapter', async () => {
    const prefix = `holo:security:${randomUUID()}:`
    const adapter = createSecurityRedisAdapter({
      connection: realRedisUrl,
      prefix,
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    })
    const store = createRedisRateLimitStore(adapter)
    let connected = false

    try {
      await adapter.connect()
      connected = true

      const firstHit = await store.hit('login:127.0.0.1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const secondHit = await store.hit('login:127.0.0.1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const thirdHit = await store.hit('login:127.0.0.1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const cleared = await store.clear('login:127.0.0.1')

      expect(firstHit.limited).toBe(false)
      expect(firstHit.snapshot.attempts).toBe(1)
      expect(secondHit.limited).toBe(false)
      expect(secondHit.snapshot.attempts).toBe(2)
      expect(thirdHit.limited).toBe(true)
      expect(thirdHit.snapshot.attempts).toBe(3)
      expect(cleared).toBe(true)
    } finally {
      try {
        if (connected) {
          await adapter.clearAll()
        }
      } finally {
        await adapter.close()
      }
    }
  }, 30_000)
})
