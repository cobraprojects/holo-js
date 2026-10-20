import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
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
  it('merges a data key into the current Redis record only while that session still exists', async () => {
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
    const now = new Date()
    const previousId = randomUUID()
    const replacementId = randomUUID()
    const record = (id: string, data: Record<string, unknown>): SessionRecord => ({
      id,
      store: 'redis',
      data,
      createdAt: now,
      lastActivityAt: now,
      expiresAt: new Date(Date.now() + 60_000),
    })

    try {
      await adapter.connect()
      if (!store.setDataIfAbsent) throw new Error('Redis session store must support atomic data writes.')
      await store.write(record(previousId, { userId: 42 }))

      await expect(store.setDataIfAbsent(previousId, '_token', 'token-a')).resolves.toEqual({ found: true, value: 'token-a' })
      await expect(store.read(previousId)).resolves.toMatchObject({ data: { userId: 42, _token: 'token-a' } })

      await store.rotate?.(previousId, record(replacementId, { userId: 42, login: 'fresh' }))
      await expect(store.setDataIfAbsent(previousId, '_token', 'stale-token')).resolves.toEqual({ found: false })

      await expect(store.read(previousId)).resolves.toBeNull()
      await expect(store.read(replacementId)).resolves.toMatchObject({ data: { userId: 42, login: 'fresh' } })
    } finally {
      await store.delete(previousId)
      await store.delete(replacementId)
      await adapter.close()
    }
  }, 30_000)
  it('stores each session under its own Redis key with no hash tag, and sets a Redis expiry on it', async () => {
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
    const sessionId = randomUUID()
    const raw = new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    const now = new Date()

    try {
      await adapter.connect()
      await store.write({
        id: sessionId,
        store: 'redis',
        data: {},
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await expect(raw.keys(`${prefix}*`)).resolves.toEqual([`${prefix}holo:session:${sessionId}`])
      const ttl = await raw.pttl(`${prefix}holo:session:${sessionId}`)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(60_000)
    } finally {
      await store.delete(sessionId)
      await raw.quit()
      await adapter.close()
    }
  }, 30_000)
  it('stores a session with the default empty prefix under the holo:session: namespace, never as a bare id', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    })
    const store = createRedisSessionStore(adapter)
    const sessionId = randomUUID()
    const raw = new Redis({ host: '127.0.0.1', port: 6379, db: 0 })
    const now = new Date()

    try {
      await adapter.connect()
      await store.write({
        id: sessionId,
        store: 'redis',
        data: {},
        createdAt: now,
        lastActivityAt: now,
        expiresAt: new Date(Date.now() + 60_000),
      })

      await expect(raw.exists(`holo:session:${sessionId}`)).resolves.toBe(1)
      await expect(raw.exists(sessionId)).resolves.toBe(0)
    } finally {
      await store.delete(sessionId)
      await raw.quit()
      await adapter.close()
    }
  }, 30_000)
})
