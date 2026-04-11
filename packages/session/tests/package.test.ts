import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import session, {
  configureSessionRuntime,
  consumeRememberMeToken,
  cookie,
  cookies,
  createDatabaseSessionStore,
  createFileSessionStore,
  createRedisSessionStore,
  createSession,
  defineSessionConfig,
  fileSessionDriverInternals,
  getSessionRuntime,
  invalidateSession,
  issueRememberMeToken,
  parseCookieHeader,
  readSession,
  rememberMeCookie,
  resetSessionRuntime,
  rotateSession,
  sessionCookie,
  touchSession,
  type SessionRecord,
  writeSession,
} from '../src'
import type { SessionFacade } from '../src'

const tempDirs: string[] = []

afterEach(async () => {
  resetSessionRuntime()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function createRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  const date = new Date('2026-04-08T00:00:00.000Z')
  return Object.freeze({
    id,
    store: 'database',
    data: Object.freeze({ ok: true }),
    createdAt: date,
    lastActivityAt: date,
    expiresAt: new Date(date.getTime() + 60_000),
    ...overrides,
  })
}

describe('@holo-js/session package surface', () => {
  it('exposes default and named helpers plus cookie utilities', async () => {
    const storeMap = new Map<string, SessionRecord>()
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
        },
        cookie: {
          name: 'holo_session',
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 120,
        },
        idleTimeout: 30,
        absoluteLifetime: 120,
        rememberMeLifetime: 1440,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return storeMap.get(sessionId) ?? null
          },
          async write(record) {
            storeMap.set(record.id, record)
          },
          async delete(sessionId) {
            storeMap.delete(sessionId)
          },
        }),
      },
    })

    expect(defineSessionConfig({
      driver: 'database',
    })).toEqual({
      driver: 'database',
    })

    const callableSession = session as SessionFacade
    const created = await callableSession({
      name: 'session_1',
      value: {
        cartId: 'cart_1',
      },
    })
    expect(session.create).toBe(createSession)
    expect(session.write).toBe(writeSession)
    expect(session.read).toBe(readSession)
    expect(session.rotate).toBe(rotateSession)
    expect(session.invalidate).toBe(invalidateSession)
    expect(session.touch).toBe(touchSession)
    expect(getSessionRuntime().create).toBe(createSession)
    expect(getSessionRuntime().write).toBe(writeSession)
    expect(created.id).toBe('session_1')
    expect((await readSession('session_1'))?.data).toEqual({ cartId: 'cart_1' })

    const touched = await touchSession('session_1')
    expect(touched?.id).toBe('session_1')

    const rotated = await rotateSession('session_1', {
      newId: 'session_2',
    })
    expect(rotated.id).toBe('session_2')
    expect(await readSession('session_1')).toBeNull()
    expect((await readSession('session_2'))?.data).toEqual({ cartId: 'cart_1' })

    const rememberToken = await issueRememberMeToken('session_2')
    expect((await consumeRememberMeToken(rememberToken))?.id).toBe('session_2')
    expect(await consumeRememberMeToken('bad-token')).toBeNull()

    const updated = await writeSession({
      ...rotated,
      data: Object.freeze({ cartId: 'cart_2' }),
      rememberTokenHash: 'remember-hash',
    })
    expect(updated).toMatchObject({
      id: 'session_2',
      data: {
        cartId: 'cart_2',
      },
      rememberTokenHash: 'remember-hash',
    })
    expect(await readSession('session_2')).toMatchObject({
      data: {
        cartId: 'cart_2',
      },
      rememberTokenHash: 'remember-hash',
    })

    expect(cookie('custom', 'value', { httpOnly: false })).toContain('custom=value')
    expect(sessionCookie('session_2')).toContain('holo_session=session_2')
    expect(sessionCookie('session_2')).toContain('Max-Age=7200')
    expect(rememberMeCookie('remember_1')).toContain('holo_session_remember=remember_1')
    expect(rememberMeCookie('remember_1')).toContain('Max-Age=86400')
    expect(cookies.forget('custom')).toContain('Expires=')
    expect(parseCookieHeader('a=1; b=two')).toEqual({ a: '1', b: 'two' })

    await invalidateSession('session_2')
    expect(await readSession('session_2')).toBeNull()
  })

  it('expires stale records and applies runtime cookie defaults and overrides', async () => {
    const expired = createRecord('expired', {
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    const storeMap = new Map<string, SessionRecord>([['expired', expired]])
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
        },
        cookie: {
          name: 'my_session',
          path: '/admin',
          secure: false,
          httpOnly: true,
          sameSite: 'strict',
          partitioned: true,
          maxAge: 30,
        },
        idleTimeout: 15,
        absoluteLifetime: 30,
        rememberMeLifetime: 60,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return storeMap.get(sessionId) ?? null
          },
          async write(record) {
            storeMap.set(record.id, record)
          },
          async delete(sessionId) {
            storeMap.delete(sessionId)
          },
        }),
      },
    })

    expect(await readSession('expired')).toBeNull()
    expect(storeMap.has('expired')).toBe(false)
    expect(sessionCookie('value')).toContain('Path=/admin')
    expect(sessionCookie('value')).toContain('Max-Age=1800')
    expect(sessionCookie('value')).toContain('SameSite=Strict')
    expect(sessionCookie('value')).toContain('Partitioned')
    expect(cookie('override', '1', {
      path: '/',
      secure: true,
      sameSite: 'none',
      maxAge: 5,
    })).toContain('SameSite=None')
    expect(cookie('override', '1', {
      path: '/',
      secure: true,
      sameSite: 'none',
      maxAge: 5,
    })).toContain('Max-Age=5')
    expect(() => cookie('', '1')).toThrow('Cookie name must be a non-empty string')
  })

  it('caps touched sessions at the configured absolute lifetime', async () => {
    const storeMap = new Map<string, SessionRecord>()
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
        },
        cookie: {
          name: 'my_session',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 30,
        },
        idleTimeout: 15,
        absoluteLifetime: 30,
        rememberMeLifetime: 60,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return storeMap.get(sessionId) ?? null
          },
          async write(record) {
            storeMap.set(record.id, record)
          },
          async delete(sessionId) {
            storeMap.delete(sessionId)
          },
        }),
      },
    })

    const createdAt = new Date(Date.now() - (25 * 60_000))
    storeMap.set('active-session', createRecord('active-session', {
      createdAt,
      lastActivityAt: createdAt,
      expiresAt: new Date(Date.now() + (10 * 60_000)),
    }))

    const touched = await touchSession('active-session')
    expect(touched).not.toBeNull()
    expect(touched?.expiresAt.getTime()).toBe(createdAt.getTime() + (30 * 60_000))
  })

  it('starts new sessions with the shorter of the idle and absolute lifetimes', async () => {
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
        },
        cookie: {
          name: 'my_session',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 30,
        },
        idleTimeout: 15,
        absoluteLifetime: 30,
        rememberMeLifetime: 60,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read() {
            return null
          },
          async write() {
          },
          async delete() {
          },
        }),
      },
    })

    const before = Date.now()
    const created = await createSession({
      name: 'short-lived',
    })
    const remainingLifetimeMs = created.expiresAt.getTime() - before

    expect(remainingLifetimeMs).toBeLessThanOrEqual((15 * 60_000) + 1000)
    expect(remainingLifetimeMs).toBeGreaterThan((14 * 60_000))
  })

  it('accepts a remember-me token after the base session has expired but before its own TTL', async () => {
    const storeMap = new Map<string, SessionRecord>()
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
        },
        cookie: {
          name: 'my_session',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 30,
        },
        idleTimeout: 15,
        absoluteLifetime: 30,
        rememberMeLifetime: 60,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return storeMap.get(sessionId) ?? null
          },
          async write(record) {
            storeMap.set(record.id, record)
          },
          async delete(sessionId) {
            storeMap.delete(sessionId)
          },
        }),
      },
    })

    const created = await createSession({
      name: 'remembered',
    })
    const rememberToken = await issueRememberMeToken(created.id)
    const stored = storeMap.get(created.id)
    expect(stored?.rememberTokenHash).toBeTypeOf('string')

    storeMap.set(created.id, Object.freeze({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    }))

    await expect(consumeRememberMeToken(rememberToken)).resolves.toMatchObject({
      id: created.id,
    })

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + (61 * 60_000))
    await expect(consumeRememberMeToken(rememberToken)).resolves.toBeNull()
  })

  it('finds remember-me tokens across configured stores when no store hint is provided', async () => {
    const databaseMap = new Map<string, SessionRecord>()
    const fileMap = new Map<string, SessionRecord>()
    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
          file: {
            name: 'file',
            driver: 'file',
            path: './storage/framework/sessions',
          },
        },
        cookie: {
          name: 'my_session',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 30,
        },
        idleTimeout: 15,
        absoluteLifetime: 30,
        rememberMeLifetime: 60,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return databaseMap.get(sessionId) ?? null
          },
          async write(record) {
            databaseMap.set(record.id, record)
          },
          async delete(sessionId) {
            databaseMap.delete(sessionId)
          },
        }),
        file: {
          async read(sessionId) {
            return fileMap.get(sessionId) ?? null
          },
          async write(record) {
            fileMap.set(record.id, record)
          },
          async delete(sessionId) {
            fileMap.delete(sessionId)
          },
        },
      },
    })

    const created = await createSession({
      name: 'remembered-secondary',
      store: 'file',
    })
    const rememberToken = await issueRememberMeToken(created.id, {
      store: 'file',
    })

    await expect(consumeRememberMeToken(rememberToken)).resolves.toMatchObject({
      id: created.id,
      store: 'file',
    })
  })

  it('persists file-backed sessions on disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-file-'))
    tempDirs.push(root)
    const store = createFileSessionStore(root)
    const record = createRecord('file-session')

    await store.write(record)
    const reloaded = await store.read('file-session')
    expect(reloaded).toEqual(record)
    expect(fileSessionDriverInternals.getRecordPath(root, 'file-session')).toContain('file-session')
    expect(fileSessionDriverInternals.deserializeRecord(await readFile(
      fileSessionDriverInternals.getRecordPath(root, 'file-session'),
      'utf8',
    ))).toEqual(record)
    await store.delete('file-session')
    expect(await store.read('file-session')).toBeNull()
  })

  it('adapts database and redis stores through their driver contracts', async () => {
    const databaseMap = new Map<string, SessionRecord>()
    const redisMap = new Map<string, SessionRecord>()
    const databaseStore = createDatabaseSessionStore({
      async read(sessionId) {
        return databaseMap.get(sessionId) ?? null
      },
      async write(record) {
        databaseMap.set(record.id, record)
      },
      async delete(sessionId) {
        databaseMap.delete(sessionId)
      },
    })
    const redisStore = createRedisSessionStore({
      async get(sessionId) {
        return redisMap.get(sessionId) ?? null
      },
      async set(record) {
        redisMap.set(record.id, record)
      },
      async del(sessionId) {
        redisMap.delete(sessionId)
      },
    })

    const databaseRecord = createRecord('db-session')
    const redisRecord = createRecord('redis-session', {
      store: 'redis',
    })

    await databaseStore.write(databaseRecord)
    await redisStore.write(redisRecord)
    expect(await databaseStore.read('db-session')).toEqual(databaseRecord)
    expect(await redisStore.read('redis-session')).toEqual(redisRecord)
    await databaseStore.delete('db-session')
    await redisStore.delete('redis-session')
    expect(await databaseStore.read('db-session')).toBeNull()
    expect(await redisStore.read('redis-session')).toBeNull()
  })

  it('deletes the original record when rotating a session into another store', async () => {
    const databaseRecords = new Map<string, SessionRecord>()
    const fileRecords = new Map<string, SessionRecord>()

    configureSessionRuntime({
      config: {
        driver: 'database',
        stores: {
          database: {
            name: 'database',
            driver: 'database',
            connection: 'default',
            table: 'sessions',
          },
          file: {
            name: 'file',
            driver: 'file',
            path: './storage/framework/sessions',
          },
        },
        cookie: {
          name: 'holo_session',
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          partitioned: false,
          maxAge: 120,
        },
        idleTimeout: 30,
        absoluteLifetime: 120,
        rememberMeLifetime: 1440,
      },
      stores: {
        database: createDatabaseSessionStore({
          async read(sessionId) {
            return databaseRecords.get(sessionId) ?? null
          },
          async write(record) {
            databaseRecords.set(record.id, record)
          },
          async delete(sessionId) {
            databaseRecords.delete(sessionId)
          },
        }),
        file: createDatabaseSessionStore({
          async read(sessionId) {
            return fileRecords.get(sessionId) ?? null
          },
          async write(record) {
            fileRecords.set(record.id, record)
          },
          async delete(sessionId) {
            fileRecords.delete(sessionId)
          },
        }),
      },
    })

    await createSession({
      store: 'database',
      id: 'session_1',
      data: {
        cartId: 'cart_1',
      },
    })

    const rotated = await rotateSession('session_1', {
      store: 'file',
      newId: 'session_2',
    })

    expect(rotated).toMatchObject({
      id: 'session_2',
      store: 'file',
    })
    expect(databaseRecords.has('session_1')).toBe(false)
    expect(fileRecords.get('session_2')).toMatchObject({
      id: 'session_2',
      store: 'file',
      data: {
        cartId: 'cart_1',
      },
    })
  })
})
