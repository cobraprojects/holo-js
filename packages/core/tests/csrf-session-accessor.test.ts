import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as sessionModule from '@holo-js/session'
import { configureSessionRuntime, createFileSessionStore, normalizeSessionConfig, type SessionRecord, type SessionStore } from '@holo-js/session'
import { createSessionRedisAdapter } from '@holo-js/session/drivers/redis-adapter'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createDatabaseSessionStore } from '@holo-js/session'
import sessionsMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'
import { createCsrfSessionAccessor } from '../src/portable/csrfSession'
import { startRedisService } from '../../session/tests/support/redis'

const roots: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  configureSessionRuntime(undefined)
  resetDB()
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function record(id: string, store: string, data: Record<string, unknown>): SessionRecord {
  const now = new Date()
  return { id, store, data, createdAt: now, lastActivityAt: now, expiresAt: new Date(Date.now() + 60_000) }
}

function cookieHeader(sessionId: string): string {
  return `holo_session=${encodeURIComponent(sessionModule.getSessionRuntime().sessionCookie(sessionId).split(';', 1)[0]!.slice('holo_session='.length))}`
}

function requestFor(cookie?: string): Request {
  return new Request('https://app.test/form', cookie ? { headers: { cookie } } : undefined)
}

function rotateOnFirstRead(store: SessionStore, sessionId: string, replacement: SessionRecord): SessionStore {
  let rotated = false
  return {
    ...store,
    async read(id) {
      const current = await store.read(id)
      if (id === sessionId && !rotated) {
        rotated = true
        await store.rotate?.(sessionId, replacement)
      }
      return current
    },
  }
}

async function expectRotatedSessionIsNotRestored(store: SessionStore, storeName: string): Promise<void> {
  const previousId = randomUUID()
  const replacementId = randomUUID()
  await store.write(record(previousId, storeName, { userId: 42, _token: null }))
  const wrapped = rotateOnFirstRead(store, previousId, record(replacementId, storeName, { userId: 42, login: 'fresh' }))
  configureSessionRuntime({
    config: normalizeSessionConfig({ driver: storeName, stores: { [storeName]: { driver: 'file', path: '.' } } }),
    stores: { [storeName]: wrapped },
    appKey: 'csrf-session-accessor-key',
  })
  const accessor = createCsrfSessionAccessor(sessionModule, () => 'holo_session')

  const result = await accessor.write(requestFor(cookieHeader(previousId)), 'token-a')

  expect(result.token).toBe('token-a')
  expect(result.cookies.length).toBe(1)
  await expect(store.read(previousId)).resolves.toBeNull()
  await expect(store.read(replacementId)).resolves.toMatchObject({ data: { userId: 42, login: 'fresh' } })
  const issuedId = sessionModule.getSessionRuntime().decryptCookie('holo_session', decodeURIComponent(result.cookies[0]!.split(';', 1)[0]!.slice('holo_session='.length)))
  expect(issuedId).toBeTruthy()
  expect(issuedId).not.toBe(previousId)
  await expect(store.read(issuedId!)).resolves.toMatchObject({ data: { _token: 'token-a' } })
}

async function createStore(driver: string): Promise<SessionStore> {
  if (driver === 'redis') {
    const service = await startRedisService()
    const adapter = createSessionRedisAdapter({
      name: 'redis', driver: 'redis', connection: 'default', host: '127.0.0.1',
      port: service.ports[0]!, db: 0, prefix: `holo:csrf-accessor:${randomUUID()}:`,
    })
    cleanups.push(async () => { await adapter.close() })
    await adapter.connect()
    return sessionModule.createRedisSessionStore(adapter)
  }
  const root = await mkdtemp(join(tmpdir(), 'holo-csrf-accessor-'))
  roots.push(root)
  if (driver === 'file') return createFileSessionStore(root)
  const connection = new DatabaseContext({
    driver: 'sqlite', dialect: createDialect('sqlite'),
    adapter: createSQLiteAdapter({ filename: join(root, 'sessions.sqlite') }),
  })
  cleanups.push(async () => { await connection.disconnect() })
  await connection.initialize()
  await sessionsMigration.up({ db: connection, schema: createSchemaService(connection) })
  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  return createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'main'))
}

for (const driver of ['file', 'database', 'redis']) {
  describe.skipIf(driver === 'redis' && process.env.HOLO_SESSION_REAL_REDIS !== '1')(`CSRF session accessor on ${driver}`, () => {
    it('persists missing or invalid reserved tokens and preserves other data', async () => {
      const store = await createStore(driver)
      configureSessionRuntime({
        config: normalizeSessionConfig({ driver, stores: { [driver]: { driver: 'file', path: '.' } } }),
        stores: { [driver]: store }, appKey: 'csrf-session-accessor-key',
      })
      const accessor = createCsrfSessionAccessor(sessionModule, () => 'holo_session')
      for (const invalid of [undefined, null, '', 0, false, [], {}]) {
        const id = randomUUID()
        await store.write(record(id, driver, { userId: 42, ...(invalid === undefined ? {} : { _token: invalid }) }))
        await expect(accessor.write(requestFor(cookieHeader(id)), 'token-a')).resolves.toEqual({ token: 'token-a', cookies: [] })
        await expect(store.read(id)).resolves.toMatchObject({ data: { userId: 42, _token: 'token-a' } })
      }
    })

    it('keeps the token persisted by a concurrent initializer', async () => {
      const store = await createStore(driver)
      const id = randomUUID()
      await store.write(record(id, driver, { userId: 42, _token: null }))
      configureSessionRuntime({
        config: normalizeSessionConfig({ driver, stores: { [driver]: { driver: 'file', path: '.' } } }),
        stores: { [driver]: store }, appKey: 'csrf-session-accessor-key',
      })
      const accessor = createCsrfSessionAccessor(sessionModule, () => 'holo_session')
      const [first, second] = await Promise.all([
        accessor.write(requestFor(cookieHeader(id)), 'first'),
        accessor.write(requestFor(cookieHeader(id)), 'second'),
      ])
      expect(first.token).toBe(second.token)
      await expect(store.read(id)).resolves.toMatchObject({ data: { userId: 42, _token: first.token } })
    })

    it('does not restore an invalid-token session rotated away between read and write', async () => {
      await expectRotatedSessionIsNotRestored(await createStore(driver), driver)
    })
  })
}
