import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { DB, type CursorPaginatedResult, belongsToMany, clearGeneratedTables, column, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB, unsafeSql } from '../src'
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
  return { db, schema, events, Event, name }
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

async function openJoinedNotes(driver: Driver) {
  const { schema, events } = await openEvents(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const notesName = `holo_notes_${suffix}`
  const tagsName = `holo_tags_${suffix}`
  const pivotName = `holo_event_tags_${suffix}`
  await schema.createTable(notesName, (table) => {
    table.integer('id').primaryKey()
    table.integer('event_id')
    table.timestamp('noted_at')
  })
  onTestFinished(() => schema.dropTable(notesName))
  await schema.createTable(tagsName, (table) => { table.integer('id').primaryKey() })
  onTestFinished(() => schema.dropTable(tagsName))
  await schema.createTable(pivotName, (table) => {
    table.integer('event_id')
    table.integer('tag_id')
    table.timestamp('expires_at').nullable()
  })
  onTestFinished(() => schema.dropTable(pivotName))
  const notes = defineGeneratedTable(notesName, { id: column.integer().primaryKey(), event_id: column.integer(), noted_at: column.timestamp() })
  const tags = defineGeneratedTable(tagsName, { id: column.integer().primaryKey() })
  const eventTags = defineGeneratedTable(pivotName, { event_id: column.integer(), tag_id: column.integer(), expires_at: column.timestamp().nullable() })
  registerGeneratedTables({ events, notes, tags, eventTags })
  onTestFinished(() => clearGeneratedTables())
  const Tag = defineModel(tags, { timestamps: false })
  const TaggedEvent = defineModel(events, {
    timestamps: false,
    relations: { tags: belongsToMany(() => Tag, eventTags, 'event_id', 'tag_id').withPivot('expires_at') },
  })
  return { events, notes, notesName, tags, TaggedEvent }
}

describe.each(drivers)('date-like columns that other query builder features read back on %s', (driver) => {
  it('pages through a cursor ordered by a joined timestamp', async () => {
    const { events, notes, notesName } = await openJoinedNotes(driver)
    await DB.table(events).insert([1, 2, 3].map(id => ({ id, label: `event ${id}`, happened_at: null, scheduled_for: null, due_on: null })))
    await DB.table(notes).insert([10, 11, 12].map((hour, index) => ({ id: index + 1, event_id: index + 1, noted_at: new Date(`2026-01-01T${hour}:00:00Z`) })))

    const labels: unknown[] = []
    const notedAt: unknown[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result: CursorPaginatedResult<{ label: string, noted_at: unknown }> = await DB.table(events).join(notesName, `${notesName}.event_id`, '=', `${events.tableName}.id`)
        .select(`${events.tableName}.id`, `${events.tableName}.label`, `${notesName}.noted_at`)
        .orderBy(`${notesName}.noted_at`)
        .cursorPaginate(1, cursor)
      labels.push(...result.data.map(row => row.label))
      notedAt.push(...result.data.map(row => row.noted_at))
      cursor = result.nextCursor
      if (!cursor) break
    }

    expect(labels).toEqual(['event 1', 'event 2', 'event 3'])
    expect(notedAt).toEqual([10, 11, 12].map(hour => new Date(`2026-01-01T${hour}:00:00Z`)))
  })

  it('leaves a pivot row alone when its date attribute is written again unchanged', async () => {
    const { events, tags, TaggedEvent } = await openJoinedNotes(driver)
    await DB.table(events).insert({ id: 1, label: 'set', happened_at: null, scheduled_for: null, due_on: null })
    await DB.table(tags).insert([{ id: 1 }, { id: 2 }])
    const event = await TaggedEvent.findOrFail(1)
    await event.attach('tags', 1, { expires_at: happened })
    await event.attach('tags', 2, { expires_at: '2026-01-01 10:00:00' as never })

    expect(await event.updateExistingPivot('tags', 1, { expires_at: new Date(happened.getTime()) })).toBe(0)
    expect(await event.updateExistingPivot('tags', 2, { expires_at: '2026-01-01 10:00:00' as never })).toBe(0)
    expect(await event.sync('tags', { 1: { expires_at: new Date(happened.getTime()) }, 2: { expires_at: '2026-01-01 10:00:00' as never } })).toEqual({ attached: [], detached: [], updated: [] })
    expect(await event.updateExistingPivot('tags', 1, { expires_at: scheduled })).toBe(1)
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

  it('stores Dates as UTC text that reads back as the same Date', async () => {
    const { events } = await openEvents(driver)
    await DB.table(events).insert({ id: 1, label: 'set', happened_at: new Date('2026-01-01T10:00:00.123Z'), scheduled_for: scheduled, due_on: new Date('2026-05-06T00:00:00Z') })

    const stored = await DB.table(events).unsafeSelect('"happened_at" AS "happened", "scheduled_for" AS "scheduled", "due_on" AS "due"', []).first()
    const read = await DB.table(events).select('happened_at', 'scheduled_for', 'due_on').first()

    expect(stored).toEqual({ happened: '2026-01-01 10:00:00.123', scheduled: '2026-03-04 05:06:07', due: '2026-05-06 00:00:00' })
    expect(read).toEqual({ happened_at: new Date('2026-01-01T10:00:00.123Z'), scheduled_for: scheduled, due_on: new Date('2026-05-06T00:00:00Z') })
  })

  it('reads stored text that is not a valid date exactly as model hydration does', async () => {
    const { db, events, Event, name } = await openEvents(driver)
    const impossible = ['2025-02-30', '2025-13-01', '2025-02-28 24:30:00']
    for (const [index, text] of impossible.entries()) {
      await db.unsafeExecute(unsafeSql(`INSERT INTO "${name}" ("id", "label", "happened_at") VALUES (?, ?, ?)`, [index + 1, text, text]))
    }

    const rows = await DB.table(events).select('id', 'happened_at').orderBy('id').get()

    for (const [index] of impossible.entries()) {
      const model = await Event.findOrFail(index + 1)
      expect(rows[index]!.happened_at).toBeInstanceOf(Date)
      expect(rows[index]!.happened_at!.getTime()).toBe(model.get('happened_at')!.getTime())
    }
  })

  it('pages through cursors in the order SQLite sorts the stored text', async () => {
    const { db, events, name } = await openEvents(driver)
    const rows = [
      [2, '2026-05-06', '2026-05-06 10:00:00.000'],
      [1, '2026-05-06 00:00:00', '2026-05-06 10:00:00.000'],
      [4, '2026-05-06', '2026-05-06 11:00:00'],
      [3, '2026-05-07', '2026-05-06 10:00:00.5'],
    ] as const
    for (const [id, day, at] of rows) {
      await db.unsafeExecute(unsafeSql(`INSERT INTO "${name}" ("id", "label", "due_on", "happened_at") VALUES (?, ?, ?, ?)`, [id, `event ${id}`, day, at]))
    }

    for (const column of ['due_on', 'happened_at'] as const) {
      const ordered = DB.table(events).select('id', column).orderBy(column).orderBy('id')
      const expected = (await ordered.get()).map(row => row.id)
      const forward: unknown[] = []
      let cursor: string | null = null
      let last: CursorPaginatedResult<Record<string, unknown>> | undefined
      for (let page = 0; page < 8; page++) {
        last = await ordered.cursorPaginate(1, cursor)
        forward.push(...last.data.map(row => row.id))
        cursor = last.nextCursor
        if (!cursor) break
      }
      const backward: unknown[] = []
      cursor = last!.prevCursor
      for (let page = 0; page < 8 && cursor; page++) {
        const result: CursorPaginatedResult<Record<string, unknown>> = await ordered.cursorPaginate(1, cursor)
        backward.unshift(...result.data.map(row => row.id))
        cursor = result.prevCursor
      }

      expect({ column, forward }).toEqual({ column, forward: expected })
      expect({ column, backward }).toEqual({ column, backward: expected.slice(0, -1) })
      expect(last!.data[0]![column]).toBeInstanceOf(Date)
    }
  })

  it('pages through a cursor over a union of a date column and a string column', async () => {
    const { events } = await openEvents(driver)
    await DB.table(events).insert([
      { id: 1, label: 'zzz', happened_at: null, scheduled_for: null, due_on: new Date('2026-05-06T00:00:00Z') },
      { id: 2, label: 'aaa', happened_at: null, scheduled_for: null, due_on: new Date('2026-05-07T00:00:00Z') },
    ])
    const union = () => DB.table(events).select('id', 'due_on').unionAll(DB.table(events).select('id', 'label')).orderBy('due_on')

    const values: unknown[] = []
    let cursor: string | null = null
    for (let page = 0; page < 8; page++) {
      const result: CursorPaginatedResult<{ due_on: unknown }> = await union().cursorPaginate(1, cursor)
      values.push(...result.data.map(row => row.due_on))
      cursor = result.nextCursor
      if (!cursor) break
    }

    expect(values).toEqual((await union().get()).map(row => row.due_on))
    expect(values).toHaveLength(4)
  })

  it('keeps a union column as text when a branch reads it from a non-date column', async () => {
    const { events } = await openEvents(driver)
    await DB.table(events).insert({ id: 1, label: 'set', happened_at: happened, scheduled_for: null, due_on: null })

    const rows = await DB.table(events).select('happened_at')
      .unionAll(DB.table(events).select('label'))
      .get()

    expect(rows.map(row => row.happened_at as unknown).sort()).toEqual(['2026-01-01 10:00:00', 'set'])
  })
})
