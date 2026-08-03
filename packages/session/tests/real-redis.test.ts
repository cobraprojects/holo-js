import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createRedisSessionStore, type SessionRecord } from '../src'
import { createSessionRedisAdapter } from '../src/drivers/redis-adapter'

const describeRealRedis = process.env.HOLO_SESSION_REAL_REDIS === '1'
  ? describe
  : describe.skip

describeRealRedis('@holo-js/session real Redis usage', () => {
  it('writes, atomically flashes, takes, and deletes sessions through the public Redis store adapter', async () => {
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
        emptyItems: [],
        userId: 42,
      },
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(Date.now() + 60_000),
    }

    try {
      await adapter.connect()
      await store.write(record)
      if (!store.flash || !store.take) throw new Error('Redis session store must support atomic flash operations.')
      await store.flash(sessionId, 'notice', [{ actions: [], title: 'Saved' }])
      await store.write({
        ...record,
        lastActivityAt: new Date(),
        expiresAt: new Date(Date.now() + 120_000),
      })

      const saved = await store.read(sessionId)
      const taken = await Promise.all([
        store.take(sessionId, 'notice'),
        store.take(sessionId, 'notice'),
      ])
      await store.delete(sessionId)

      expect(saved).toMatchObject({ id: record.id, data: record.data })
      expect(taken).toContainEqual({ found: true, value: [{ actions: [], title: 'Saved' }] })
      expect(taken).toContainEqual({ found: false })
      await expect(store.read(sessionId)).resolves.toBeNull()
    } finally {
      await store.delete(sessionId)
      await adapter.close()
    }
  }, 30_000)
})
