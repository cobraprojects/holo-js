import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { ConnectionManager, DatabaseContext, configureDB, createDialect, createSchemaService, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { createDatabaseSessionStore, createFileSessionStore, createRedisSessionStore, type SessionStore } from '@holo-js/session'
import { createSessionRedisAdapter } from '../../../session/src/drivers/redis-adapter'
import { startRedisService } from '../../../session/tests/support/redis'
import sessionsMigration from '../../../../apps/blog-next/server/db/migrations/2026_04_25_044033_create_sessions'
import { createCoreDatabaseSessionAdapter } from '../../src/portable/sessionPersistence'

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-session-store-'))
  onTestFinished(() => rm(root, { force: true, recursive: true }))
  return root
}

async function createFileStore(): Promise<SessionStore> {
  return createFileSessionStore(await temporaryDirectory())
}

async function createDatabaseStore(): Promise<SessionStore> {
  const connection = new DatabaseContext({
    driver: 'sqlite',
    dialect: createDialect('sqlite'),
    adapter: createSQLiteAdapter({ filename: join(await temporaryDirectory(), 'sessions.sqlite') }),
  })
  onTestFinished(async () => {
    resetDB()
    await connection.disconnect()
  })
  await connection.getAdapter().ensureDatabaseExists?.()
  await sessionsMigration.up({ db: connection, schema: createSchemaService(connection) })
  configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
  return createDatabaseSessionStore(createCoreDatabaseSessionAdapter('sessions', 'main'))
}

async function createRedisStore(): Promise<SessionStore> {
  const redis = await startRedisService()
  const adapter = createSessionRedisAdapter({
    name: 'redis',
    driver: 'redis',
    connection: 'default',
    host: '127.0.0.1',
    port: redis.ports[0]!,
    db: 0,
    prefix: '',
  })
  onTestFinished(() => adapter.close())
  await adapter.connect()
  return createRedisSessionStore(adapter)
}

export const sessionStoreFactories = [
  { name: 'file', create: createFileStore },
  { name: 'database', create: createDatabaseStore },
  { name: 'redis', create: createRedisStore },
] as const
