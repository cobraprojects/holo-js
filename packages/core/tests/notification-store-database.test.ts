import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ConnectionManager,
  DatabaseContext,
  clearGeneratedTables,
  configureDB,
  createDialect,
  createSchemaService,
  holoRuntimeInternals,
  registerGeneratedTables,
  resetDB,
} from '@holo-js/db'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import notificationsMigration from '../../../apps/blog-next/server/db/migrations/2026_04_25_044032_create_notifications'
import { createCoreNotificationStore } from '../src/portable/notificationPersistence'

type Driver = 'sqlite' | 'postgres' | 'mysql'

const postgres = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
  password: process.env.HOLO_POSTGRES_PASSWORD,
}
const mysql = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD ?? '',
}
const enabled: Readonly<Record<Driver, boolean>> = {
  sqlite: true,
  postgres: process.env.HOLO_POSTGRES_INTEGRATION === '1',
  mysql: process.env.HOLO_MYSQL_INTEGRATION === '1',
}

function connect(driver: Driver, database: string): DatabaseContext {
  const adapter = driver === 'sqlite'
    ? createSQLiteAdapter({ filename: ':memory:' })
    : driver === 'postgres'
      ? createPostgresAdapter({ config: { ...postgres, database, max: 2 } })
      : createMySQLAdapter({ config: { ...mysql, database, connectionLimit: 2 } })
  return new DatabaseContext({ connectionName: 'main', driver, dialect: createDialect(driver), adapter })
}

async function withDatabase(driver: Driver, run: (connection: DatabaseContext) => Promise<void>): Promise<void> {
  if (driver === 'sqlite') {
    const connection = connect(driver, ':memory:')
    try {
      await run(connection)
    } finally {
      await connection.disconnect()
    }
    return
  }

  const name = `notifications_${randomUUID().replaceAll('-', '')}`
  const admin = connect(driver, driver)
  const connection = connect(driver, name)
  try {
    await admin.executeCompiled({ sql: `CREATE DATABASE ${name}`, source: 'schema' })
    await run(connection)
  } finally {
    await connection.disconnect()
    await admin.executeCompiled({ sql: driver === 'postgres' ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` : `DROP DATABASE IF EXISTS ${name}`, source: 'schema' })
    await admin.disconnect()
  }
}

afterEach(() => {
  resetDB()
  clearGeneratedTables()
})

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`notification store on ${driver}`, () => {
    it.skipIf(!enabled[driver])('lists notifications matching a data path once the Generated schema describes the notifications table', async () => {
      await withDatabase(driver, async (connection) => {
        await notificationsMigration.up({ db: connection, schema: createSchemaService(connection) })
        configureDB(new ConnectionManager({ defaultConnection: 'main', connections: { main: connection } }))
        const generated = await holoRuntimeInternals.createSchemaReader(connection).readGeneratedSchema()
        registerGeneratedTables(Object.fromEntries(generated.map(table => [table.tableName, table])))
        const store = createCoreNotificationStore({
          database: { defaultConnection: 'main', connections: {} },
          notifications: { table: 'notifications', queue: {} },
        } as never)
        const recipient = { id: 'user-1', type: 'users' }
        const createdAt = new Date('2026-01-01T00:00:00.000Z')
        for (const [id, tenant] of [['in-tenant', 'tenant-1'], ['other-tenant', 'tenant-2']] as const) {
          await store.create({
            id,
            type: 'invoice-paid',
            notifiableType: recipient.type,
            notifiableId: recipient.id,
            data: { tenant: { id: tenant } },
            readAt: null,
            createdAt,
            updatedAt: createdAt,
          })
        }

        const page = await store.list(
          { recipient, dataMatches: [{ path: ['tenant', 'id'], value: 'tenant-1' }] },
          { limit: 20, offset: 0 },
        )

        expect(page.records.map(record => [record.id, record.data])).toEqual([['in-tenant', { tenant: { id: 'tenant-1' } }]])
        expect(page.total).toBe(1)
      })
    }, 30_000)
  })
}
