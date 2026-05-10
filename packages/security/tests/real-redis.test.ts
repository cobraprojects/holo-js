import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRedisRateLimitStore } from '../src'
import { createSecurityRedisAdapter } from '../src/drivers/redis-adapter'

describe('@holo-js/security real Redis usage', () => {
  it('stores rate-limit hits through the public Redis store adapter', async () => {
    const prefix = `holo:security:${randomUUID()}:`
    const adapter = createSecurityRedisAdapter({
      connection: 'default',
      prefix,
      host: '127.0.0.1',
      port: 6379,
      db: 0,
    })
    const store = createRedisRateLimitStore(adapter)

    try {
      await adapter.connect()

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
      await adapter.clearAll()
      await adapter.close()
    }
  }, 30_000)
})
