import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import session, {
  configureSessionRuntime,
  createDatabaseSessionStore,
  createFileSessionStore,
  createRedisSessionStore,
  createSession,
  fileSessionDriverInternals,
  flashSession,
  getSessionRuntime,
  readSession,
  resetSessionRuntime,
  rotateSession,
  takeSession,
  type SessionRecord,
  type SessionStore,
} from '../src'

const tempDirectories: string[] = []

function configuration(store: SessionStore) {
  return {
    config: {
      absoluteLifetime: 120,
      cookie: {
        httpOnly: true,
        maxAge: 120,
        name: 'holo_session',
        partitioned: false,
        path: '/',
        sameSite: 'lax' as const,
        secure: false,
      },
      driver: 'file',
      idleTimeout: 30,
      rememberMeLifetime: 1_440,
      stores: { file: { driver: 'file' as const, name: 'file', path: './sessions' } },
    },
    stores: { file: store },
  }
}

function record(id: string, store = 'database'): SessionRecord {
  const createdAt = new Date()
  return {
    createdAt,
    data: { visible: true },
    expiresAt: new Date(createdAt.getTime() + 60_000),
    id,
    lastActivityAt: createdAt,
    store,
  }
}

afterEach(async () => {
  resetSessionRuntime()
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('atomic session flash values', () => {
  it('exposes named, runtime, and facade methods with one-time file-backed values', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-1', store: 'file', data: { visible: true } })

    expect(session.flash).toBe(flashSession)
    expect(session.take).toBe(takeSession)
    expect(getSessionRuntime().flash).toBe(flashSession)
    expect(getSessionRuntime().take).toBe(takeSession)

    await session.flash('session-1', 'panels.admin.effects', { count: 2, ok: true })
    expect((await readSession('session-1', { store: 'file' }))?.data).toEqual({ visible: true })
    const persisted = await readFile(fileSessionDriverInternals.getRecordPath(root, 'session-1'), 'utf8')
    expect(persisted).not.toContain('panels.admin.effects')
    await expect(session.take('session-1', 'panels.admin.effects')).resolves.toEqual({ count: 2, ok: true })
    await expect(session.take('session-1', 'panels.admin.effects')).resolves.toBeUndefined()
  })

  it('serializes concurrent file flashes under the session lock without losing keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-lock-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    await store.write(record('session-lock', 'file'))

    await Promise.all(Array.from({ length: 24 }, (_, index) => store.flash?.('session-lock', `key.${index}`, index)))
    const values = await Promise.all(Array.from({ length: 24 }, (_, index) => store.take?.('session-lock', `key.${index}`)))
    expect(values.map(value => value?.value)).toEqual(Array.from({ length: 24 }, (_, index) => index))
    await expect(store.take?.('session-lock', 'key.0')).resolves.toEqual({ found: false })
  })

  it('preserves private flash values when rotating a file-backed session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-rotate-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-before-rotation', store: 'file' })
    await flashSession('session-before-rotation', 'notice', 'preserved')

    const rotated = await rotateSession('session-before-rotation', {
      newId: 'session-after-rotation',
    })

    expect(rotated.id).toBe('session-after-rotation')
    await expect(takeSession('session-after-rotation', 'notice')).resolves.toBe('preserved')
    await expect(takeSession('session-before-rotation', 'notice')).resolves.toBeUndefined()
  })

  it('does not replace an existing file-backed session during rotation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-collision-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    configureSessionRuntime(configuration(store))
    await createSession({ name: 'session-before-rotation', store: 'file' })
    await createSession({ name: 'session-after-rotation', store: 'file', data: { owner: 'destination' } })

    await expect(rotateSession('session-before-rotation', { newId: 'session-after-rotation' }))
      .rejects.toThrow('Session "session-after-rotation" already exists')
    await expect(store.read('session-before-rotation')).resolves.toMatchObject({ id: 'session-before-rotation' })
    await expect(store.read('session-after-rotation')).resolves.toMatchObject({
      id: 'session-after-rotation',
      data: { owner: 'destination' },
    })
  })

  it('refuses rotations that could silently discard private flash state', async () => {
    const existing = record('session-before-rotation', 'file')
    const write = vi.fn(async () => undefined)
    const remove = vi.fn(async () => undefined)
    const source: SessionStore = {
      delete: remove,
      flash: async () => undefined,
      read: async sessionId => sessionId === existing.id ? existing : null,
      take: async () => ({ found: false }),
      write,
    }
    configureSessionRuntime(configuration(source))

    await expect(rotateSession(existing.id, { newId: 'session-after-rotation' }))
      .rejects.toThrow('does not support private-state-preserving rotation')
    expect(write).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('refuses to move private flash state between independent stores', async () => {
    const existing = record('session-before-move', 'file')
    const source: SessionStore = {
      delete: vi.fn(async () => undefined),
      flash: async () => undefined,
      read: async sessionId => sessionId === existing.id ? existing : null,
      rotate: async () => undefined,
      take: async () => ({ found: false }),
      write: async () => undefined,
    }
    const targetWrite = vi.fn(async () => undefined)
    const target: SessionStore = {
      delete: async () => undefined,
      read: async () => null,
      write: targetWrite,
    }
    const bindings = configuration(source)
    configureSessionRuntime({
      ...bindings,
      config: {
        ...bindings.config,
        stores: {
          ...bindings.config.stores,
          target: { driver: 'file', name: 'target', path: './target-sessions' },
        },
      },
      stores: { file: source, target },
    })

    await expect(rotateSession(existing.id, { newId: 'session-after-move', store: 'target' }))
      .rejects.toThrow('cannot be rotated between stores')
    expect(targetWrite).not.toHaveBeenCalled()
  })

  it('delegates optional atomic capabilities through database and Redis wrappers', async () => {
    const databaseFlash = vi.fn(async () => undefined)
    const databaseTake = vi.fn(async () => ({ found: true, value: 'database' }))
    const databaseRotate = vi.fn(async () => undefined)
    const redisFlash = vi.fn(async () => undefined)
    const redisTake = vi.fn(async () => ({ found: true, value: 'redis' }))
    const redisRotate = vi.fn(async () => undefined)
    const database = createDatabaseSessionStore({ delete: async () => undefined, flash: databaseFlash, read: async () => null, rotate: databaseRotate, take: databaseTake, write: async () => undefined })
    const redis = createRedisSessionStore({ del: async () => undefined, flash: redisFlash, get: async () => null, rotate: redisRotate, set: async () => undefined, take: redisTake })
    const rotatedRecord = record('rotated')

    await database.flash?.('database-session', 'notice', false)
    await redis.flash?.('redis-session', 'notice', null)
    await database.rotate?.('database-session', rotatedRecord)
    await redis.rotate?.('redis-session', rotatedRecord)
    await expect(database.take?.('database-session', 'notice')).resolves.toEqual({ found: true, value: 'database' })
    await expect(redis.take?.('redis-session', 'notice')).resolves.toEqual({ found: true, value: 'redis' })
    expect(databaseFlash).toHaveBeenCalledWith('database-session', 'notice', false)
    expect(redisFlash).toHaveBeenCalledWith('redis-session', 'notice', null)
    expect(databaseRotate).toHaveBeenCalledWith('database-session', rotatedRecord)
    expect(redisRotate).toHaveBeenCalledWith('redis-session', rotatedRecord)
  })

  it('throws clearly for stores without atomic capabilities and never falls back to read/write', async () => {
    const read = vi.fn(async () => null)
    const write = vi.fn(async () => undefined)
    configureSessionRuntime(configuration({ delete: async () => undefined, read, write }))

    await expect(flashSession('session-1', 'notice', true)).rejects.toThrow('does not support atomic flash operations')
    await expect(takeSession('session-1', 'notice')).rejects.toThrow('does not support atomic flash operations')
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects unsafe keys and non-JSON, non-finite, circular, or oversized values before storage', async () => {
    const flash = vi.fn(async () => undefined)
    const take = vi.fn(async () => ({ found: true, value: Number.NaN }))
    configureSessionRuntime(configuration({ delete: async () => undefined, flash, read: async () => null, take, write: async () => undefined }))
    const circular: { self?: unknown } = {}
    circular.self = circular
    const symbolKeyed = { [Symbol('hidden')]: true }
    const invalidValues: unknown[] = [undefined, Number.NaN, Number.POSITIVE_INFINITY, () => undefined, new Date(), circular, { nested: undefined }, symbolKeyed, 'x'.repeat(65_537)]

    for (const key of ['', ' leading', '__proto__', 'constructor', 'a/b', `a${'x'.repeat(128)}`]) {
      await expect(flashSession('session-1', key, true)).rejects.toThrow('Flash keys')
    }
    for (const value of invalidValues) await expect(flashSession('session-1', 'safe.key', value)).rejects.toThrow()
    await expect(takeSession('session-1', 'safe.key')).rejects.toThrow('finite JSON numbers')
    expect(flash).not.toHaveBeenCalled()
  })

  it('rejects deeply nested flash values with a bounded validation error', async () => {
    const flash = vi.fn(async () => undefined)
    configureSessionRuntime(configuration({ delete: async () => undefined, flash, read: async () => null, write: async () => undefined }))
    const deeplyNested = Array.from({ length: 10_000 }).reduce<Record<string, unknown>>(
      value => ({ value }),
      {},
    )

    await expect(flashSession('session-1', 'safe.key', deeplyNested)).rejects.toThrow('cannot exceed 32 levels')
    expect(flash).not.toHaveBeenCalled()
  })

  it('rejects accessors before they can change between validation and serialization', async () => {
    const flash = vi.fn(async () => undefined)
    configureSessionRuntime(configuration({ delete: async () => undefined, flash, read: async () => null, write: async () => undefined }))
    const deeplyNested = Array.from({ length: 40 }).reduce<Record<string, unknown>>(
      value => ({ value }),
      {},
    )
    let reads = 0
    const value = {
      get message() {
        reads += 1
        return reads === 1 ? 'safe' : deeplyNested
      },
    }

    await expect(flashSession('session-1', 'safe.key', value)).rejects.toThrow('accessors')
    expect(flash).not.toHaveBeenCalled()
  })

  it('removes private file flash state when the session is deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-delete-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    await store.write(record('session-delete', 'file'))
    await store.flash?.('session-delete', 'notice', 'saved')
    await store.delete('session-delete')

    await expect(store.read('session-delete')).resolves.toBeNull()
    await expect(store.take?.('session-delete', 'notice')).resolves.toEqual({ found: false })
  })

  it('does not flash or take values from expired file sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-flash-expired-'))
    tempDirectories.push(root)
    const store = createFileSessionStore(root)
    const expired = record('session-expired', 'file')
    await store.write({ ...expired, expiresAt: new Date(Date.now() - 1) })

    await expect(store.flash?.('session-expired', 'notice', 'saved')).rejects.toThrow('was not found')
    await expect(store.take?.('session-expired', 'notice')).resolves.toEqual({ found: false })
    await expect(store.read('session-expired')).resolves.toBeNull()
  })
})
