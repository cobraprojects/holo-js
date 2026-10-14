import { beforeEach, describe, expect, it } from 'vitest'
import { column, DB, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const values: JsonValue[] = ['Content', '', ' \t\n ', '{"x":1}', '[1]', '"quoted"', 'null', 'false', '0', null, false, 0, [false, 'Content', null], { x: 'Content', nested: [0, null] }]

beforeEach(() => resetDB())

describe.each(['sqlite', 'postgres', 'mysql'] as const)('%s model JSON values', dialect => {
  const enabled = dialect === 'sqlite' || process.env[`HOLO_${dialect.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled).each([false, true])('round trips native JSON through create, save, and updates with explicit cast %s', async explicitCast => {
    const { db, table } = await openDatabase(dialect)
    const articles = defineGeneratedTable(table.tableName, {
      id: column.integer().primaryKey(),
      name: column.string(),
      active: column.boolean(),
      settings: column.json<JsonValue>().nullable(),
    })
    const Article = defineModel(articles, {
      timestamps: false,
      guarded: [],
      ...(explicitCast ? { casts: { settings: 'json' as const } } : {}),
    })

    for (const [id, value] of values.entries()) {
      const created = await Article.create({ id, name: 'Article', active: false, settings: value })
      expect(created.settings).toEqual(value)
      expect((await Article.findOrFail(id)).settings).toEqual(value)
    }

    const article = await Article.findOrFail(0)
    for (const value of values) {
      article.settings = value
      await article.save()
      expect(article.settings).toEqual(value)
      expect((await Article.findOrFail(0)).settings).toEqual(value)
      expect((await Article.update(1, { settings: value })).settings).toEqual(value)
      expect((await Article.findOrFail(1)).settings).toEqual(value)
      await Article.where('id', 2).update({ settings: value })
      expect((await Article.findOrFail(2)).settings).toEqual(value)
    }

    const nullRows = await db.queryCompiled<{ id: number }>({
      sql: `SELECT id FROM ${db.getDialect().quoteIdentifier(table.tableName)} WHERE settings IS NULL`,
    })
    expect(nullRows.rows.map(row => row.id)).toEqual([9])
  })

  it.runIf(enabled)('preserves serialized raw writes and distinguishes SQL null from literal JSON null', async () => {
    const { db, table } = await openDatabase(dialect)
    const Document = defineModel(table, { timestamps: false, guarded: [] })
    await DB.table(table).insert([
      { id: 1, name: 'SQL null', active: false, settings: null },
      { id: 2, name: 'JSON null', active: false, settings: 'null' },
      { id: 3, name: 'Object', active: false, settings: '{"x":1}' },
      { id: 4, name: 'String', active: false, settings: '"Content"' },
    ])
    expect((await Document.findOrFail(1)).get('settings')).toBeNull()
    expect((await Document.findOrFail(2)).get('settings')).toBeNull()
    expect((await Document.findOrFail(3)).get('settings')).toEqual({ x: 1 })
    expect((await Document.findOrFail(4)).get('settings')).toBe('Content')
    await DB.table(table).where('id', 3).update({ settings: '"{\\"x\\":1}"' })
    expect((await Document.findOrFail(3)).get('settings')).toBe('{"x":1}')
    const nullRows = await db.queryCompiled<{ id: number }>({
      sql: `SELECT id FROM ${db.getDialect().quoteIdentifier(table.tableName)} WHERE settings IS NULL`,
    })
    expect(nullRows.rows).toEqual([{ id: 1 }])
  })
})
