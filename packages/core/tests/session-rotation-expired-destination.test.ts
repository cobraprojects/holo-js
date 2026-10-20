import { mkdtemp, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureSessionRuntime, createDatabaseSessionStore, createFileSessionStore, getSessionRuntime, resetSessionRuntime, type SessionRecord, type SessionStore } from '@holo-js/session'
import sessionsMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreDatabaseSessionAdapter } from '../src/portable/sessionPersistence'

const roots: string[] = []
const connections: DatabaseContext[] = []

afterEach(async () => {
  resetSessionRuntime()
  resetDB()
  await Promise.all(connections.splice(0).map(connection => connection.disconnect()))
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function record(id: string, expiresAt: Date, data: Record<string, unknown> = { userId: 42 }): SessionRecord {
  const now = new Date()
  return { id, store: 'database', data, createdAt: now, lastActivityAt: now, expiresAt }
}

async function createDatabaseStore(): Promise<SessionStore> {
  const root = await mkdtemp(join(tmpdir(), 'holo-session-rotation-db-'))
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

async function configureRuntime(database: SessionStore): Promise<{ readonly sourceDirectory: string }> {
  const sourceDirectory = await mkdtemp(join(tmpdir(), 'holo-session-rotation-source-'))
  roots.push(sourceDirectory)
  const { rotate: _rotate, flash: _flash, take: _take, ...plainSource } = createFileSessionStore(sourceDirectory)
  const cookie = { name: 'session', path: '/', secure: false, httpOnly: true, sameSite: 'lax' as const, partitioned: false, maxAge: 120 }
  configureSessionRuntime({
    config: {
      driver: 'source',
      stores: {
        source: { name: 'source', driver: 'file', path: sourceDirectory },
        database: { name: 'database', driver: 'database', connection: 'main', table: 'sessions' },
      },
      cookie,
      idleTimeout: 30,
      absoluteLifetime: 120,
      rememberMeLifetime: 1440,
    },
    stores: { source: plainSource, database },
  })
  return { sourceDirectory }
}

it('lets a rotation take a replacement id held only by an expired database row', async () => {
  const database = await createDatabaseStore()
  await configureRuntime(database)
  const session = getSessionRuntime()
  const replacementId = randomUUID()
  await database.write(record(replacementId, new Date(Date.now() - 1_000), { stale: true }))
  const source = await session.create({ store: 'source', data: { userId: 7 } })

  await expect(session.rotate(source.id, { store: 'database', newId: replacementId })).resolves.toMatchObject({ id: replacementId })

  await expect(session.read(replacementId, { store: 'database' })).resolves.toMatchObject({ id: replacementId, data: { userId: 7 } })
  await expect(session.read(source.id, { store: 'source' })).resolves.toBeNull()
})
