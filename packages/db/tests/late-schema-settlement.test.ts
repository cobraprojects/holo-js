import { Client } from 'pg'
import { createConnection } from 'mysql2/promise'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { describe, expect, it, onTestFinished } from 'vitest'
import cache, { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { createDatabase, createDialect, onDatabaseDependencyInvalidated, queryCacheInternals, unsafeSql } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase, postgresTestConnection } from './support/database'

for (const driver of ['postgres', 'mysql'] as const) {
  describe.runIf(integrationDrivers([driver]).length > 0)(`${driver} late schema settlement`, () => {
    it('invalidates again when timed-out DDL actually replaces the table', async () => {
      const { db: reader, table } = await openDatabase(driver)
      configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
      onTestFinished(() => resetCacheRuntime())
      const client = driver === 'postgres' ? new Client(postgresTestConnection()) : await createConnection({ ...mysqlTestConnection(), multipleStatements: true })
      if (client instanceof Client) await client.connect()
      const adapter = client instanceof Client ? createPostgresAdapter({ client }) : createMySQLAdapter({ client })
      const ddl = createDatabase({ adapter, dialect: createDialect(driver), security: { allowUnsafeRawSql: true } })
      onTestFinished(() => ddl.disconnect())
      const name = table.tableName.split('.').at(-1)!
      const quoted = driver === 'postgres' ? `"${name}"` : `\`${name}\``
      await reader.table(name).insert({ id: 1, name: 'original' })
      const names = async () => (await reader.table(name).orderBy('id').cache(60).get()).map(row => row.name)
      expect(await names()).toEqual(['original'])
      const notifications: unknown[] = []
      const stop = onDatabaseDependencyInvalidated(event => { notifications.push(event) })
      onTestFinished(stop)
      const statement = `SELECT ${driver === 'postgres' ? 'pg_sleep' : 'SLEEP'}(0.2); DROP TABLE ${quoted}; CREATE TABLE ${quoted} (id INTEGER PRIMARY KEY, name VARCHAR(255) NOT NULL)`

      await expect(ddl.unsafeExecute(unsafeSql(statement), { timeoutMs: 20 })).rejects.toThrow(/timed out/)
      expect(notifications).toHaveLength(1)
      expect(await names()).toEqual(['original'])
      await adapter.query('SELECT 1')

      expect(notifications).toHaveLength(2)
      expect(await names()).toEqual([])
    })
  })
}

it.runIf(integrationDrivers(['postgres']).length > 0)('does not retain an in-flight custom cache fill after session uncertainty or reconnect', async () => {
  let started!: () => void
  let release!: () => void
  const readStarted = new Promise<void>(resolve => { started = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  let block = false
  const { db, table, schema } = await openDatabase('postgres', {
    security: { allowUnsafeRawSql: true },
    logger: { onQuerySuccess: async entry => {
      if (block && entry.source?.startsWith('query:select:')) {
        block = false
        started()
        await resume
      }
    } },
  })
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  onTestFinished(() => resetCacheRuntime())
  await db.table(table.tableName).insert({ id: 1, name: 'old' })
  const key = `session-fill:${table.tableName}`
  const read = () => db.table(table.tableName).cache({ key, ttl: 60, invalidate: [] }).get()
  block = true
  const fill = read()
  await readStarted
  try {
    await db.unsafeExecute(unsafeSql(`CREATE TEMPORARY TABLE ${table.tableName.split('.').at(-1)!} (id INTEGER PRIMARY KEY, name VARCHAR(50))`))
  } finally { release() }
  expect((await fill).map(row => row.name)).toEqual(['old'])
  expect(await cache.get(key)).toBeNull()
  await db.disconnect()
  await schema.dropTable(table.tableName)
  await schema.createTable(table.tableName, columns => { columns.integer('id').primaryKey(); columns.string('name') })
  await db.table(table.tableName).insert({ id: 2, name: 'new' })
  expect((await read()).map(row => row.name)).toEqual(['new'])
})

it('preserves committed remote table publications when local writes require full refresh', async () => {
  const { db, table } = await openDatabase('sqlite', { security: { allowUnsafeRawSql: true } })
  const dependencies: string[][] = []
  const stop = queryCacheInternals.onDatabaseDependencyInvalidationPublished(event => { dependencies.push([...event.dependencies]) })
  onTestFinished(stop)
  await db.unsafeExecute(unsafeSql('CREATE TABLE audit_log (id INTEGER)'))
  await db.table(table.tableName).insert({ id: 1, name: 'root' })
  await db.transaction(async tx => { await tx.table(table.tableName).insert({ id: 2, name: 'committed' }) })
  await expect(db.transaction(async tx => {
    await tx.table(table.tableName).insert({ id: 3, name: 'rolled back' })
    throw new Error('rollback')
  })).rejects.toThrow('rollback')
  expect(dependencies).toEqual([[`db:default:${table.tableName}`], [`db:default:${table.tableName}`]])
  expect((await db.table(table.tableName).orderBy('id').get()).map(row => row.name)).toEqual(['root', 'committed'])
})
