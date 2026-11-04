import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, type DatabaseContextOptions, type DriverAdapter } from '../../src'
import { defineTable } from './internal'

export async function openDatabase(driver: 'sqlite' | 'postgres' | 'mysql' = 'sqlite', options: Pick<DatabaseContextOptions, 'connectionName' | 'schemaName' | 'security' | 'logger' | 'concurrency'> & { wrapAdapter?: (adapter: DriverAdapter) => DriverAdapter } = {}) {
  const { wrapAdapter, ...databaseOptions } = options
  const database = process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
  const createdAdapter = driver === 'sqlite' ? createSQLiteAdapter({ filename: ':memory:' })
    : driver === 'postgres' ? createPostgresAdapter({ config: {
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
      ...(databaseOptions.schemaName ? { options: `-c search_path="${databaseOptions.schemaName}"` } : {}),
    } }) : createMySQLAdapter({ config: {
      host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
      user: process.env.HOLO_MYSQL_USER ?? 'root',
      password: process.env.HOLO_MYSQL_PASSWORD ?? '',
      database,
    } })
  const adapter = wrapAdapter ? wrapAdapter(createdAdapter) : createdAdapter
  const db = createDatabase({ connectionName: 'default', ...databaseOptions, adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: db.getConnectionName(), connections: { [db.getConnectionName()]: db } }))
  const name = `holo_native_${randomUUID().replaceAll('-', '')}`
  const qualified = driver === 'postgres' ? `public.${name}` : driver === 'mysql' ? `${database}.${name}` : name
  const fixture = driver === 'postgres' ? qualified : name
  const schema = createSchemaService(db)
  onTestFinished(async () => {
    try { await schema.dropTable(fixture) } finally { await db.disconnect() }
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

