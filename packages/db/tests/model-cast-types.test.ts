import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  clearGeneratedTables,
  defineModel,
  holoRuntimeInternals,
  registerGeneratedTables,
  renderGeneratedSchemaModule,
  resetDB,
  type DatabaseContext,
  type TableDefinition,
} from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

const builtInCasts = {
  flag_int: 'boolean',
  count_text: 'number',
  code_int: 'string',
  meta_text: 'json',
  meta_json: 'json',
  born_on: 'date',
  seen_at: 'datetime',
  stamp: 'timestamp',
  embedding: 'vector:3',
  label: { get: (value: unknown) => String(value).toUpperCase(), set: (value: unknown) => String(value).toLowerCase() },
} as const

const legacyCasts = {
  active: 'boolean',
  settings: 'json',
  published_on: 'date',
  seen_at: 'datetime',
} as const

beforeEach(() => {
  resetDB()
  clearGeneratedTables()
})

async function readGeneratedTables(db: DatabaseContext, tableNames: readonly string[]): Promise<TableDefinition[]> {
  const reader = createSchemaReader(db)
  const tables: TableDefinition[] = []
  for (const tableName of tableNames) {
    const table = await reader.readTable(tableName)
    if (!table) throw new Error(`Table "${tableName}" was not read from the database.`)
    tables.push(table)
  }
  return tables
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`${driver} casts over the Generated schema`, () => {
    const castTable = `cast_types_${driver}`
    const legacyTable = `cast_types_legacy_${driver}`

    async function openCastDatabase() {
      const { db, schema } = await openDatabase(driver)
      const quote = (name: string) => db.getDialect().quoteIdentifier(name)
      await schema.dropTable(castTable)
      onTestFinished(() => schema.dropTable(castTable))
      await schema.createTable(castTable, (table) => {
        table.id()
        table.integer('flag_int')
        table.string('count_text')
        table.integer('code_int')
        table.text('meta_text')
        table.json('meta_json').nullable()
        table.string('born_on')
        table.string('seen_at').nullable()
        table.string('stamp')
        table.text('embedding')
        table.string('label')
        table.json('plain_json').nullable()
        table.boolean('plain_bool')
        table.string('nickname')
      })
      const tableNames = [castTable]
      if (driver === 'sqlite') {
        await schema.dropTable(legacyTable)
        await db.executeCompiled({
          sql: `CREATE TABLE ${quote(legacyTable)} (${quote('id')} INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, ${quote('active')} INTEGER NOT NULL DEFAULT 0, ${quote('settings')} TEXT, ${quote('published_on')} TEXT, ${quote('seen_at')} TEXT)`,
          source: 'test:legacy-sqlite-table',
        })
        tableNames.push(legacyTable)
      }
      const tables = await readGeneratedTables(db, tableNames)
      registerGeneratedTables(Object.fromEntries(tables.map(table => [table.tableName, table])))
      return { db, tables }
    }

    it('writes the Generated schema module the cast type tests compile against', async () => {
      const { tables } = await openCastDatabase()

      await expect(renderGeneratedSchemaModule(tables)).toMatchFileSnapshot(`./fixtures/cast-types/${driver}.generated.ts`)
    })

    it('reads and writes every built-in cast as its declared type', async () => {
      await openCastDatabase()
      const CastRecord = defineModel(castTable, { timestamps: false, guarded: [], casts: builtInCasts })

      const created = await CastRecord.create({
        flag_int: true,
        count_text: 42,
        code_int: '7',
        meta_text: { tags: ['a'], nested: { on: true } },
        meta_json: [1, 'two'],
        born_on: new Date('2026-01-02T00:00:00.000Z'),
        seen_at: new Date('2026-03-04T05:06:07.000Z'),
        stamp: new Date('2026-05-06T07:08:09.000Z'),
        embedding: [1, 2, 3],
        label: 'Mixed',
        plain_json: null,
        plain_bool: false,
        nickname: 'nick',
      })
      const found = await CastRecord.findOrFail(created.id)

      for (const record of [created, found]) {
        expect(record.flag_int).toBe(true)
        expect(record.count_text).toBe(42)
        expect(record.code_int).toBe('7')
        expect(record.meta_text).toEqual({ tags: ['a'], nested: { on: true } })
        expect(record.meta_json).toEqual([1, 'two'])
        expect(record.born_on).toEqual(new Date('2026-01-02T00:00:00.000Z'))
        expect(record.seen_at).toEqual(new Date('2026-03-04T05:06:07.000Z'))
        expect(record.stamp).toEqual(new Date('2026-05-06T07:08:09.000Z'))
        expect(record.embedding).toEqual([1, 2, 3])
        expect(record.label).toBe('MIXED')
      }

      await CastRecord.update(created.id, { flag_int: false, count_text: 5, meta_text: 'text', seen_at: null })
      const updated = await CastRecord.findOrFail(created.id)
      expect(updated.flag_int).toBe(false)
      expect(updated.count_text).toBe(5)
      expect(updated.meta_text).toBe('text')
      expect(updated.seen_at).toBeNull()
    })

    it('keeps the database-derived value of columns without a cast', async () => {
      await openCastDatabase()
      const CastRecord = defineModel(castTable, { timestamps: false, guarded: [], casts: builtInCasts })

      const created = await CastRecord.create({
        flag_int: false,
        count_text: 1,
        code_int: '1',
        meta_text: {},
        born_on: new Date('2026-01-02T00:00:00.000Z'),
        stamp: new Date('2026-01-02T00:00:00.000Z'),
        embedding: [0, 0, 0],
        label: 'x',
        plain_json: driver === 'sqlite' ? '{"raw":true}' : { raw: true },
        plain_bool: true,
        nickname: 'nick',
      })
      const found = await CastRecord.findOrFail(created.id)

      expect(found.plain_bool).toBe(true)
      expect(found.nickname).toBe('nick')
      expect(found.plain_json).toEqual(driver === 'sqlite' ? '{"raw":true}' : { raw: true })
    })

    it.runIf(driver === 'sqlite')('restores boolean, JSON and date types on columns created before the upgrade', async () => {
      const { db } = await openCastDatabase()
      const Legacy = defineModel(legacyTable, { timestamps: false, guarded: [], casts: legacyCasts })

      const created = await Legacy.create({
        active: true,
        settings: { theme: 'dark' },
        published_on: new Date('2026-02-03T00:00:00.000Z'),
        seen_at: new Date('2026-02-03T04:05:06.000Z'),
      })
      const found = await Legacy.findOrFail(created.id)

      expect(found.active).toBe(true)
      expect(found.settings).toEqual({ theme: 'dark' })
      expect(found.published_on).toEqual(new Date('2026-02-03T00:00:00.000Z'))
      expect(found.seen_at).toEqual(new Date('2026-02-03T04:05:06.000Z'))

      await Legacy.update(created.id, { settings: null })
      const stored = await db.queryCompiled<{ id: number }>({
        sql: `SELECT id FROM ${db.getDialect().quoteIdentifier(legacyTable)} WHERE settings IS NULL`,
      })
      expect(stored.rows.map(row => Number(row.id))).toEqual([created.id])
    })
  })
}
