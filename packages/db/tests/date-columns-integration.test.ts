import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB, unsafeSql } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

async function openEvents(driver: Driver) {
  const { db, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
  onTestFinished(() => resetDB())
  const name = `holo_dated_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.integer('id').primaryKey()
    table.string('label')
    table.timestamp('happened_at').nullable()
    table.datetime('scheduled_for').nullable()
    table.date('due_on').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  const events = defineGeneratedTable(name, {
    id: column.integer().primaryKey(),
    label: column.string(),
    happened_at: column.timestamp().nullable(),
    scheduled_for: column.datetime().nullable(),
    due_on: column.date().nullable(),
  })
  const Event = defineModel(events, { timestamps: false })
  return { db, events, Event, name }
}

const happened = new Date('2026-01-01T10:00:00Z')
const scheduled = new Date('2026-03-04T05:06:07Z')

describe.each(drivers)('date-like columns read through the table query builder on %s', (driver) => {
  it('returns Date values for selected timestamp, datetime and date columns', async () => {
    const { events, Event } = await openEvents(driver)
    await DB.table(events).insert([
      { id: 1, label: 'set', happened_at: happened, scheduled_for: scheduled, due_on: new Date('2026-05-06T00:00:00Z') },
      { id: 2, label: 'unset', happened_at: null, scheduled_for: null, due_on: null },
    ])

    const rows = await DB.table(events).select('id', 'happened_at', 'scheduled_for', 'due_on').orderBy('id').get()

    expectTypeOf(rows[0]!.happened_at).toEqualTypeOf<Date | null>()
    expect(rows[0]!.happened_at).toEqual(happened)
    expect(rows[0]!.scheduled_for).toEqual(scheduled)
    expect(rows[0]!.due_on).toBeInstanceOf(Date)
    expect(rows[1]).toEqual({ id: 2, happened_at: null, scheduled_for: null, due_on: null })
    const model = await Event.findOrFail(1)
    expect(rows[0]!.due_on).toEqual(model.get('due_on'))
  })

  it('returns Date values for date extrema and for union branches that read a date column', async () => {
    const { events } = await openEvents(driver)
    await DB.table(events).insert([
      { id: 1, label: 'early', happened_at: happened, scheduled_for: null, due_on: null },
      { id: 2, label: 'late', happened_at: scheduled, scheduled_for: null, due_on: null },
    ])

    const extrema = await DB.table(events).selectMin('first_at', 'happened_at').addSelectMax('last_at', 'happened_at').first()
    const union = await DB.table(events).select('happened_at').where('id', 1)
      .unionAll(DB.table(events).select('happened_at').where('id', 2))
      .get()

    expect(extrema).toEqual({ first_at: happened, last_at: scheduled })
    expect(extrema!.first_at).toBeInstanceOf(Date)
    expect(union.map(row => row.happened_at).sort((left, right) => left!.getTime() - right!.getTime())).toEqual([happened, scheduled])
    expect(union[0]!.happened_at).toBeInstanceOf(Date)
  })
})

describe.each(integrationDrivers(['sqlite']))('stored SQLite date text on %s', (driver) => {
  it('reads every stored text format to the instant model hydration reads', async () => {
    const { db, events, Event, name } = await openEvents(driver)
    const stored: ReadonlyArray<readonly [string, string, Date]> = [
      ['space', '2026-01-01 10:00:00', new Date('2026-01-01T10:00:00Z')],
      ['t-separator', '2026-01-01T10:00:00', new Date('2026-01-01T10:00:00Z')],
      ['fraction', '2026-01-01 10:00:00.123', new Date('2026-01-01T10:00:00.123Z')],
      ['minutes', '2026-01-01 10:00', new Date('2026-01-01T10:00:00Z')],
      ['utc-zone', '2026-01-01T10:00:00Z', new Date('2026-01-01T10:00:00Z')],
      ['offset-zone', '2026-01-01T10:00:00+02:00', new Date('2026-01-01T08:00:00Z')],
      ['date-only', '2026-01-01', new Date('2026-01-01T00:00:00Z')],
    ]
    for (const [index, [label, text]] of stored.entries()) {
      await db.unsafeExecute(unsafeSql(`INSERT INTO "${name}" ("id", "label", "happened_at", "scheduled_for", "due_on") VALUES (?, ?, ?, ?, ?)`, [index + 1, label, text, text, text]))
    }

    const rows = await DB.table(events).orderBy('id').get()

    for (const [index, [label, , instant]] of stored.entries()) {
      const row = rows[index]!
      const model = await Event.findOrFail(index + 1)
      expect({ label, happened_at: row.happened_at, scheduled_for: row.scheduled_for, due_on: row.due_on })
        .toEqual({ label, happened_at: instant, scheduled_for: instant, due_on: instant })
      expect([row.happened_at, row.scheduled_for, row.due_on]).toEqual([model.get('happened_at'), model.get('scheduled_for'), model.get('due_on')])
    }
  })
})
