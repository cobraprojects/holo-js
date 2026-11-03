import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConnectionManager, DB, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createDatabaseSessionStore, type SessionRecord, type SessionStore } from '@holo-js/session'
import sessionsMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'

const roots: string[] = []
const connections: DatabaseContext[] = []

afterEach(async () => {
  resetDB()
  await Promise.all(connections.splice(0).map(connection => connection.disconnect()))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function record(id: string, expiresAt: Date): SessionRecord {
  const now = new Date()
  return { id, store: 'database', data: { userId: 42 }, createdAt: now, lastActivityAt: now, expiresAt }
}

async function createStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'holo-session-gc-db-'))
  roots.push(root)
  const connection = new DatabaseContext({
    driver: 'sqlite',
    dialect: createDialect('sqlite'),
    adapter: createSQLiteAdapter({ filename: join(root, 'sessions.sqlite') }),
  })
  connections.push(connection)
  await connection.getAdapter().ensureDatabaseExists?.()
  await sessionsMigration.up({ db: connection, schema: createSchemaService(connection) })
  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  return createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'main'))
}

it('deletes expired database session rows and keeps live ones', async () => {
  const store = await createStore()
  const expired = record(randomUUID(), new Date(Date.now() - 1_000))
  const live = record(randomUUID(), new Date(Date.now() + 60_000))
  await store.write(expired)
  await store.write(live)
  if (!store.sweepExpired) throw new Error('Database session stores must sweep expired rows.')

  await expect(store.sweepExpired(new Date())).resolves.toBe(1)

  await expect(store.read(expired.id)).resolves.toBeNull()
  await expect(store.read(live.id)).resolves.toMatchObject({ id: live.id })
})

it('stores session timestamps in the SQLite CURRENT_TIMESTAMP format and reads them back unchanged', async () => {
  const store = await createStore()
  const createdAt = new Date('2026-01-02T03:04:05.000Z')
  const expiresAt = new Date('2099-01-02T03:04:05.678Z')
  const stored = { id: randomUUID(), store: 'database', data: { userId: 42 }, createdAt, lastActivityAt: createdAt, expiresAt }
  await store.write(stored)

  const [row] = (await DB.connection().queryCompiled<Record<string, unknown>>({
    sql: 'SELECT "created_at", "expires_at" FROM "sessions" WHERE "id" = ?',
    bindings: [stored.id],
  })).rows
  expect(row).toEqual({ created_at: '2026-01-02 03:04:05', expires_at: '2099-01-02 03:04:05.678' })
  await expect(store.read(stored.id)).resolves.toMatchObject({ createdAt, lastActivityAt: createdAt, expiresAt })
})
