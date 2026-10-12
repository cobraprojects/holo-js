import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, type DatabaseContextOptions } from '../../src'
import { defineTable } from './internal'

export async function openDatabase(driver: 'sqlite' | 'postgres' | 'mysql' = 'sqlite', options: Pick<DatabaseContextOptions, 'connectionName' | 'security' | 'logger' | 'concurrency'> = {}) {
  const database = process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
  const adapter = driver === 'sqlite' ? createSQLiteAdapter({ filename: ':memory:' })
    : driver === 'postgres' ? createPostgresAdapter({ config: {
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
    } }) : createMySQLAdapter({ config: {
      host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
      user: process.env.HOLO_MYSQL_USER ?? 'root',
      password: process.env.HOLO_MYSQL_PASSWORD ?? '',
      database,
    } })
  const db = createDatabase({ connectionName: 'default', ...options, adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: db.getConnectionName(), connections: { [db.getConnectionName()]: db } }))
  const name = `holo_native_${randomUUID().replaceAll('-', '')}`
  const schema = createSchemaService(db)
  onTestFinished(async () => {
    try { await schema.dropTable(name) } finally { await db.disconnect() }
  })
  await schema.createTable(name, table => {
    table.integer('id').primaryKey()
    table.string('name')
    table.boolean('active').default(false)
    table.json('settings').nullable()
  })
  const qualified = driver === 'postgres' ? `public.${name}` : driver === 'mysql' ? `${database}.${name}` : name
  const table = defineTable(qualified, { id: column.integer().primaryKey(), name: column.string(), active: column.boolean(), settings: column.json().nullable() })
  return { db, table, schema, adapter }
}

