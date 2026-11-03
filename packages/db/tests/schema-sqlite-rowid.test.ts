import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { SchemaError } from '../src'
import { openDatabase } from './support/database'

function uniqueTableName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}

async function openTable(definition: string, options = '') {
  const database = await openDatabase('sqlite')
  const name = uniqueTableName('holo_rowids')
  onTestFinished(() => database.schema.dropTable(name))
  await database.adapter.execute(`CREATE TABLE "${name}" (${definition}) ${options}`)
  return { ...database, name }
}

async function openArticlesWithSearchIndex() {
  const database = await openDatabase('sqlite')
  const { adapter, schema } = database
  const articles = uniqueTableName('holo_articles')
  const search = `${articles}_search`
  onTestFinished(async () => {
    await adapter.execute(`DROP TABLE IF EXISTS "${search}"`)
    await schema.dropTable(articles)
  })
  await adapter.execute(`CREATE TABLE "${articles}" ("slug" TEXT NOT NULL, "body" TEXT)`)
  await adapter.execute(`CREATE VIRTUAL TABLE "${search}" USING fts5("body", content='${articles}')`)
  await adapter.execute(`INSERT INTO "${articles}" (rowid, "slug", "body") VALUES (100, 'first', 'holo searches rows'), (205, 'second', 'kept by rowid')`)
  await adapter.execute(`INSERT INTO "${search}" ("${search}") VALUES ('rebuild')`)

  const searchSlugs = async (term: string) => (await adapter.query<{ slug: string }>(
    `SELECT "${articles}"."slug" AS "slug" FROM "${search}" JOIN "${articles}" ON "${articles}".rowid = "${search}".rowid WHERE "${search}" MATCH ? ORDER BY "${articles}".rowid`,
    [term],
  )).rows.map(row => row.slug)
  const checkIntegrity = () => adapter.execute(`INSERT INTO "${search}" ("${search}", rank) VALUES ('integrity-check', 1)`)

  return { ...database, articles, searchSlugs, checkIntegrity }
}

describe('sqlite table rebuilds keep hidden rowids', () => {
  it('keeps an external-content search index consistent after adding a primary key', async () => {
    const { schema, articles, searchSlugs, checkIntegrity } = await openArticlesWithSearchIndex()

    await schema.table(articles, (table) => { table.primary(['slug']) })

    await checkIntegrity()
    expect(await searchSlugs('holo')).toEqual(['first'])
    expect(await searchSlugs('rowid')).toEqual(['second'])
  })

  it('keeps an external-content search index consistent after changing a column of a table with rowid gaps', async () => {
    const { schema, articles, searchSlugs, checkIntegrity } = await openArticlesWithSearchIndex()

    await schema.table(articles, (table) => { table.text('body').nullable().change() })

    await checkIntegrity()
    expect(await searchSlugs('holo')).toEqual(['first'])
    expect(await searchSlugs('rowid')).toEqual(['second'])
  })

  it('keeps hidden rowids through _rowid_ when a column is named rowid', async () => {
    const { adapter, schema, name } = await openTable('"rowid" TEXT, "slug" TEXT NOT NULL')
    await adapter.execute(`INSERT INTO "${name}" (_rowid_, "rowid", "slug") VALUES (10, 'label-a', 'a'), (20, 'label-b', 'b')`)

    await schema.table(name, (table) => { table.primary(['slug']) })

    expect((await adapter.query(`SELECT _rowid_ AS "hidden", "rowid" AS "label", "slug" FROM "${name}" ORDER BY _rowid_`)).rows).toEqual([
      { hidden: 10, label: 'label-a', slug: 'a' },
      { hidden: 20, label: 'label-b', slug: 'b' },
    ])
  })

  it('refuses to rebuild a table whose columns hide every rowid name and leaves it unchanged', async () => {
    const { adapter, schema, name } = await openTable('"rowid" TEXT, "_rowid_" TEXT, "oid" TEXT, "slug" TEXT NOT NULL')
    await adapter.execute(`INSERT INTO "${name}" ("slug") VALUES ('a')`)
    const definitionBefore = (await adapter.query<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])).rows

    await expect(schema.table(name, (table) => { table.primary(['slug']) })).rejects.toThrow(SchemaError)

    expect((await adapter.query<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name = ?', [name])).rows).toEqual(definitionBefore)
    expect((await adapter.query(`SELECT "slug" FROM "${name}"`)).rows).toEqual([{ slug: 'a' }])
  })

  it('rebuilds a WITHOUT ROWID table', async () => {
    const { adapter, schema, name } = await openTable('"slug" TEXT PRIMARY KEY, "body" TEXT', 'WITHOUT ROWID')
    await adapter.execute(`INSERT INTO "${name}" ("slug", "body") VALUES ('a', 'first'), ('b', 'second')`)

    await schema.table(name, (table) => { table.text('body').nullable().change() })

    expect((await adapter.query(`SELECT "slug", "body" FROM "${name}" ORDER BY "slug"`)).rows).toEqual([
      { slug: 'a', body: 'first' },
      { slug: 'b', body: 'second' },
    ])
  })

  it('keeps INTEGER PRIMARY KEY values as rowids even when columns hide every rowid name', async () => {
    const { adapter, schema, name } = await openTable('"id" INTEGER PRIMARY KEY, "rowid" TEXT, "_rowid_" TEXT, "oid" TEXT, "body" TEXT')
    await adapter.execute(`INSERT INTO "${name}" ("id", "body") VALUES (7, 'first'), (42, 'second')`)

    await schema.table(name, (table) => { table.text('body').nullable().change() })

    expect((await adapter.query(`SELECT "id", "body" FROM "${name}" ORDER BY "id"`)).rows).toEqual([
      { id: 7, body: 'first' },
      { id: 42, body: 'second' },
    ])
  })

  it('keeps the rowids of an INTEGER PRIMARY KEY table after dropping its primary key', async () => {
    const { adapter, schema, name } = await openTable('"id" INTEGER PRIMARY KEY, "body" TEXT')
    await adapter.execute(`INSERT INTO "${name}" ("id", "body") VALUES (7, 'first'), (42, 'second')`)

    await schema.table(name, (table) => { table.dropPrimary() })

    expect((await adapter.query(`SELECT rowid AS "hidden", "id" FROM "${name}" ORDER BY rowid`)).rows).toEqual([
      { hidden: 7, id: 7 },
      { hidden: 42, id: 42 },
    ])
  })
})
