import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { describe, expect, it, onTestFinished } from 'vitest'
import { column, createDatabase, createDialect, defineGeneratedTable, queryCacheInternals, type DatabaseDependencyInvalidationEvent } from '../src'
import type { DatabaseMutationEvent } from '../src/cache'
import { mysqlIntegration, mysqlTestConnection, openDatabase } from './support/database'

describe.runIf(mysqlIntegration)('MySQL inserts by a user that cannot read the table back', () => {
  it('keep the inserted row and publish an insert without rows', async () => {
    const { db, schema } = await openDatabase('mysql')
    const name = `holo_insert_only_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.string('name')
      table.string('note').nullable()
    })
    onTestFinished(() => schema.dropTable(name))
    const user = `holo_ins_${randomUUID().replaceAll('-', '').slice(0, 16)}`
    const password = randomUUID()
    const connection = mysqlTestConnection()
    await db.executeCompiled({ sql: `CREATE USER '${user}'@'%' IDENTIFIED BY '${password}'`, source: 'schema' })
    onTestFinished(() => db.executeCompiled({ sql: `DROP USER IF EXISTS '${user}'@'%'`, source: 'schema' }).then(() => undefined))
    await db.executeCompiled({ sql: `GRANT INSERT ON \`${connection.database}\`.\`${name}\` TO '${user}'@'%'`, source: 'schema' })
    const writer = createDatabase({ adapter: createMySQLAdapter({ config: { ...connection, user, password } }), dialect: createDialect('mysql') })
    onTestFinished(() => writer.disconnect())
    const notes = defineGeneratedTable(name, { id: column.id(), name: column.string(), note: column.string().nullable() })
    const mutations: DatabaseMutationEvent[] = []
    onTestFinished(() => queryCacheInternals.resetDatabaseDependencyInvalidationListeners())
    queryCacheInternals.onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { mutations?: readonly DatabaseMutationEvent[] }) => {
      mutations.push(...event.mutations ?? [])
    })

    await expect(writer.table(notes).insert({ id: 4, name: 'written' })).resolves.toMatchObject({ affectedRows: 1 })

    expect(await db.table(notes).get()).toEqual([{ id: 4, name: 'written', note: null }])
    expect(mutations.map(mutation => [mutation.kind, mutation.rows])).toEqual([['insert', undefined]])
  })
})
