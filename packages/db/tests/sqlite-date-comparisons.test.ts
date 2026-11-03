import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearGeneratedTables,
  defineModel,
  holoRuntimeInternals,
  registerGeneratedTables,
  resetDB,
  type DatabaseContext,
} from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

const legacyDdl = 'CREATE TABLE "legacy_events" ("id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "name" TEXT NOT NULL, "created_at" TEXT DEFAULT CURRENT_TIMESTAMP, "updated_at" TEXT DEFAULT CURRENT_TIMESTAMP)'
const CURRENT_TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

beforeEach(() => {
  resetDB()
  clearGeneratedTables()
})

async function openEventsDatabase() {
  const { db, schema } = await openDatabase('sqlite')
  await schema.createTable('events', (table) => {
    table.id()
    table.string('name')
    table.timestamp('happened_at').defaultNow()
    table.timestamps()
  })
  await db.executeCompiled({ sql: legacyDdl, source: 'test:legacy-sqlite-events' })
  const reader = createSchemaReader(db)
  for (const tableName of ['events', 'legacy_events']) {
    const table = await reader.readTable(tableName)
    if (!table) throw new Error(`Table "${tableName}" was not read from the database.`)
    registerGeneratedTables({ [tableName]: table })
  }
  return db
}

async function storedText(db: DatabaseContext, table: string, column: string, id: unknown): Promise<unknown> {
  const result = await db.queryCompiled<Record<string, unknown>>({
    sql: `SELECT "${column}" AS value FROM "${table}" WHERE "id" = ?`,
    bindings: [id],
  })
  return result.rows[0]?.value
}

function window() {
  const now = Date.now()
  return { hourAgo: new Date(now - 3_600_000), hourAhead: new Date(now + 3_600_000) }
}

describe('SQLite Date bindings against database-written timestamps', () => {
  it('compares a defaultNow() column with Date bindings', async () => {
    const db = await openEventsDatabase()
    await db.table('events').insert({ name: 'defaulted' })
    const { hourAgo, hourAhead } = window()
    const events = () => db.table('events').where('name', 'defaulted')

    await expect(events().where('happened_at', '>=', hourAgo).count()).resolves.toBe(1)
    await expect(events().where('happened_at', '<', hourAgo).count()).resolves.toBe(0)
    await expect(events().whereBetween('happened_at', [hourAgo, hourAhead]).count()).resolves.toBe(1)
    await expect(db.queryCompiled<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM "events" WHERE "happened_at" >= ?',
      bindings: [hourAgo],
    })).resolves.toMatchObject({ rows: [{ total: 1 }] })
  })

  it('compares a legacy TEXT timestamp filled by its CURRENT_TIMESTAMP default with Date bindings', async () => {
    const db = await openEventsDatabase()
    await db.table('legacy_events').insert({ name: 'legacy' })
    const { hourAgo, hourAhead } = window()
    const Legacy = defineModel('legacy_events', { fillable: ['name'] })

    await expect(Legacy.where('created_at', '>=', hourAgo).count()).resolves.toBe(1)
    await expect(Legacy.where('created_at', '<', hourAgo).count()).resolves.toBe(0)
    await expect(Legacy.whereBetween('created_at', [hourAgo, hourAhead]).count()).resolves.toBe(1)
  })

  it('stores a model timestamp in the CURRENT_TIMESTAMP format and compares it with Date bindings', async () => {
    const db = await openEventsDatabase()
    const Event = defineModel('events', { fillable: ['name'] })
    const created = await Event.create({ name: 'model' })
    const { hourAgo, hourAhead } = window()

    expect(await storedText(db, 'events', 'created_at', created.id)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/)
    await expect(Event.where('created_at', '>=', hourAgo).count()).resolves.toBe(1)
    await expect(Event.where('created_at', '<', hourAgo).count()).resolves.toBe(0)
    await expect(Event.whereBetween('updated_at', [hourAgo, hourAhead]).count()).resolves.toBe(1)
  })

  it('orders rows written by Holo and by the database default by time', async () => {
    const db = await openEventsDatabase()
    const Legacy = defineModel('legacy_events', { fillable: ['name', 'created_at'] })
    await db.table('legacy_events').insert({ name: 'database default' })
    await Legacy.create({ name: 'earlier', created_at: new Date(Date.now() - 60_000) })
    await Legacy.create({ name: 'later', created_at: new Date(Date.now() + 60_000) })

    await expect(Legacy.orderBy('created_at').pluck('name')).resolves.toEqual(['earlier', 'database default', 'later'])
  })

  it('stores whole-second Dates exactly as CURRENT_TIMESTAMP does and reads every Date back unchanged', async () => {
    const db = await openEventsDatabase()
    const Event = defineModel('events', { fillable: ['name', 'happened_at'] })
    const wholeSecond = new Date('2026-01-02T03:04:05.000Z')
    const withMilliseconds = new Date('2026-01-02T03:04:05.678Z')

    const first = await Event.create({ name: 'whole', happened_at: wholeSecond })
    const second = await Event.create({ name: 'fraction', happened_at: withMilliseconds })

    expect(await storedText(db, 'events', 'happened_at', first.id)).toBe('2026-01-02 03:04:05')
    expect(await storedText(db, 'events', 'happened_at', second.id)).toBe('2026-01-02 03:04:05.678')
    expect((await Event.findOrFail(first.id)).happened_at).toEqual(wholeSecond)
    expect((await Event.findOrFail(second.id)).happened_at).toEqual(withMilliseconds)
  })

  it('reads an ISO value written by 0.5 and compares it once the upgrade guide migration rewrites it', async () => {
    const db = await openEventsDatabase()
    const legacyWrittenAt = new Date(Date.now() - 60_000)
    await db.executeCompiled({
      sql: 'INSERT INTO "legacy_events" ("name", "created_at") VALUES (?, ?)',
      bindings: ['written by 0.5', legacyWrittenAt.toISOString()],
      source: 'test:legacy-iso-row',
    })
    await db.table('legacy_events').insert({ name: 'database default' })
    const Legacy = defineModel('legacy_events', { fillable: ['name'] })
    expect((await Legacy.where('name', 'written by 0.5').firstOrFail()).created_at).toEqual(legacyWrittenAt)

    const rows = await db.table('legacy_events').select('id', 'created_at').where('created_at', 'like', '%T%Z').get()
    for (const row of rows) {
      await db.table('legacy_events').where('id', row.id).update({ created_at: new Date(String(row.created_at)) })
    }

    await expect(Legacy.orderBy('created_at').pluck('name')).resolves.toEqual(['written by 0.5', 'database default'])
    await expect(Legacy.where('created_at', '<', new Date(Date.now() - 30_000)).pluck('name')).resolves.toEqual(['written by 0.5'])
    expect((await Legacy.where('name', 'written by 0.5').firstOrFail()).created_at).toEqual(legacyWrittenAt)
  })

  it('reads a database-written CURRENT_TIMESTAMP value as UTC', async () => {
    const db = await openEventsDatabase()
    await db.table('legacy_events').insert({ name: 'legacy' })
    const stored = await storedText(db, 'legacy_events', 'created_at', 1)
    expect(stored).toMatch(CURRENT_TIMESTAMP_TEXT)
    const Legacy = defineModel('legacy_events', { fillable: ['name'] })

    expect((await Legacy.findOrFail(1)).created_at).toEqual(new Date(`${String(stored).replace(' ', 'T')}Z`))
  })
})
