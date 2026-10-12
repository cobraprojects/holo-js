import { createNativeSessionStore } from './support/native-store'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import session, {
  configureSessionRuntime,
  normalizeSessionConfig,
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
  flashSession,
  takeSession,
  sessionRuntimeInternals,
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
  const date = new Date()
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
    const storeMap = await createNativeSessionStore('database')
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
        database: storeMap,
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
    expect(cookies.forget('custom')).toContain('Max-Age=0')
    expect(parseCookieHeader('a=1; b=two')).toEqual({ a: '1', b: 'two' })

    await invalidateSession('session_2')
    expect(await readSession('session_2')).toBeNull()
  })

  it('expires stale records and applies runtime cookie defaults and overrides', async () => {
    const expired = createRecord('expired', {
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    })
    const storeMap = await createNativeSessionStore('database')
    await storeMap.write(expired)
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
          secure: true,
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
        database: storeMap,
      },
    })

    expect(await readSession('expired')).toBeNull()
    expect(((await storeMap.read('expired')) !== null)).toBe(false)
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
    expect(() => cookie('plain', '1', { path: '/; Secure' })).toThrow('Cookie path')
    expect(() => cookie('plain', '1', { domain: 'bad domain.test' })).toThrow('Cookie domain')
    expect(() => cookie('plain', '1', { sameSite: 'none', secure: false })).toThrow('SameSite=None')
    expect(() => cookie('plain', '1', { partitioned: true, secure: false })).toThrow('Partitioned')
    expect(() => cookie('__Secure-session', '1', { secure: false, partitioned: false })).toThrow('__Secure-')
    expect(() => cookie('__Host-session', '1', { secure: true, path: '/admin' })).toThrow('__Host-')
  })

  it('keeps cookie helpers explicit and tolerant of malformed request headers', () => {
    expect(cookie('plain', 'value')).not.toContain('Max-Age=')
    expect(cookie('scoped', 'value', { domain: 'example.com' })).toContain('Domain=example.com')
    expect(sessionCookie('fallback')).toContain('holo_session=fallback')
    expect(rememberMeCookie('fallback')).toContain('holo_session_remember=fallback')
    expect(rememberMeCookie('fallback', { maxAge: 5 })).toContain('Max-Age=5')
    expect(cookies.forget('plain')).toContain('Max-Age=0')
    expect(parseCookieHeader(null)).toEqual({})
    expect(parseCookieHeader('lonely; ok=1')).toEqual({ ok: '1' })
    expect(parseCookieHeader('bad=%; holo_session=abc')).toEqual({
      holo_session: 'abc',
    })
    expect(parseCookieHeader('%=bad; theme=dark')).toEqual({
      theme: 'dark',
    })
  })

  it('surfaces runtime configuration errors and missing-session paths', async () => {
    await expect(readSession('missing')).rejects.toThrow('Session runtime is not configured yet')

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
      stores: {},
    })
    await expect(readSession('missing')).rejects.toThrow('Session store "database" is not configured')
    const storeMap = await createNativeSessionStore('database')
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
        database: storeMap,
      },
    })

    const generated = await createSession()
    expect(generated.id).toBeTypeOf('string')
    expect(generated.id).not.toHaveLength(0)
    const idBacked = await createSession({
      id: 'id-backed',
      data: {
        source: 'data',
      },
    })
    expect(idBacked).toMatchObject({
      id: 'id-backed',
      data: {
        source: 'data',
      },
    })
    const rotatedWithGeneratedId = await rotateSession('id-backed')
    expect(rotatedWithGeneratedId.id).not.toBe('id-backed')
    await storeMap.write(createRecord('stable-session', {
      expiresAt: new Date(Date.now() + 60_000),
    }))
    await expect(rotateSession('stable-session', {
      newId: 'stable-session',
    })).resolves.toMatchObject({
      id: 'stable-session',
    })
    expect(((await storeMap.read('stable-session')) !== null)).toBe(true)
    await expect(touchSession('missing')).resolves.toBeNull()
    await expect(rotateSession('missing')).rejects.toThrow('Session "missing" was not found')
    await expect(issueRememberMeToken('missing')).rejects.toThrow('Session "missing" was not found')

    await storeMap.write(createRecord('remember-without-hash'))
    await expect(consumeRememberMeToken(
      `remember-without-hash.${Date.now().toString(36)}.secret`,
    )).resolves.toBeNull()

    await storeMap.write(createRecord('legacy-remember', {
      expiresAt: new Date(Date.now() + 60_000),
      rememberTokenHash: sessionRuntimeInternals.hashRememberToken('secret'),
    }))
    await expect(consumeRememberMeToken('legacy-remember.secret')).resolves.toMatchObject({
      id: 'legacy-remember',
    })
    await expect(consumeRememberMeToken('legacy-remember.')).resolves.toBeNull()
    await expect(consumeRememberMeToken('legacy-remember.@.secret')).resolves.toBeNull()

    const rememberToken = await issueRememberMeToken(rotatedWithGeneratedId.id, {
      store: 'database',
    })
    await expect(consumeRememberMeToken(rememberToken, {
      store: 'database',
    })).resolves.toMatchObject({
      id: rotatedWithGeneratedId.id,
    })
    await expect(consumeRememberMeToken(
      `${rotatedWithGeneratedId.id}.${Date.now().toString(36)}.wrong`,
      { store: 'database' },
    )).resolves.toBeNull()
  })

  it('caps touched sessions at the configured absolute lifetime', async () => {
    const storeMap = await createNativeSessionStore('database')
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
        database: storeMap,
      },
    })

    const createdAt = new Date(Date.now() - (25 * 60_000))
    await storeMap.write(createRecord('active-session', {
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

  it('starts new sessions capped by absolute lifetime when it is shorter', async () => {
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
        idleTimeout: 30,
        absoluteLifetime: 15,
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
      name: 'absolute-capped',
    })
    const remainingLifetimeMs = created.expiresAt.getTime() - before

    expect(remainingLifetimeMs).toBeLessThanOrEqual((15 * 60_000) + 1000)
    expect(remainingLifetimeMs).toBeGreaterThan((14 * 60_000))
  })

  it('rejects a remember-me token after the base session has expired', async () => {
    const storeMap = await createNativeSessionStore('database')
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
        database: storeMap,
      },
    })

    const created = await createSession({
      name: 'remembered',
    })
    const rememberToken = await issueRememberMeToken(created.id)
    const stored = (await storeMap.read(created.id))
    expect(stored?.rememberTokenHash).toBeTypeOf('string')

    await storeMap.write(Object.freeze({
      ...stored!,
      expiresAt: new Date(Date.now() - 1000),
    }))

    await expect(consumeRememberMeToken(rememberToken)).resolves.toBeNull()
    expect(((await storeMap.read(created.id)) !== null)).toBe(false)

    await expect(consumeRememberMeToken(rememberToken)).resolves.toBeNull()
  })

  it('finds remember-me tokens across configured stores when no store hint is provided', async () => {
    const databaseMap = await createNativeSessionStore('database')
    const fileMap = await createNativeSessionStore('file')
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
        database: databaseMap,
        file: fileMap,
      },
    })

    const created = await createSession({
      name: 'remembered-secondary',
      store: 'file',
    })
    const rememberToken = await issueRememberMeToken(created.id, {
      store: 'file',
    })
    await databaseMap.write(createRecord(created.id, {
      rememberTokenHash: 'not-the-token',
    }))

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
    await Promise.all(Array.from({ length: 8 }, (_, index) => store.write(createRecord('file-session', {
      data: { index },
    }))))
    const reloaded = await store.read('file-session')
    expect(reloaded?.id).toBe(record.id)
    expect(typeof reloaded?.data.index).toBe('number')
    expect(fileSessionDriverInternals.getRecordPath(root, 'file-session')).toContain('file-session')
    expect(fileSessionDriverInternals.deserializeRecord(await readFile(
      fileSessionDriverInternals.getRecordPath(root, 'file-session'),
      'utf8',
    ))).toEqual(reloaded)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(fileSessionDriverInternals.getRecordPath(root, 'file-session'))).mode & 0o777).toBe(0o600)
    expect((await readdir(root)).every(name => !name.endsWith('.tmp') && !name.endsWith('.lock'))).toBe(true)
    await store.delete('file-session')
    expect(await store.read('file-session')).toBeNull()
  })

  it('surfaces non-missing file store read errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-file-'))
    tempDirs.push(root)
    const store = createFileSessionStore(root)
    const recordPath = fileSessionDriverInternals.getRecordPath(root, 'blocked-session')

    await mkdir(recordPath)

    await expect(store.read('blocked-session')).rejects.toMatchObject({
      code: 'EISDIR',
    })
    await expect(store.read('missing-session')).resolves.toBeNull()
  })

  it('preserves existing filesystem data when the session directory cannot be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-session-file-lock-'))
    tempDirs.push(root)
    const blocked = join(root, 'blocked')
    await writeFile(blocked, 'preserved')
    const store = createFileSessionStore(blocked)
    await expect(store.write(createRecord('locked-session'))).rejects.toThrow()
    expect(await readFile(blocked, 'utf8')).toBe('preserved')
    expect(await readdir(root)).toEqual(['blocked'])
  })

  it('adapts database and redis stores through their driver contracts', async () => {
    const databaseMap = await createNativeSessionStore('database')
    const redisMap = await createNativeSessionStore('redis')
    const databaseStore = databaseMap
    const redisStore = redisMap

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

  it('moves public session data from a basic database adapter into a real file store', async () => {
    const databaseRecords = await createNativeSessionStore('database')
    const fileRecords = await createNativeSessionStore('file')

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
          read: sessionId => databaseRecords.read(sessionId),
          write: record => databaseRecords.write(record),
          delete: sessionId => databaseRecords.delete(sessionId),
        }),
        file: fileRecords,
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
    expect(((await databaseRecords.read('session_1')) !== null)).toBe(false)
    expect((await fileRecords.read('session_2'))).toMatchObject({
      id: 'session_2',
      store: 'file',
      data: {
        cartId: 'cart_1',
      },
    })
  })
  it('fails closed when rotating a native store with private flash capability into another store', async () => {
    const database = await createNativeSessionStore('database')
    const file = await createNativeSessionStore('file')
    configureSessionRuntime({ config: normalizeSessionConfig({ driver: 'database', stores: {
      database: { driver: 'database', connection: 'default', table: 'sessions' },
      file: { driver: 'file', path: './storage/sessions' },
    } }), stores: { database, file } })
    const original = await createSession({ id: 'private-session', data: { userId: 42 } })
    await flashSession(original.id, 'notice', 'preserved')
    await expect(rotateSession(original.id, { store: 'file', newId: 'replacement' })).rejects.toThrow('private flash state')
    expect(await database.read(original.id)).toMatchObject({ data: { userId: 42 } })
    expect(await file.read('replacement')).toBeNull()
    expect(await takeSession(original.id, 'notice')).toBe('preserved')
  })

})
