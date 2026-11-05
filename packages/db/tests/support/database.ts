import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, type DatabaseContextOptions, type DriverAdapter } from '../../src'
import { mysqlTestConnection, postgresTestConnection, type TestDriver } from '../../../../tests/support/real-database'
import { defineTable } from './internal'

export { integrationDrivers, mysqlIntegration, mysqlTestConnection, postgresIntegration, postgresTestConnection } from '../../../../tests/support/real-database'

type RealConnection = ReturnType<typeof postgresTestConnection> | ReturnType<typeof mysqlTestConnection>

function realConnection(driver: TestDriver): RealConnection | undefined {
  if (driver === 'postgres') return postgresTestConnection()
  if (driver === 'mysql') return mysqlTestConnection()
  return undefined
}

function createTestAdapter(driver: TestDriver, connection: RealConnection | undefined, schemaName?: string) {
  if (connection && driver === 'postgres') {
    return createPostgresAdapter({ config: { ...connection, ...(schemaName ? { options: `-c search_path="${schemaName}"` } : {}) } })
  }
  if (connection && driver === 'mysql') return createMySQLAdapter({ config: connection })
  return createSQLiteAdapter({ filename: ':memory:' })
}

async function dropFixture(driver: TestDriver, connection: RealConnection, fixture: string) {
  const db = createDatabase({ adapter: createTestAdapter(driver, connection), dialect: createDialect(driver) })
  try {
    await createSchemaService(db).dropTable(fixture)
  } finally {
    await db.disconnect()
  }
}

export async function openDatabase(driver: TestDriver = 'sqlite', options: Pick<DatabaseContextOptions, 'connectionName' | 'schemaName' | 'security' | 'logger' | 'concurrency'> & { wrapAdapter?: (adapter: DriverAdapter) => DriverAdapter } = {}) {
  const { wrapAdapter, ...databaseOptions } = options
  const connection = realConnection(driver)
  const createdAdapter = createTestAdapter(driver, connection, databaseOptions.schemaName)
  const adapter = wrapAdapter ? wrapAdapter(createdAdapter) : createdAdapter
  const db = createDatabase({ connectionName: 'default', ...databaseOptions, adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: db.getConnectionName(), connections: { [db.getConnectionName()]: db } }))
  const name = `holo_native_${randomUUID().replaceAll('-', '')}`
  const qualified = driver === 'postgres' ? `public.${name}` : driver === 'mysql' && connection ? `${connection.database}.${name}` : name
  const fixture = driver === 'postgres' ? qualified : name
  const schema = createSchemaService(db)
  onTestFinished(async () => {
    await db.disconnect()
    if (connection) await dropFixture(driver, connection, fixture)
  })
  if (driver === 'postgres' && databaseOptions.schemaName) {
    await db.executeCompiled({ sql: `CREATE SCHEMA IF NOT EXISTS "${databaseOptions.schemaName}"`, source: 'schema' })
  }
  await schema.createTable(fixture, table => {
    table.integer('id').primaryKey()
    table.string('name')
    table.boolean('active').default(false)
    table.json('settings').nullable()
  })
  const table = defineTable(qualified, { id: column.integer().primaryKey(), name: column.string(), active: column.boolean(), settings: column.json().nullable() })
  return { db, table, schema, adapter }
}

