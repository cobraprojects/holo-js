import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRedisSessionStore, type SessionRecord } from '../src'
import { createSessionRedisAdapter } from '../src/drivers/redis-adapter'

describe('@holo-js/session real Redis usage', () => {
  it('writes, reads, and deletes sessions through the public Redis store adapter', async () => {
    const prefix = `holo:session:${randomUUID()}:`
    const adapter = createSessionRedisAdapter({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix,
    })
    const store = createRedisSessionStore(adapter)
    const now = new Date('2026-05-09T12:00:00.000Z')
    const sessionId = randomUUID()
    const record: SessionRecord = {
      id: sessionId,
      store: 'redis',
      data: {
        userId: 42,
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(Date.now() + 60_000),
    }

    try {
      await adapter.connect()
      await store.write(record)

      const saved = await store.read(sessionId)
      await store.delete(sessionId)

      expect(saved).toEqual(record)
      await expect(store.read(sessionId)).resolves.toBeNull()
    } finally {
      await store.delete(sessionId)
      await adapter.close()
    }
  }, 30_000)
})
