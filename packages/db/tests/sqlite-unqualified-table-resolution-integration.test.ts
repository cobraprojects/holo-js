import { afterEach, describe, expect, it } from 'vitest'
import { resetDB } from '../src'
import { openDatabase } from './support/database'

async function openSQLite(statements: readonly string[]) {
  const { db, schema } = await openDatabase('sqlite')
  for (const sql of statements) await db.executeCompiled({ sql, source: 'schema' })
  const indexNames = async (database: string) => (await db.introspectCompiled<{ name: string }>({
    sql: `SELECT name FROM "${database}".sqlite_master WHERE type = 'index' AND tbl_name = 'items' ORDER BY name`,
    source: 'test',
  })).rows.map(row => row.name)
  const tableSql = async (database: string) => (await db.introspectCompiled<{ sql: string }>({
    sql: `SELECT sql FROM "${database}".sqlite_master WHERE type = 'table' AND name = 'items'`,
    source: 'test',
  })).rows[0]?.sql
  return { db, schema, indexNames, tableSql }
}

const ATTACH_ARCHIVE = `ATTACH DATABASE ':memory:' AS archive`

describe('SQLite unqualified table resolution', () => {
  afterEach(() => {
    resetDB()
  })

  it('introspects the temp table that shadows a main table', async () => {
    const { schema } = await openSQLite([
      'CREATE TABLE "main"."parents" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "main"."items" ("id" INTEGER PRIMARY KEY, "main_only" TEXT, "parent_id" INTEGER REFERENCES "parents" ("id"))',
      'CREATE INDEX "main"."main_idx" ON "items" ("main_only")',
      'CREATE TABLE "temp"."owners" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "temp"."items" ("id" INTEGER PRIMARY KEY, "temp_only" TEXT, "owner_id" INTEGER REFERENCES "owners" ("id"))',
      'CREATE INDEX "temp"."temp_idx" ON "items" ("temp_only")',
    ])

    expect((await schema.getColumns('items')).map(column => column.name)).toEqual(['id', 'temp_only', 'owner_id'])
    expect((await schema.getIndexes('items')).map(index => index.name)).toEqual(['temp_idx'])
    expect((await schema.getForeignKeys('items')).map(foreignKey => [foreignKey.from, foreignKey.table])).toEqual([['owner_id', 'owners']])
    expect((await schema.getColumns('main.items')).map(column => column.name)).toEqual(['id', 'main_only', 'parent_id'])
  })

  it('introspects a table that exists only in an attached database', async () => {
    const { schema } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."parents" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "archive"."items" ("id" INTEGER PRIMARY KEY, "code" TEXT, "parent_id" INTEGER REFERENCES "parents" ("id"))',
      'CREATE INDEX "archive"."archived_code_idx" ON "items" ("code")',
    ])

    expect((await schema.getColumns('items')).map(column => column.name)).toEqual(['id', 'code', 'parent_id'])
    expect((await schema.getIndexes('items')).map(index => index.name)).toEqual(['archived_code_idx'])
    expect((await schema.getForeignKeys('items')).map(foreignKey => [foreignKey.from, foreignKey.table])).toEqual([['parent_id', 'parents']])
  })

  it('drops the column-covered index of the shadowing temp table, not the main one', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT, "b" TEXT)',
      'CREATE INDEX "main"."old_idx" ON "items" ("a")',
      'CREATE TABLE "temp"."items" ("a" TEXT, "b" TEXT)',
      'CREATE INDEX "temp"."old_idx" ON "items" ("b")',
      'CREATE INDEX "temp"."temp_a_idx" ON "items" ("a")',
    ])

    await schema.table('items', table => table.dropIndex(['a']))

    expect(await indexNames('main')).toEqual(['old_idx'])
    expect(await indexNames('temp')).toEqual(['old_idx'])
  })

  it('refuses to drop a main index that the shadowing temp table does not have', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT, "b" TEXT)',
      'CREATE INDEX "main"."old_idx" ON "items" ("a")',
      'CREATE TABLE "temp"."items" ("a" TEXT, "b" TEXT)',
      'CREATE INDEX "temp"."old_idx" ON "items" ("b")',
    ])

    await expect(schema.table('items', table => table.dropIndex(['a']))).rejects.toThrow()

    expect(await indexNames('main')).toEqual(['old_idx'])
    expect(await indexNames('temp')).toEqual(['old_idx'])
  })

  it('drops an index by name from the shadowing temp table', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT)',
      'CREATE INDEX "main"."shared_idx" ON "items" ("a")',
      'CREATE TABLE "temp"."items" ("a" TEXT)',
      'CREATE INDEX "temp"."shared_idx" ON "items" ("a")',
    ])

    await schema.table('items', table => table.dropIndex('shared_idx'))

    expect(await indexNames('main')).toEqual(['shared_idx'])
    expect(await indexNames('temp')).toEqual([])
  })

  it('drops the column-covered index of a table that exists only in an attached database', async () => {
    const { schema, indexNames } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."items" ("a" TEXT, "b" TEXT)',
      'CREATE INDEX "archive"."archived_a_idx" ON "items" ("a")',
    ])

    await schema.table('items', table => table.dropIndex(['a']))

    expect(await indexNames('archive')).toEqual([])
  })

  it('drops the column-covered unique index of the shadowing temp table', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT, "b" TEXT)',
      'CREATE UNIQUE INDEX "main"."main_a_unique" ON "items" ("a")',
      'CREATE TABLE "temp"."items" ("a" TEXT, "b" TEXT)',
      'CREATE UNIQUE INDEX "temp"."temp_a_unique" ON "items" ("a")',
    ])

    await schema.table('items', table => table.dropUnique(['a']))

    expect(await indexNames('main')).toEqual(['main_a_unique'])
    expect(await indexNames('temp')).toEqual([])
  })

  it('drops the column-covered inline unique of the shadowing temp table', async () => {
    const { schema, tableSql } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT UNIQUE, "b" TEXT)',
      'CREATE TABLE "temp"."items" ("a" TEXT, "b" TEXT UNIQUE, UNIQUE ("a"))',
    ])

    await schema.table('items', table => table.dropUnique(['a']))

    expect(await tableSql('main')).toBe('CREATE TABLE "items" ("a" TEXT UNIQUE, "b" TEXT)')
    expect(await tableSql('temp')).toContain('"b" TEXT UNIQUE')
    expect(await tableSql('temp')).not.toContain('UNIQUE ("a")')
  })

  it('drops the column-covered unique index of a table that exists only in an attached database', async () => {
    const { schema, indexNames } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."items" ("a" TEXT, "b" TEXT)',
      'CREATE UNIQUE INDEX "archive"."archived_a_unique" ON "items" ("a")',
    ])

    await schema.table('items', table => table.dropUnique(['a']))

    expect(await indexNames('archive')).toEqual([])
  })

  it('drops the column-covered foreign key of the shadowing temp table', async () => {
    const { schema, tableSql } = await openSQLite([
      'CREATE TABLE "main"."parents" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "main"."items" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER, CONSTRAINT "main_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id"))',
      'CREATE TABLE "temp"."parents" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "temp"."items" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER REFERENCES "parents" ("id"))',
    ])

    await schema.table('items', table => table.dropForeign(['parent_id']))

    expect(await tableSql('main')).toContain('CONSTRAINT "main_parent_fk" FOREIGN KEY')
    expect(await tableSql('temp')).not.toContain('REFERENCES')
  })

  it('drops the column-covered foreign key of a table that exists only in an attached database', async () => {
    const { schema, tableSql } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."parents" ("id" INTEGER PRIMARY KEY)',
      'CREATE TABLE "archive"."items" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER, CONSTRAINT "archived_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "parents" ("id"))',
    ])

    await schema.table('items', table => table.dropForeign(['parent_id']))

    expect(await tableSql('archive')).not.toContain('REFERENCES')
  })

  it('creates an index on a table that exists only in an attached database', async () => {
    const { schema, indexNames } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."items" ("id" INTEGER PRIMARY KEY, "code" TEXT)',
    ])

    await schema.table('items', (table) => {
      table.index(['code'])
      table.unique(['id', 'code'])
    })

    expect(await indexNames('archive')).toEqual(['items_code_index', 'items_id_code_unique'])
    expect(await indexNames('main')).toEqual([])
  })

  it('adds a unique column to a table that exists only in an attached database', async () => {
    const { schema, indexNames } = await openSQLite([
      ATTACH_ARCHIVE,
      'CREATE TABLE "archive"."items" ("id" INTEGER PRIMARY KEY)',
    ])

    await schema.table('items', (table) => {
      table.string('code').nullable().unique()
    })

    expect((await schema.getColumns('items')).map(column => column.name)).toEqual(['id', 'code'])
    expect(await indexNames('archive')).toEqual(['items_code_unique'])
  })

  it('creates an index on the shadowing temp table', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "main"."items" ("a" TEXT)',
      'CREATE TABLE "temp"."items" ("a" TEXT)',
    ])

    await schema.table('items', table => table.index(['a']))

    expect(await indexNames('temp')).toEqual(['items_a_index'])
    expect(await indexNames('main')).toEqual([])
  })

  it('creates a main table with its indexes while a temp table of the same name exists', async () => {
    const { schema, indexNames } = await openSQLite([
      'CREATE TABLE "temp"."items" ("a" TEXT)',
      'CREATE INDEX "temp"."items_a_index" ON "items" ("a")',
    ])

    await schema.createTable('items', (table) => {
      table.string('a')
      table.index(['a'])
    })

    expect(await indexNames('main')).toEqual(['items_a_index'])
    expect(await indexNames('temp')).toEqual(['items_a_index'])
    expect((await schema.getColumns('main.items')).map(column => column.name)).toEqual(['a'])
  })
})
