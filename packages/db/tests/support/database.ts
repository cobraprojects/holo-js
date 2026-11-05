import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, type DatabaseContextOptions, type DriverAdapter } from '../../src'
import { defineTable } from './internal'

type TestDriver = 'sqlite' | 'postgres' | 'mysql'

function integrationEnabled(driver: TestDriver): boolean {
  return driver === 'sqlite'
    || (driver === 'postgres' && process.env.HOLO_POSTGRES_INTEGRATION === '1')
    || (driver === 'mysql' && process.env.HOLO_MYSQL_INTEGRATION === '1')
}

export function integrationDrivers<const D extends TestDriver>(drivers: readonly D[]): D[] {
  return drivers.filter(integrationEnabled)
}

export const postgresIntegration = integrationEnabled('postgres')
export const mysqlIntegration = integrationEnabled('mysql')

const systemDatabases = new Set(['postgres', 'template0', 'template1', 'mysql', 'information_schema', 'performance_schema', 'sys'])

function scratchDatabase(flag: string, variable: string): string {
  if (process.env[flag] !== '1') {
    throw new Error(`Real database tests must be gated on ${flag}=1 before they connect.`)
  }
  const database = process.env[variable]
  if (!database || systemDatabases.has(database.toLowerCase())) {
    throw new Error(`${variable} must name a scratch test database; real database tests never fall back to a default or system database.`)
  }
  return database
}

export function postgresTestConnection() {
  const database = scratchDatabase('HOLO_POSTGRES_INTEGRATION', 'HOLO_POSTGRES_DATABASE')
  return {
    host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
    user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
    password: process.env.HOLO_POSTGRES_PASSWORD,
    database,
  }
}

export function mysqlTestConnection() {
  const database = scratchDatabase('HOLO_MYSQL_INTEGRATION', 'HOLO_MYSQL_DATABASE')
  return {
    host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
    user: process.env.HOLO_MYSQL_USER ?? 'root',
    password: process.env.HOLO_MYSQL_PASSWORD ?? '',
    database,
  }
}

async function dropFixture(driver: 'postgres' | 'mysql', fixture: string) {
  const adapter = driver === 'postgres'
    ? createPostgresAdapter({ config: postgresTestConnection() })
    : createMySQLAdapter({ config: mysqlTestConnection() })
  const db = createDatabase({ adapter, dialect: createDialect(driver) })
  try {
    await createSchemaService(db).dropTable(fixture)
  } finally {
    await db.disconnect()
  }
}

export async function openDatabase(driver: TestDriver = 'sqlite', options: Pick<DatabaseContextOptions, 'connectionName' | 'schemaName' | 'security' | 'logger' | 'concurrency'> & { wrapAdapter?: (adapter: DriverAdapter) => DriverAdapter } = {}) {
  const { wrapAdapter, ...databaseOptions } = options
  const mysql = driver === 'mysql' ? mysqlTestConnection() : undefined
  const createdAdapter = mysql ? createMySQLAdapter({ config: mysql })
    : driver === 'postgres' ? createPostgresAdapter({ config: {
      ...postgresTestConnection(),
      ...(databaseOptions.schemaName ? { options: `-c search_path="${databaseOptions.schemaName}"` } : {}),
    } }) : createSQLiteAdapter({ filename: ':memory:' })
  const adapter = wrapAdapter ? wrapAdapter(createdAdapter) : createdAdapter
  const db = createDatabase({ connectionName: 'default', ...databaseOptions, adapter, dialect: createDialect(driver) })
  configureDB(createConnectionManager({ defaultConnection: db.getConnectionName(), connections: { [db.getConnectionName()]: db } }))
  const name = `holo_native_${randomUUID().replaceAll('-', '')}`
  const qualified = driver === 'postgres' ? `public.${name}` : mysql ? `${mysql.database}.${name}` : name
  const fixture = driver === 'postgres' ? qualified : name
  const schema = createSchemaService(db)
  onTestFinished(async () => {
    await db.disconnect()
    if (driver !== 'sqlite') await dropFixture(driver, fixture)
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

