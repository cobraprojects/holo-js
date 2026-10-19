import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
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
  await connection.initialize()
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
