import { onDatabaseDependencyInvalidated, resetDatabaseDependencyInvalidationListeners } from '../src/cache'
import { randomUUID } from 'node:crypto'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { describe, expect, it, onTestFinished } from 'vitest'
import { column, createDatabase, createDialect, defineGeneratedTable, queryCacheInternals } from '../src'
import { mysqlIntegration, mysqlTestConnection, openDatabase } from './support/database'

describe.runIf(mysqlIntegration)('MySQL inserts read back for realtime listeners', () => {
  it('keep the inserted row when the user cannot read the table back', async () => {
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
    onTestFinished(() => resetDatabaseDependencyInvalidationListeners())
    onDatabaseDependencyInvalidated(() => {})

    await expect(writer.table(notes).insert({ id: 4, name: 'written' })).resolves.toMatchObject({ affectedRows: 1 })

    expect(await db.table(notes).get()).toEqual([{ id: 4, name: 'written', note: null }])
  })

  it('read back only the written rows of a table keyed by a composite key', async () => {
    const reads: number[] = []
    const { db, schema } = await openDatabase('mysql', { logger: { onQuerySuccess: (entry) => {
      if (entry.source?.startsWith('query:select:')) reads.push(entry.rowCount ?? 0)
    } } })
    const name = `holo_pairs_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await db.executeCompiled({ sql: `CREATE TABLE \`${name}\` (\`a\` INT NOT NULL, \`b\` INT NOT NULL, \`note\` VARCHAR(20) NULL, PRIMARY KEY (\`a\`, \`b\`))`, source: 'schema' })
    onTestFinished(() => schema.dropTable(name))
    const pairs = defineGeneratedTable(name, { a: column.integer().primaryKey(), b: column.integer().primaryKey(), note: column.string().nullable() })
    await db.table(pairs).insert([{ a: 1, b: 2 }, { a: 2, b: 1 }])
    onTestFinished(() => resetDatabaseDependencyInvalidationListeners())
    onDatabaseDependencyInvalidated(() => {})
    reads.length = 0

    await db.table(pairs).insert([{ a: 1, b: 1 }, { a: 2, b: 2 }])

    expect(reads).toEqual([2])
  })
})
