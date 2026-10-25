import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Redis from 'ioredis'
import { describe, expect, it } from 'vitest'
import { configureSessionRuntime, createFileSessionStore, createRedisSessionStore, getSessionRuntime, resetSessionRuntime, type SessionRecord } from '../src'
import { createSessionRedisAdapter } from '../src/drivers/redis-adapter'

const describeRealRedis = process.env.HOLO_SESSION_REAL_REDIS === '1'
  ? describe
  : describe.skip

function withoutPrivateFlash(store: ReturnType<typeof createFileSessionStore>) {
  const { rotate: _rotate, flash: _flash, take: _take, ...plain } = store
  return plain
}

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
  })
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
  })
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
  })
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
  })
  it('lets exactly one of several concurrent rotations claim a replacement id on a Redis store', async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), 'session-redis-rotation-'))
    const prefix = `holo:session:${randomUUID()}:`
    const targetStore = { name: 'target', driver: 'redis' as const, connection: 'default', host: '127.0.0.1', port: 6379, db: 0, prefix }
    const adapter = createSessionRedisAdapter(targetStore)
    const cookie = { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax' as const, partitioned: false, maxAge: 120 }
    try {
      await adapter.connect()
      configureSessionRuntime({
        config: {
          driver: 'source',
          stores: {
            source: { name: 'source', driver: 'file', path: sourceDirectory },
            target: targetStore,
          },
          cookie,
          idleTimeout: 30,
          absoluteLifetime: 120,
          rememberMeLifetime: 1440,
        },
        stores: { source: withoutPrivateFlash(createFileSessionStore(sourceDirectory)), target: createRedisSessionStore(adapter) },
      })
      const session = getSessionRuntime()
      const replacementId = `shared-${randomUUID()}`
      const sources = await Promise.all(Array.from({ length: 4 }, (_, index) => session.create({ store: 'source', data: { index } })))
      const results = await Promise.allSettled(sources.map(source => session.rotate(source.id, { store: 'target', newId: replacementId })))
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      for (const result of results.filter(result => result.status === 'rejected')) {
        expect(String(result.reason)).toContain('already exists')
      }
      const survivors = await Promise.all(sources.map(source => session.read(source.id, { store: 'source' })))
      expect(survivors.filter(Boolean)).toHaveLength(3)
      await expect(session.read(replacementId, { store: 'target' })).resolves.toMatchObject({ id: replacementId })
    } finally {
      resetSessionRuntime()
      await adapter.close()
      await rm(sourceDirectory, { recursive: true, force: true })
    }
  })
})
