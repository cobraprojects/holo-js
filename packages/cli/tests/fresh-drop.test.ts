import { describe, expect, it, onTestFinished } from 'vitest'
import { createDatabase, createDialect, createSchemaService } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { dropAllTablesForFresh } from '../src/fresh-drop'

describe('dropAllTablesForFresh', () => {
  it('drops the main tables and leaves temp tables that shadow them', async () => {
    const db = createDatabase({ connectionName: 'default', adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
    onTestFinished(() => db.disconnect())
    for (const sql of [
      'CREATE TABLE "main"."items" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "main"."orders" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "temp"."items" ("id" INTEGER PRIMARY KEY)',
    ]) await db.executeCompiled({ sql, source: 'test' })

    await dropAllTablesForFresh(db, createSchemaService(db))

    const tables = await db.introspectCompiled<{ schema: string, name: string }>({
      sql: 'SELECT schema, name FROM pragma_table_list WHERE name NOT LIKE \'sqlite_%\' ORDER BY schema, name',
      source: 'test',
    })
    expect(tables.rows).toEqual([{ schema: 'temp', name: 'items' }])
  })
})
