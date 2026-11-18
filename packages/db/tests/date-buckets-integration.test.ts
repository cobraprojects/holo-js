import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CapabilityError, CompilerError, ConfigurationError, DB, DatabaseError, SQLiteQueryCompiler, createDeleteQueryPlan, SecurityError, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB } from '../src'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { integrationDrivers, mysqlIntegration, mysqlTestConnection, openDatabase, postgresIntegration, postgresTestConnection } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function useAppTimezone(timezone: string): void {
  configureConfigRuntime({ app: { timezone } } as never)
  onTestFinished(() => {
    resetConfigRuntime()
  })
}

async function createEventsTable(driver: typeof drivers[number], options: Parameters<typeof openDatabase>[1] = {}) {
  const { schema } = await openDatabase(driver, options)
  const name = `bucket_events_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('tenant_id')
    table.datetime('occurred_at').nullable()
    table.date('billed_on').nullable()
  })
  const events = defineGeneratedTable(name, {
    id: column.id(),
    tenant_id: column.integer(),
    occurred_at: column.datetime().nullable(),
    billed_on: column.date().nullable(),
  })
  registerGeneratedTables({ events })
  onTestFinished(() => clearGeneratedTables())
  await DB.table(events).insert([
    { tenant_id: 1, occurred_at: new Date('2026-11-03T10:00:00Z'), billed_on: '2026-11-03' },
    { tenant_id: 1, occurred_at: new Date('2026-11-03T23:30:00Z'), billed_on: '2026-11-03' },
    { tenant_id: 1, occurred_at: new Date('2026-11-04T01:00:00Z'), billed_on: '2026-11-04' },
    { tenant_id: 1, occurred_at: new Date('2026-11-04T12:00:00Z'), billed_on: '2026-11-04' },
    { tenant_id: 1, occurred_at: new Date('2026-11-05T16:00:00Z'), billed_on: '2026-11-05' },
    { tenant_id: 1, occurred_at: new Date('2026-12-31T23:59:00Z'), billed_on: '2026-12-31' },
    { tenant_id: 2, occurred_at: new Date('2026-11-04T05:00:00Z'), billed_on: '2026-11-04' },
    { tenant_id: 1, occurred_at: null, billed_on: null },
  ])
  return events
}

async function createLabelsTable() {
  const schema = createSchemaService(DB.connection())
  const name = `bucket_labels_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.string('label')
    table.datetime('at')
  })
  return defineGeneratedTable(name, { id: column.id(), label: column.string(), at: column.datetime() })
}

async function fillLabelsTable(labels: Awaited<ReturnType<typeof createLabelsTable>>) {
  await DB.table(labels).insert([
    { label: '2026-11-05', at: new Date('2026-11-03T10:00:00Z') },
    { label: '2026-11-04', at: new Date('2026-11-01T10:00:00Z') },
  ])
}

async function createKeyedTable(prefix: string, valueColumn: string, rows: readonly { readonly id: number, readonly value: number | null }[]) {
  const schema = createSchemaService(DB.connection())
  const name = `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.integer(valueColumn).nullable()
  })
  const keyed = defineGeneratedTable(name, { id: column.id(), [valueColumn]: column.integer().nullable() })
  await DB.table(name).insert(rows.map(row => ({ id: row.id, [valueColumn]: row.value })))
  return keyed
}

async function createFactsTable(driver: typeof drivers[number]) {
  const events = await createEventsTable(driver)
  const schema = createSchemaService(DB.connection())
  const facts = `bucket_facts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(facts)
  })
  await schema.createTable(facts, (table) => {
    table.id()
    table.string('bucket')
  })
  registerGeneratedTables({ events, factsTable: defineGeneratedTable(facts, { id: column.id(), bucket: column.string() }) })
  await DB.table(facts).insert([{ id: 1, bucket: 'first' }, { id: 2, bucket: 'second' }])
  return { events, facts }
}

describe.each(drivers)('date buckets on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('counts events per UTC day, newest first', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const rows = await DB.table(events)
      .where('tenant_id', 1)
      .whereBetween('occurred_at', [new Date('2026-11-01T00:00:00Z'), new Date('2027-01-01T00:00:00Z')])
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('day')
      .orderByDesc('day')
      .get()

    expect(rows).toEqual([
      { day: '2026-12-31', total: 1 },
      { day: '2026-11-05', total: 1 },
      { day: '2026-11-04', total: 2 },
      { day: '2026-11-03', total: 2 },
    ])
  })

  it('assigns events to the calendar day of the requested time zone', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const rows = await DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' })
      .addSelectCount('total')
      .groupBy('day')
      .orderBy('day')
      .get()

    expect(rows).toEqual([
      { day: '2026-11-03', total: 1 },
      { day: '2026-11-04', total: 3 },
      { day: '2026-11-06', total: 1 },
      { day: '2027-01-01', total: 1 },
    ])
  })

  it('defaults to the app time zone and leaves DATE columns on their stored day', async () => {
    useAppTimezone('Asia/Tokyo')
    const events = await createEventsTable(driver)

    const occurred = await DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'day' })
      .addSelectCount('total')
      .groupBy('day')
      .orderBy('day')
      .get()
    const billed = await DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('billed_on')
      .selectDate('day', 'billed_on', { as: 'day', timeZone: 'America/New_York' })
      .addSelectCount('total')
      .groupBy('day')
      .orderBy('day')
      .get()

    expect(occurred.map(row => row.day)).toEqual(['2026-11-03', '2026-11-04', '2026-11-06', '2027-01-01'])
    expect(billed).toEqual([
      { day: '2026-11-03', total: 2 },
      { day: '2026-11-04', total: 2 },
      { day: '2026-11-05', total: 1 },
      { day: '2026-12-31', total: 1 },
    ])
  })

  it('formats year, month and hour buckets and keeps null timestamps null', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const rows = await DB.table(events)
      .where('tenant_id', 1)
      .selectDate('year', 'occurred_at', { as: 'year', timeZone: 'Asia/Tokyo' })
      .addSelectDate('month', 'occurred_at', { as: 'month', timeZone: 'Asia/Tokyo' })
      .addSelectDate('hour', 'occurred_at', { as: 'hour', timeZone: 'Asia/Tokyo' })
      .orderBy('id')
      .get()

    expect(rows).toEqual([
      { year: '2026', month: '2026-11', hour: '2026-11-03 19:00' },
      { year: '2026', month: '2026-11', hour: '2026-11-04 08:00' },
      { year: '2026', month: '2026-11', hour: '2026-11-04 10:00' },
      { year: '2026', month: '2026-11', hour: '2026-11-04 21:00' },
      { year: '2026', month: '2026-11', hour: '2026-11-06 01:00' },
      { year: '2027', month: '2027-01', hour: '2027-01-01 08:00' },
      { year: null, month: null, hour: null },
    ])
  })

  it('cursor-paginates day buckets newest first in both directions', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const perDay = () => DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('day')
      .orderByDesc('day')

    const first = await perDay().cursorPaginate(2)
    const second = await perDay().cursorPaginate(2, first.nextCursor)
    const back = await perDay().cursorPaginate(2, second.prevCursor)

    expect(first.data).toEqual([{ day: '2026-12-31', total: 1 }, { day: '2026-11-05', total: 1 }])
    expect(second.data).toEqual([{ day: '2026-11-04', total: 2 }, { day: '2026-11-03', total: 2 }])
    expect(second.nextCursor).toBeNull()
    expect(back.data).toEqual(first.data)
  })

  it('rejects cursor pagination that does not order by every grouped column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'day' })
      .addSelectCount('total')
      .groupBy('day')
      .orderByDesc('id')
      .cursorPaginate(2)).rejects.toThrow(SecurityError)
  })

  it('reports date bucket aliases in the compiled projection', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    expect(DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).toSQL().metadata?.selectedShape.columns).toEqual(['day'])
  })

  it('reports date bucket aliases in projection order', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    expect(DB.table(events).selectDate('day', 'occurred_at', { as: 'day' }).addSelect('id').toSQL().metadata?.selectedShape.columns).toEqual(['day', 'id'])
  })

  it('rejects time zones that are not IANA names', async () => {
    const events = await createEventsTable(driver)

    expect(() => DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: '+03:00' })).toThrow(SecurityError)
    expect(() => DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Mars/Olympus' })).toThrow(SecurityError)
  })

  it('rejects a date bucket alias that reuses a column of a table passed by name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName).where('tenant_id', 2).selectDate('day', 'occurred_at', { as: 'tenant_id' }).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'ID' }).orderBy('ID').cursorPaginate(1)).rejects.toThrow(DatabaseError)
  })

  it('pages day buckets in chunks', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const days: (string | null)[] = []

    await DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .orderBy('bucket')
      .chunk(2, (rows) => {
        days.push(...rows.map(row => row.bucket))
      })

    expect(days).toEqual(['2026-11-03', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-05', '2026-12-31'])
  })

  it('keeps the default primary key order for a query grouped by its primary key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const first = await DB.table(events).where('tenant_id', 1).select('id').groupBy('id').cursorPaginate(2)
    const second = await DB.table(events).where('tenant_id', 1).select('id').groupBy('id').cursorPaginate(2, first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
  })

  it('rejects a union cursor position that is a date bucket in one query and a column in another', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const labels = await createLabelsTable()
    registerGeneratedTables({ events, labels })
    await fillLabelsTable(labels)
    const query = () => DB.table(labels.tableName)
      .where('id', 1)
      .select('id')
      .addSelectDate('day', 'at', { as: 'sort', timeZone: 'UTC' })
      .addSelectDate('day', 'at', { as: 'extra', timeZone: 'UTC' })
      .unionAll(DB.table(events.tableName)
        .join(labels.tableName, `${labels.tableName}.id`, '=', `${events.tableName}.id`)
        .where(`${events.tableName}.id`, 2)
        .select(`${events.tableName}.id`, 'label as sort_key')
        .addSelectDate('day', `${labels.tableName}.at`, { as: 'label', timeZone: 'UTC' }))
      .orderBy('sort')

    await expect(query().cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('rejects union cursor pagination when a grouped query puts a date bucket at the ordered position', async () => {
    useAppTimezone('UTC')
    await openDatabase(driver)
    const labels = await createLabelsTable()
    registerGeneratedTables({ labels })
    onTestFinished(() => clearGeneratedTables())
    await fillLabelsTable(labels)

    await expect(DB.table(labels)
      .select('label')
      .groupBy('label')
      .unionAll(DB.table(labels).selectDate('day', 'at', { as: 'other', timeZone: 'UTC' }).groupBy('other'))
      .orderBy('label')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('resolves a bare column named like the date bucket to the only join that may own it', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const extras = `bucket_extras_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(extras)
    })
    await schema.createTable(extras, (table) => {
      table.id()
      table.string('bucket')
    })
    await DB.table(extras).insert({ id: 1, bucket: 'first' })

    const rows = await DB.table(events.tableName)
      .join(extras, `${extras}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .where('bucket', 'first')
      .get()

    expect(rows).toEqual([{ bucket: '2026-11-03' }])
  })

  it('rejects union cursor pagination with date buckets when a wildcard hides the ordered position', async () => {
    useAppTimezone('UTC')
    await openDatabase(driver)
    const labels = await createLabelsTable()
    registerGeneratedTables({ labels })
    onTestFinished(() => clearGeneratedTables())
    await fillLabelsTable(labels)

    await expect(DB.table(labels.tableName)
      .where('id', 1)
      .select(`${labels.tableName}.*`, 'label as bucket')
      .unionAll(DB.table(labels.tableName).where('id', 2).select('id').addSelectDate('day', 'at', { as: 'bucket', timeZone: 'UTC' }).addSelect('label', 'at'))
      .orderBy('bucket')
      .cursorPaginate(1)).rejects.toThrow(CompilerError)
  })

  it('cursor-paginates a single table grouped by its primary key and another column by the key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const page = (cursor: string | null) => DB.table(events).where('tenant_id', 1).select('id', 'tenant_id').groupBy('id', 'tenant_id').orderBy('id').cursorPaginate(4, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data].map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 8])
  })

  it('rejects a date bucket reference spelled in another case', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const notes = await createKeyedTable('bucket_notes', 'bucket', [{ id: 1, value: null }, { id: 2, value: null }])
    registerGeneratedTables({ events, notes })

    await expect(DB.table(events.tableName)
      .join(notes.tableName, `${notes.tableName}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')
      .having('COUNT(BUCKET)', '>', 0)
      .get()).rejects.toThrow(CompilerError)
    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'bucket' }).groupBy('BUCKET').get()).rejects.toThrow(CompilerError)
    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'bucket' }).groupBy('BUCKET').orderBy('bucket').cursorPaginate(1)).rejects.toThrow(CompilerError)
  })

  it('cursor-paginates a join grouped by the source primary key and a bare source column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const notes = await createKeyedTable('bucket_notes', 'bucket', [{ id: 1, value: null }, { id: 2, value: null }])
    registerGeneratedTables({ events, notes })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(notes.tableName, `${notes.tableName}.id`, '=', `${events.tableName}.id`)
      .select(`${events.tableName}.id`, 'tenant_id')
      .groupBy(`${events.tableName}.id`, 'tenant_id')
      .orderBy(`${events.tableName}.id`)
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ id: 1, tenant_id: 1 }, { id: 2, tenant_id: 1 }])
  })

  it('rejects a raw selection next to a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events).selectDate('day', 'occurred_at', { as: 'bucket' }).addUnsafeSelect('123 AS bucket', []).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'bucket' }).addUnsafeSelect('?', []).orderBy('BUCKET').get()).rejects.toThrow(CompilerError)
  })

  it('cursor-paginates a grouped join without schema metadata by the source primary key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const notes = `bucket_notes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(notes)
    })
    await schema.createTable(notes, (table) => {
      table.id()
      table.integer('event_id')
    })
    await DB.table(notes).insert([{ event_id: 1 }, { event_id: 1 }, { event_id: 2 }])
    const page = (cursor: string | null) => DB.table(events)
      .join(notes, `${notes}.event_id`, '=', `${events.tableName}.id`)
      .select(`${events.tableName}.id`, 'tenant_id')
      .addSelectCount('notes')
      .groupBy(`${events.tableName}.id`, 'tenant_id')
      .orderBy(`${events.tableName}.id`)
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ id: 1, tenant_id: 1, notes: 2 }, { id: 2, tenant_id: 1, notes: 1 }])
  })

  it('rejects a wildcard of a join without schema metadata next to a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const legacy = `bucket_legacy_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(legacy)
    })
    await schema.createTable(legacy, (table) => {
      table.id()
      table.string('bucket')
    })

    await expect(DB.table(events.tableName)
      .join(legacy, `${legacy}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect(`${legacy}.*`)
      .get()).rejects.toThrow(SecurityError)
  })

  it('cursor-paginates a join grouped by the source primary key and source columns', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const notes = await createKeyedTable('bucket_notes', 'bucket', [{ id: 1, value: null }, { id: 2, value: null }, { id: 3, value: null }])
    registerGeneratedTables({ events, notes })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(notes.tableName, `${notes.tableName}.id`, '=', `${events.tableName}.id`)
      .select(`${events.tableName}.id`, `${events.tableName}.tenant_id`)
      .groupBy(`${events.tableName}.id`, `${events.tableName}.tenant_id`)
      .orderBy(`${events.tableName}.id`)
      .cursorPaginate(2, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ id: 1, tenant_id: 1 }, { id: 2, tenant_id: 1 }, { id: 3, tenant_id: 1 }])
  })

  it('adds the grouped primary key as a tie-breaker to an explicit order', async () => {
    useAppTimezone('UTC')
    await openDatabase(driver)
    const labels = await createLabelsTable()
    registerGeneratedTables({ labels })
    onTestFinished(() => clearGeneratedTables())
    await fillLabelsTable(labels)
    const byLabel = () => DB.table(labels).select('id', 'label').groupBy('id').orderBy('label')
    const perDay = () => DB.table(labels).select('id').addSelectDate('day', 'at', { as: 'bucket', timeZone: 'UTC' }).groupBy('bucket', 'id').orderBy('bucket')

    const first = await byLabel().cursorPaginate(1)
    const second = await byLabel().cursorPaginate(1, first.nextCursor)
    const firstDay = await perDay().cursorPaginate(1)
    const secondDay = await perDay().cursorPaginate(1, firstDay.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ id: 2, label: '2026-11-04' }, { id: 1, label: '2026-11-05' }])
    expect([...firstDay.data, ...secondDay.data]).toEqual([{ id: 2, bucket: '2026-11-01' }, { id: 1, bucket: '2026-11-03' }])
  })

  it('asks for a qualified column when no table or more than one may own a bare column named like the date bucket', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)
    const schema = createSchemaService(DB.connection())
    const extras = `bucket_extras_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(extras)
    })
    await schema.createTable(extras, (table) => {
      table.id()
      table.string('bucket')
    })

    await expect(DB.table(events.tableName)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .where('bucket', 'first')
      .get()).rejects.toThrow(CompilerError)
    await expect(DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .join(extras, `${extras}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .where('bucket', 'first')
      .get()).rejects.toThrow(CompilerError)
  })

  it('rejects another selected column whose name differs from the date bucket alias only in case', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect('tenant_id as BUCKET')
      .get()).rejects.toThrow(SecurityError)
  })

  it('counts the date bucket in a HAVING aggregate when a joined column shares its name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const notes = await createKeyedTable('bucket_notes', 'bucket', [{ id: 1, value: null }, { id: 2, value: null }])
    registerGeneratedTables({ events, notes })

    const rows = await DB.table(events.tableName)
      .join(notes.tableName, `${notes.tableName}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')
      .having('count(bucket)', '>', 0)
      .get()

    expect(rows).toEqual([{ bucket: '2026-11-03', total: 2 }])
  })

  it('cursor-paginates a query grouped by its qualified primary key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const ids = () => DB.table(events).where('tenant_id', 1).select(`${events.tableName}.id`).groupBy(`${events.tableName}.id`)
    const days = () => DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .select(`${events.tableName}.id`)
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`, 'day')
      .orderBy('day')

    const first = await ids().cursorPaginate(4)
    const second = await ids().cursorPaginate(4, first.nextCursor)
    const firstDays = await days().cursorPaginate(3)
    const secondDays = await days().cursorPaginate(3, firstDays.nextCursor)

    expect([...first.data, ...second.data].map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6, 8])
    expect([...firstDays.data, ...secondDays.data].map(row => row.id)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('resolves a join condition against the tables joined so far', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const first = await createKeyedTable('bucket_first', 'day', [{ id: 1, value: 1 }])
    const second = await createKeyedTable('bucket_second', 'day', [{ id: 1, value: 7 }])
    registerGeneratedTables({ events, first, second })

    const rows = await DB.table(events.tableName)
      .join(first.tableName, 'day', '=', `${events.tableName}.id`)
      .join(second.tableName, `${second.tableName}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .get()

    expect(rows).toEqual([{ day: '2026-11-03' }])
  })

  it('rejects a joined wildcard spelled in another case whose column shares the date bucket alias', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)

    await expect(DB.table(events.tableName)
      .join(`${facts} as f`, 'f.id', '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect('F.*')
      .get()).rejects.toThrow(SecurityError)
  })

  it('orders a union of grouped queries by a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const daysOf = (tenantId: number) => DB.table(events)
      .where('tenant_id', tenantId)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')
    const combined = () => daysOf(1).unionAll(daysOf(2)).orderByDesc('bucket')

    const rows = [...await combined().get()].sort((left, right) => (right.bucket ?? '').localeCompare(left.bucket ?? '') || left.total - right.total)

    expect(rows).toEqual([
      { bucket: '2026-12-31', total: 1 },
      { bucket: '2026-11-05', total: 1 },
      { bucket: '2026-11-04', total: 1 },
      { bucket: '2026-11-04', total: 2 },
      { bucket: '2026-11-03', total: 2 },
    ])
    await expect(combined().cursorPaginate(2)).rejects.toThrow(SecurityError)
  })

  it('cursor-paginates a union of rows by a date bucket and the primary key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const rowsOf = (tenantId: number) => DB.table(events)
      .where('tenant_id', tenantId)
      .whereNotNull('occurred_at')
      .select('id')
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
    const combined = () => rowsOf(1).unionAll(rowsOf(2)).orderByDesc('bucket')

    const first = await combined().cursorPaginate(4)
    const second = await combined().cursorPaginate(4, first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([
      { id: 6, bucket: '2026-12-31' },
      { id: 5, bucket: '2026-11-05' },
      { id: 3, bucket: '2026-11-04' },
      { id: 4, bucket: '2026-11-04' },
      { id: 7, bucket: '2026-11-04' },
      { id: 1, bucket: '2026-11-03' },
      { id: 2, bucket: '2026-11-03' },
    ])
    expect(second.nextCursor).toBeNull()
  })

  it('rejects cursor pagination by a date bucket that a raw selection could overwrite', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .orderByDesc('bucket')
      .addUnsafeSelect('0 AS bucket', [])
      .cursorPaginate(2)).rejects.toThrow(SecurityError)
  })

  it('keeps the table columns when a date bucket is the first added selection', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const row = await DB.table(events).where('id', 1).addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).first()

    expect(row).toMatchObject({ id: 1, tenant_id: 1, day: '2026-11-03' })
  })

  it('reads a qualified bucket column from the table visible under that name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const ledger = `bucket_ledger_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(ledger)
    })
    await schema.createTable(ledger, (table) => {
      table.id()
      table.date('occurred_at')
    })
    registerGeneratedTables({ events, ledgerTable: defineGeneratedTable(ledger, { id: column.id(), occurred_at: column.date() }) })
    await DB.table(ledger).insert({ id: 2, occurred_at: '2026-11-03' })

    const day = await DB.table(`${ledger} as entries`)
      .join(`${events.tableName} as ${ledger}`, `${ledger}.id`, '=', 'entries.id')
      .selectDate('day', `${ledger}.occurred_at`, { as: 'day', timeZone: 'Asia/Tokyo' })
      .value('day')

    expect(day).toBe('2026-11-04')
  })

  it('compiles a grouped branch HAVING on a date bucket before the union branches', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const perDay = () => DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')

    const rows = await perDay()
      .where('tenant_id', 1)
      .having('bucket', '>=', '2026-11-04')
      .unionAll(perDay().where('id', 1))
      .orderByDesc('bucket')
      .get()

    expect(rows).toEqual([
      { bucket: '2026-12-31', total: 1 },
      { bucket: '2026-11-05', total: 1 },
      { bucket: '2026-11-04', total: 2 },
      { bucket: '2026-11-03', total: 1 },
    ])
  })

  it('rejects union cursor pagination when a query selects the date bucket under another name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .where('tenant_id', 1)
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .unionAll(DB.table(events).where('tenant_id', 2).addSelectDate('day', 'occurred_at', { as: 'another_bucket', timeZone: 'UTC' }))
      .orderByDesc('bucket')
      .cursorPaginate(2)).rejects.toThrow(CompilerError)
  })

  it('never filters by a date bucket alias from a where clause', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .where('bucket', '2026-11-03')
      .get()).rejects.toThrow(DatabaseError)
  })

  it('rejects cursor pagination by a date bucket that a wildcard of a shadowing join could overwrite', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const facts = `bucket_facts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(facts)
    })
    await schema.createTable(facts, (table) => {
      table.id()
      table.string('bucket')
    })
    registerGeneratedTables({ events, factsTable: defineGeneratedTable(facts, { id: column.id(), bucket: column.string() }) })

    await expect(DB.table(`${events.tableName} as e`)
      .join(`${facts} as ${events.tableName}`, `${events.tableName}.id`, '=', 'e.id')
      .selectDate('day', 'e.occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect(`${events.tableName}.*`)
      .orderByDesc('bucket')
      .cursorPaginate(2)).rejects.toThrow(SecurityError)
  })

  it('rejects union cursor pagination when a wildcard hides where a query selects the date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .where('tenant_id', 1)
      .select('id', 'tenant_id', 'occurred_at', 'billed_on')
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .unionAll(DB.table(events).where('tenant_id', 2).addSelectDate('day', 'occurred_at', { as: 'other', timeZone: 'UTC' }))
      .orderByDesc('bucket')
      .cursorPaginate(2)).rejects.toThrow(CompilerError)
  })

  it('converts date-only text in a datetime column as midnight UTC', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    await DB.table(events).insert([
      { tenant_id: 8, occurred_at: '2026-11-03', billed_on: null },
      { tenant_id: 8, occurred_at: '2026-11-03 00:00:00', billed_on: null },
    ])

    const days = await DB.table(events).where('tenant_id', 8).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'America/New_York' }).pluck('day')

    expect(days).toEqual(['2026-11-02', '2026-11-02'])
  })

  it('rejects a joined wildcard whose column shares the date bucket alias', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)

    await expect(DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect(`${facts}.*`)
      .get()).rejects.toThrow(SecurityError)
  })

  it('resolves a bare where column that shares the date bucket alias to the table that has it', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)

    const rows = await DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .where('bucket', 'first')
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .get()

    expect(rows).toEqual([{ bucket: '2026-11-03' }])
    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'bucket' }).where('BUCKET', '2026-11-03').get()).rejects.toThrow(DatabaseError)
  })

  it('rejects a selection that reuses a date bucket alias', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName)
      .selectDate('day', 'occurred_at', { as: 'bucket' })
      .addSelectCount('bucket')
      .groupBy('bucket')
      .get()).rejects.toThrow(SecurityError)
  })

  it('keeps a DATE column on its stored day when the app time zone skipped that day', async () => {
    useAppTimezone('Pacific/Apia')
    const events = await createEventsTable(driver)
    await DB.table(events).insert({ tenant_id: 3, occurred_at: null, billed_on: '2011-12-30' })

    const rows = await DB.table(events).where('tenant_id', 3).selectDate('day', 'billed_on', { as: 'day', timeZone: 'UTC' }).get()

    expect(rows).toEqual([{ day: '2011-12-30' }])
  })

  it('buckets a DATE written by a model on its app time zone day', async () => {
    useAppTimezone('Asia/Tokyo')
    const events = await createEventsTable(driver)
    const Event = defineModel(events, { fillable: ['tenant_id', 'billed_on'], timestamps: false })
    await Event.create({ tenant_id: 4, billed_on: new Date('2026-11-04T15:00:00Z') })

    const rows = await DB.table(events).where('tenant_id', 4).selectDate('day', 'billed_on', { as: 'day', timeZone: 'America/New_York' }).get()

    expect(rows).toEqual([{ day: '2026-11-05' }])
  })

  it('reads an IANA link name and rejects zone abbreviations', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    await DB.table(events).insert({ tenant_id: 5, occurred_at: new Date('2026-07-15T12:00:00Z'), billed_on: null })
    const hourIn = (timeZone: string) => DB.table(events).where('tenant_id', 5).selectDate('hour', 'occurred_at', { as: 'hour', timeZone }).value('hour')

    await expect(hourIn('US/Eastern')).resolves.toBe('2026-07-15 08:00')
    await expect(hourIn('Europe/Brussels')).resolves.toBe('2026-07-15 14:00')
    expect(() => DB.table(events).selectDate('hour', 'occurred_at', { as: 'hour', timeZone: 'CET' })).toThrow(SecurityError)
    expect(() => DB.table(events).selectDate('hour', 'occurred_at', { as: 'hour', timeZone: 'PST8PDT' })).toThrow(SecurityError)
  })

  it('rejects another output whose name PostgreSQL would cut to the date bucket alias', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const alias = 'buuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'

    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: alias }).addSelect(`tenant_id as ${alias}x`).get()).rejects.toThrow(SecurityError)
  })

  it('reads the date bucket for the cursor when a joined column of the same name is selected under another alias', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelect('bucket as label', `${events.tableName}.id`)
      .orderBy('bucket')
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([
      { bucket: '2026-11-03', label: 'first', id: 1 },
      { bucket: '2026-11-03', label: 'second', id: 2 },
    ])
  })

  it('rejects a joined wildcard column that PostgreSQL would cut to the date bucket alias', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const alias = 'buuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu'
    const ghost = defineGeneratedTable('bucket_ghost', { id: column.id(), [`${alias}z`]: column.integer() })
    registerGeneratedTables({ events, ghost })

    await expect(DB.table(events.tableName)
      .join('bucket_ghost', 'bucket_ghost.id', '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: alias })
      .addSelect('bucket_ghost.*')
      .get()).rejects.toThrow(SecurityError)
  })

  it('rejects union cursor pagination with date buckets when a query in the union is grouped', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName)
      .select('id', 'tenant_id')
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .unionAll(DB.table(events.tableName).select('tenant_id as id', 'tenant_id').addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' }).groupBy('tenant_id', 'bucket'))
      .orderBy('id')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('inserts without validating date buckets in predicates the insert discards', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const unused = DB.table(events).selectDate('day', 'occurred_at', { as: 'buuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu' })

    await DB.table(events).whereExists(unused).insert({ tenant_id: 10, occurred_at: null, billed_on: null })

    await expect(DB.table(events).where('tenant_id', 10).count()).resolves.toBe(1)
  })

  it('rejects a grouped cursor order on a column the groups do not share', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .select('id')
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')
      .orderBy('bucket')
      .orderBy('id')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('rejects a grouped cursor over a join ordered by a joined column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const notes = await createKeyedTable('bucket_notes', 'rank', [{ id: 1, value: 1 }, { id: 2, value: 26 }])
    registerGeneratedTables({ events, notes })

    await expect(DB.table(events)
      .join(notes.tableName, `${notes.tableName}.id`, '=', `${events.tableName}.id`)
      .select(`${events.tableName}.id`)
      .addSelectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`)
      .orderBy(`${notes.tableName}.rank`)
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('rejects the wildcard of a joined subquery whose own wildcard cannot be verified', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)
    const shadowing = DB.table(`${events.tableName} as base`)
      .join(`${facts} as ${events.tableName}`, `${events.tableName}.id`, '=', 'base.id')
      .select(`${events.tableName}.*`)

    await expect(DB.table(events.tableName)
      .joinSub(shadowing, 'j', 'j.id', '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelect('j.*')
      .get()).rejects.toThrow(SecurityError)
  })

  it('tells a joined table that reuses the source name apart from the aliased source in grouped cursors', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)

    await expect(DB.table(`${events.tableName} as e`)
      .join(`${facts} as ${events.tableName}`, `${events.tableName}.id`, '>=', 'e.id')
      .select('e.id')
      .addSelectDate('day', 'e.occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`)
      .orderBy('e.id')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('rejects a grouped cursor order key that a selected aggregate shadows', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .select('tenant_id as tenant')
      .addSelectCount('tenant_id')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('tenant_id', 'day')
      .orderBy('tenant_id')
      .orderBy('day')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('treats a bare joined column and its qualified spelling as the same grouped cursor key', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const ranks = await createKeyedTable('bucket_ranks', 'rank', [{ id: 1, value: 1 }, { id: 2, value: 2 }])
    registerGeneratedTables({ events, ranks })

    const page = await DB.table(events.tableName)
      .join(ranks.tableName, `${ranks.tableName}.id`, '=', `${events.tableName}.id`)
      .select('rank')
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${ranks.tableName}.rank`, 'day')
      .orderBy('rank')
      .orderBy('day')
      .cursorPaginate(5)

    expect(page.data).toEqual([{ rank: 1, day: '2026-11-03' }, { rank: 2, day: '2026-11-03' }])
  })

  it('rejects a primary key order key that a selected alias shadows in a single-table group', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .select('id as event_id', 'tenant_id as id')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('id', 'day')
      .orderBy('id')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('reads a grouped cursor key from the selection of its qualified spelling', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const ranks = await createKeyedTable('bucket_ranks', 'rank', [{ id: 1, value: 1 }, { id: 2, value: 2 }])
    registerGeneratedTables({ events, ranks })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(ranks.tableName, `${ranks.tableName}.id`, '=', `${events.tableName}.id`)
      .select(`${ranks.tableName}.rank as sort_rank`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${ranks.tableName}.rank`, 'day')
      .orderBy('rank')
      .orderBy('day')
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([{ sort_rank: 1, day: '2026-11-03' }, { sort_rank: 2, day: '2026-11-03' }])
  })

  it('reads a grouped cursor key from the selection a later output does not overwrite', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const tenants = await createKeyedTable('bucket_tenants', 'code', [{ id: 30, value: 1 }])
    registerGeneratedTables({ events, tenants })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(tenants.tableName, `${tenants.tableName}.code`, '=', `${events.tableName}.tenant_id`)
      .whereIn(`${events.tableName}.id`, [1, 2])
      .select(`${events.tableName}.id`, `${tenants.tableName}.id`, `${events.tableName}.id as event_id`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`, `${tenants.tableName}.id`, 'day')
      .orderBy(`${events.tableName}.id`)
      .orderBy(`${tenants.tableName}.id`)
      .orderBy('day')
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([
      { id: 30, event_id: 1, day: '2026-11-03' },
      { id: 30, event_id: 2, day: '2026-11-03' },
    ])
  })

  it('reads a grouped cursor key past a later wildcard that overwrites it', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const tenants = await createKeyedTable('bucket_tenants', 'code', [{ id: 30, value: 1 }])
    registerGeneratedTables({ events, tenants })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(tenants.tableName, `${tenants.tableName}.code`, '=', `${events.tableName}.tenant_id`)
      .whereIn(`${events.tableName}.id`, [1, 2])
      .select(`${events.tableName}.id`, `${tenants.tableName}.*`, `${events.tableName}.id as event_id`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`, `${tenants.tableName}.id`, `${tenants.tableName}.code`, 'day')
      .orderBy(`${events.tableName}.id`)
      .orderBy(`${tenants.tableName}.id`)
      .orderBy(`${tenants.tableName}.code`)
      .orderBy('day')
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data].map(row => row.event_id)).toEqual([1, 2])
  })

  it('pages grouped date buckets by keys a wildcard selection overwrites', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const tenants = await createKeyedTable('bucket_tenants', 'code', [{ id: 30, value: 1 }])
    registerGeneratedTables({ events, tenants })
    const page = (cursor: string | null) => DB.table(events.tableName)
      .join(tenants.tableName, `${tenants.tableName}.code`, '=', `${events.tableName}.tenant_id`)
      .whereIn(`${events.tableName}.id`, [1, 2])
      .select(`${events.tableName}.*`, `${tenants.tableName}.id`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.id`, `${tenants.tableName}.id`, 'day')
      .orderBy(`${events.tableName}.id`)
      .orderBy(`${tenants.tableName}.id`)
      .orderBy('day')
      .cursorPaginate(1, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data].map(row => row.occurred_at)).toHaveLength(2)
    expect(Object.keys(first.data[0]!).some(key => key.startsWith('__holo_cursor'))).toBe(false)
  })

  it('resolves a bare grouped key past a joined subquery whose wildcard is known', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const tenants = await createKeyedTable('bucket_tenants', 'code', [{ id: 1, value: 1 }])
    registerGeneratedTables({ events, tenants })

    const page = await DB.table(events.tableName)
      .joinSub(DB.table(tenants.tableName), 'tenant_rows', 'tenant_rows.id', '=', `${events.tableName}.tenant_id`)
      .whereNotNull(`${events.tableName}.occurred_at`)
      .select(`${events.tableName}.tenant_id`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.tenant_id`, 'day')
      .orderBy('tenant_id')
      .orderBy('day')
      .cursorPaginate(10)

    expect(page.data.map(row => row.day)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-12-31'])
  })

  it('keeps a table column named like a hidden cursor column', async () => {
    useAppTimezone('UTC')
    await openDatabase(driver)
    const schema = createSchemaService(DB.connection())
    const name = `bucket_hidden_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.integer('__holo_cursor_0')
      table.datetime('at')
    })
    const hidden = defineGeneratedTable(name, { id: column.id(), __holo_cursor_0: column.integer(), at: column.datetime() })
    registerGeneratedTables({ hidden })
    onTestFinished(() => clearGeneratedTables())
    await DB.table(hidden).insert({ id: 1, __holo_cursor_0: 42, at: new Date('2026-11-03T10:00:00Z') })

    const page = await DB.table(hidden).addSelectDate('day', 'at', { as: 'day', timeZone: 'UTC' }).groupBy('id', 'day').orderBy('id').cursorPaginate(5)

    expect(page.data).toEqual([{ id: 1, __holo_cursor_0: 42, at: expect.anything(), day: '2026-11-03' }])
  })

  it('names hidden cursor columns past selected names that take the first candidates', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const page = await DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .select('tenant_id as __holo_cursor_0', 'tenant_id as __holo_cursor_0_1')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('tenant_id', 'day')
      .orderBy('tenant_id')
      .orderBy('day')
      .cursorPaginate(1)

    expect(page.data).toEqual([{ __holo_cursor_0: 1, __holo_cursor_0_1: 1, day: '2026-11-03' }])
  })

  it('rejects distinct grouped date bucket cursors ordered by another column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('tenant_id', 'day')
      .orderBy('tenant_id')
      .orderBy('day')
      .distinct()
      .cursorPaginate(5)).rejects.toThrow(SecurityError)
  })

  it('compiles a date bucket next to the table columns without a connection name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const compiler = new SQLiteQueryCompiler(identifier => `"${identifier}"`, () => '?')

    expect(compiler.compile(DB.table(events).addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).getPlan()).sql).toContain(`"${events.tableName}".*`)
  })

  it('rejects union cursor pagination that compares a date bucket with a number column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName)
      .where('tenant_id', 1)
      .select('id')
      .addSelectDate('year', 'occurred_at', { as: 'year', timeZone: 'UTC' })
      .unionAll(DB.table(events.tableName).where('tenant_id', 2).select('id', 'tenant_id as year'))
      .orderBy('year')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('rejects union cursor pagination with date buckets when a query has a raw selection', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver, { security: { allowUnsafeRawSql: true } })
    const plain = DB.table(events.tableName).where('tenant_id', 1).select('id').addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
    const raw = DB.table(events.tableName).where('tenant_id', 2).select('id').addUnsafeSelect('COUNT(id) AS day', [])

    await expect(plain.unionAll(raw).orderBy('id').cursorPaginate(1)).rejects.toThrow('raw-selected')
  })

  it('rejects cursor pagination of aggregated date bucket queries without groupBy()', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const branch = (tenantId: number) => DB.table(events.tableName)
      .where('tenant_id', tenantId)
      .select('id')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectMin('first_id', 'id')

    await expect(branch(1).unionAll(branch(2)).orderBy('id').cursorPaginate(1)).rejects.toThrow(SecurityError)
    await expect(branch(1).orderBy('id').cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('compiles the next statement cleanly after a rejected date bucket selection', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable(driver)
    const compiler = new SQLiteQueryCompiler(identifier => `"${identifier}"`, () => '?', 'default')
    const rejected = DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelect(`${facts}.*`)

    expect(() => compiler.compile(rejected.getPlan())).toThrow(SecurityError)
    expect(compiler.compile(createDeleteQueryPlan(DB.table('orders').where('bucket', 1).getPlan().source, DB.table('orders').where('bucket', 1).getPlan().predicates)).sql).toBe('DELETE FROM "orders" WHERE "bucket" = ?')
  })

  it('rejects a date bucket alias longer than PostgreSQL keeps', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'bucket_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' }).get()).rejects.toThrow(SecurityError)
  })

  it('reports a misspelled date bucket before checking its column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    await expect(DB.table(events.tableName).selectDate('day', 'tenant_id', { as: 'day' }).orderBy('Day').get()).rejects.toThrow(CompilerError)
  })

  it('needs a date, datetime or timestamp column it can identify', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const schema = createSchemaService(DB.connection())
    const undeclared = `bucket_undeclared_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(undeclared)
    })
    await schema.createTable(undeclared, (table) => {
      table.id()
      table.datetime('occurred_at')
    })

    await expect(DB.table(events.tableName).selectDate('day', 'tenant_id', { as: 'day' }).get()).rejects.toThrow(SecurityError)
    await expect(DB.table(undeclared).selectDate('day', 'occurred_at', { as: 'day' }).get()).rejects.toThrow(ConfigurationError)
  })
})

describe.runIf(mysqlIntegration)('date buckets on mysql without time zone tables', () => {
  it('reports missing time zone tables instead of returning null buckets', async () => {
    useAppTimezone('UTC')
    await openDatabase('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target)
          return (sql: string, bindings: readonly unknown[], options: unknown) => sql.startsWith('SELECT CONVERT_TZ')
            ? Promise.resolve({ rows: [{ converted: null }], rowCount: 1 })
            : target.query(sql, bindings, options as never)
        },
      }),
    })
    const events = defineGeneratedTable(`holo_missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`, {
      id: column.id(),
      occurred_at: column.datetime(),
    })

    await expect(DB.table(events)
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' })
      .get()).rejects.toThrow(CapabilityError)
  })

  it('reports missing time zone tables before insertUsing() writes buckets', async () => {
    useAppTimezone('UTC')
    await openDatabase('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target)
          return (sql: string, bindings: readonly unknown[], options: unknown) => sql.startsWith('SELECT CONVERT_TZ')
            ? Promise.resolve({ rows: [{ converted: null }], rowCount: 1 })
            : target.query(sql, bindings, options as never)
        },
      }),
    })
    const events = defineGeneratedTable(`holo_missing_${randomUUID().replaceAll('-', '').slice(0, 8)}`, {
      id: column.id(),
      occurred_at: column.datetime(),
    })
    const days = defineGeneratedTable(`holo_days_${randomUUID().replaceAll('-', '').slice(0, 8)}`, {
      id: column.id(),
      day: column.string().nullable(),
    })

    await expect(DB.table(days).insertUsing(['day'], DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' })))
      .rejects.toThrow(CapabilityError)
  })
})

describe.runIf(mysqlIntegration)('date buckets on mysql outside its time zone conversion range', () => {
  afterEach(() => {
    resetDB()
  })

  it('gives a null bucket instead of an unconverted day', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('mysql')
    await DB.table(events).insert({ tenant_id: 6, occurred_at: new Date('1969-12-31T23:30:00Z'), billed_on: null })

    const rows = await DB.table(events).where('tenant_id', 6).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).get()

    expect(rows).toEqual([{ day: null }])
  })
})

describe.runIf(postgresIntegration)('date buckets on postgres with a session time zone override', () => {
  afterEach(() => {
    resetDB()
  })

  it('reads timestamp columns in the app time zone', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const db = createDatabase({
      connectionName: 'default',
      adapter: createPostgresAdapter({ config: { ...postgresTestConnection(), options: '-c TimeZone=America/Los_Angeles' } }),
      dialect: createDialect('postgres'),
    })
    onTestFinished(async () => {
      await db.disconnect()
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const rows = await DB.table(events).where('tenant_id', 1).whereNotNull('occurred_at').selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).orderBy('id').pluck('day')

    expect(rows).toEqual(['2026-11-03', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-05', '2026-12-31'])
  })

  it('buckets a timestamptz near year 10000 whatever the session time zone', async () => {
    useAppTimezone('UTC')
    const name = `bucket_instants_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const db = createDatabase({
      connectionName: 'default',
      adapter: createPostgresAdapter({ config: { ...postgresTestConnection(), options: '-c TimeZone=Pacific/Kiritimati' } }),
      dialect: createDialect('postgres'),
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const instants = defineGeneratedTable(name, { id: column.integer().primaryKey(), at: column.timestamp() })
    try {
      await db.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, at timestamptz)`, source: 'test' })
      await db.executeCompiled({ sql: `INSERT INTO "${name}" (id, at) VALUES (1, '10000-01-01 11:00:00+00')`, source: 'test' })

      const hour = await DB.table(instants).selectDate('hour', 'at', { as: 'hour', timeZone: 'Etc/GMT+12' }).value('hour')

      expect(hour).toBe('9999-12-31 23:00')
    } finally {
      await createSchemaService(db).dropTable(name)
      await db.disconnect()
    }
  })
})

describe.each(integrationDrivers(['sqlite', 'mysql'] as const))('date buckets before year 1 on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('gives a null bucket for year zero', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const table = driver === 'mysql' ? `\`${events.tableName}\`` : `"${events.tableName}"`
    await DB.connection().executeCompiled({ sql: `INSERT INTO ${table} (tenant_id, billed_on) VALUES (7, '0000-01-01'), (7, '0001-01-01')`, source: 'test' })

    const days = await DB.table(events).where('tenant_id', 7).selectDate('day', 'billed_on', { as: 'day' }).orderBy('billed_on').pluck('day')

    expect(days).toEqual([null, '0001-01-01'])
  })
})

describe.each(integrationDrivers(['sqlite', 'mysql'] as const))('grouped date bucket cursors on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('reads a grouped cursor value selected in another case', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const page = (cursor: string | null) => DB.table(events.tableName)
      .whereIn('tenant_id', [1, 2])
      .whereNotNull('occurred_at')
      .select('TENANT_ID')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('tenant_id', 'day')
      .orderBy('tenant_id')
      .orderBy('day')
      .cursorPaginate(3, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data].map(row => row.day)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05', '2026-12-31', '2026-11-04'])
  })

  it('compares grouped column keys the way the database folds their case', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const page = await DB.table(events.tableName)
      .where('tenant_id', 2)
      .select(`${events.tableName}.tenant_id`)
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy(`${events.tableName}.TENANT_ID`, 'day')
      .orderBy(`${events.tableName}.tenant_id`)
      .orderBy('day')
      .cursorPaginate(5)

    expect(page.data).toEqual([{ tenant_id: 2, day: '2026-11-04' }])
  })
})

describe('date buckets on sqlite end-of-day timestamps', () => {
  afterEach(() => {
    resetDB()
  })

  it('rolls 24:00 over to the next day in every UTC spelling', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('sqlite')
    await DB.connection().executeCompiled({ sql: `INSERT INTO "${events.tableName}" (tenant_id, occurred_at) VALUES (12, '2026-12-31 24:00:00')`, source: 'test' })
    const hourIn = (timeZone: string) => DB.table(events).where('tenant_id', 12).selectDate('hour', 'occurred_at', { as: 'hour', timeZone }).value('hour')

    await expect(hourIn('UTC')).resolves.toBe('2027-01-01 00:00')
    await expect(hourIn('Etc/UTC')).resolves.toBe('2027-01-01 00:00')
  })
})

describe.runIf(mysqlIntegration)('date buckets in mysql mutation subqueries', () => {
  afterEach(() => {
    resetDB()
  })

  it('validates a subquery date bucket before probing time zone tables', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target)
          return (sql: string, bindings: readonly unknown[], options: unknown) => sql.startsWith('SELECT CONVERT_TZ')
            ? Promise.resolve({ rows: [{ converted: null }], rowCount: 1 })
            : target.query(sql, bindings, options as never)
        },
      }),
    })
    const subquery = DB.table(events).selectDate('day', 'occurred_at', { as: 'buuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu', timeZone: 'Asia/Tokyo' })

    await expect(DB.table(events).whereInSub('billed_on', subquery).update({ tenant_id: 9 })).rejects.toThrow(SecurityError)
  })

  it('writes through a builder whose discarded projection has a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target)
          return (sql: string, bindings: readonly unknown[], options: unknown) => sql.startsWith('SELECT CONVERT_TZ')
            ? Promise.resolve({ rows: [{ converted: null }], rowCount: 1 })
            : target.query(sql, bindings, options as never)
        },
      }),
    })

    await DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).where('id', 1).update({ tenant_id: 9 })

    await expect(DB.table(events).where('id', 1).value('tenant_id')).resolves.toBe(9)
  })
})

describe.runIf(mysqlIntegration)('date buckets in mysql having clauses', () => {
  afterEach(() => {
    resetDB()
  })

  it('rejects HAVING on a date bucket that a grouped column of the same name would shadow', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable('mysql')

    await expect(DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket', `${facts}.bucket`)
      .having('bucket', '2026-11-03')
      .get()).rejects.toThrow(CompilerError)
  })
})

describe.runIf(mysqlIntegration)('date buckets on mysql timestamp columns', () => {
  afterEach(() => {
    resetDB()
  })

  it('keeps instants apart across the fall-back hour of the app time zone', async () => {
    useAppTimezone('America/New_York')
    const { schema } = await openDatabase('mysql')
    const name = `bucket_stamps_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.timestamp('at')
    })
    const stamps = defineGeneratedTable(name, { id: column.id(), at: column.timestamp() })
    await DB.connection().executeCompiled({ sql: `INSERT INTO \`${name}\` (at) VALUES ('2026-11-01 05:30:00+00:00'), ('2026-11-01 06:30:00+00:00')`, source: 'test' })

    const hours = await DB.table(stamps).selectDate('hour', 'at', { as: 'hour', timeZone: 'UTC' }).orderBy('id').pluck('hour')

    expect(hours).toEqual(['2026-11-01 05:00', '2026-11-01 06:00'])
  })

  it('gives a null bucket for a zero timestamp', async () => {
    useAppTimezone('UTC')
    const { schema, db } = await openDatabase('mysql')
    const name = `bucket_stamps_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.timestamp('at').nullable()
    })
    const stamps = defineGeneratedTable(name, { id: column.id(), at: column.timestamp().nullable() })

    const day = await db.transaction(async (tx) => {
      await tx.executeCompiled({ sql: `SET SESSION sql_mode = ''`, source: 'test' })
      await tx.executeCompiled({ sql: `INSERT INTO \`${name}\` (at) VALUES ('0000-00-00 00:00:00')`, source: 'test' })
      return tx.table(stamps).selectDate('day', 'at', { as: 'day', timeZone: 'UTC' }).value('day')
    })

    expect(day).toBeNull()
  })

  it('treats UTC aliases as UTC without converting', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('mysql')
    await DB.connection().executeCompiled({ sql: `INSERT INTO \`${events.tableName}\` (tenant_id, occurred_at) VALUES (11, '1969-07-20 20:17:00')`, source: 'test' })
    const dayIn = (timeZone: string) => DB.table(events).where('tenant_id', 11).selectDate('day', 'occurred_at', { as: 'day', timeZone }).value('day')

    await expect(dayIn('UTC')).resolves.toBe('1969-07-20')
    await expect(dayIn('Etc/UTC')).resolves.toBe('1969-07-20')
    await expect(dayIn('etc/utc')).resolves.toBe('1969-07-20')
  })

  it('probes every converted time zone once in one statement', async () => {
    useAppTimezone('Europe/Paris')
    let probes = 0
    const events = await createEventsTable('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          if (property !== 'query') return Reflect.get(target, property, target)
          return (sql: string, bindings: readonly unknown[], options: unknown) => {
            if (sql.startsWith('SELECT CONVERT_TZ')) probes += 1
            return target.query(sql, bindings, options as never)
          }
        },
      }),
    })
    const days = () => DB.table(events).where('tenant_id', 1).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).get()

    await Promise.all([days(), days()])
    await days()
    for (const _attempt of [1, 2]) {
      await DB.connection().transaction(tx => tx.table(events).where('tenant_id', 1).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).get())
    }

    expect(probes).toBe(1)
  })

  it('runs a transaction probe of its own while an outside probe waits for the only pooled connection', async () => {
    useAppTimezone('Europe/Paris')
    const db = createDatabase({
      connectionName: 'default',
      adapter: createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } }),
      dialect: createDialect('mysql'),
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const name = `bucket_pooled_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const pooled = defineGeneratedTable(name, { id: column.id(), at: column.datetime() })
    try {
      await createSchemaService(db).createTable(name, (table) => {
        table.id()
        table.datetime('at')
      })
      await DB.table(pooled).count()
      const query = DB.table(pooled).selectDate('day', 'at', { as: 'day', timeZone: 'Asia/Tokyo' })
      const days = () => query.get()
      let began!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { began = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const inside = db.transaction(async () => {
        await DB.table(pooled).count()
        began()
        await gate
        return days()
      })
      await started
      const outside = days()
      await new Promise(resolve => setTimeout(resolve, 50))
      release()

      await expect(Promise.all([inside, outside])).resolves.toEqual([[], []])
    } finally {
      await createSchemaService(db).dropTable(name)
      await db.disconnect()
    }
  }, 10_000)

  it('runs a probe of its own on a connection pinned by withoutForeignKeyConstraints()', async () => {
    useAppTimezone('Europe/Paris')
    const db = createDatabase({
      connectionName: 'default',
      adapter: createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } }),
      dialect: createDialect('mysql'),
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const schema = createSchemaService(db)
    const name = `bucket_pinned_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const pinned = defineGeneratedTable(name, { id: column.id(), at: column.datetime() })
    try {
      await schema.createTable(name, (table) => {
        table.id()
        table.datetime('at')
      })
      await DB.table(pinned).count()
      const query = DB.table(pinned).selectDate('day', 'at', { as: 'day', timeZone: 'Asia/Tokyo' })
      let began!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { began = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      const inside = schema.withoutForeignKeyConstraints(async () => {
        await DB.table(pinned).count()
        began()
        await gate
        return query.get()
      })
      await started
      const outside = query.get()
      await new Promise(resolve => setTimeout(resolve, 50))
      release()

      await expect(Promise.all([inside, outside])).resolves.toEqual([[], []])
    } finally {
      await schema.dropTable(name)
      await db.disconnect()
    }
  }, 10_000)

  it('skips conversion for another spelling of the app time zone', async () => {
    useAppTimezone('America/New_York')
    const events = await createEventsTable('mysql')
    await DB.connection().executeCompiled({ sql: `INSERT INTO \`${events.tableName}\` (tenant_id, occurred_at) VALUES (13, '1960-06-01 12:00:00')`, source: 'test' })
    const dayIn = (timeZone: string) => DB.table(events).where('tenant_id', 13).selectDate('day', 'occurred_at', { as: 'day', timeZone }).value('day')

    await expect(dayIn('US/Eastern')).resolves.toBe('1960-06-01')
    await expect(dayIn('america/new_york')).resolves.toBe('1960-06-01')
  })

  it('gives a null bucket for a datetime its server cannot convert', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('mysql')
    await DB.connection().executeCompiled({ sql: `INSERT INTO \`${events.tableName}\` (tenant_id, occurred_at) VALUES (9, '9999-12-31 23:30:00')`, source: 'test' })

    const day = await DB.table(events).where('tenant_id', 9).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).value('day')

    expect(day).toBeNull()
  })

  it('reads timestamp columns from the stored instant whatever the session time zone', async () => {
    useAppTimezone('UTC')
    const { schema, db } = await openDatabase('mysql')
    const name = `bucket_stamps_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.timestamp('at')
    })
    const stamps = defineGeneratedTable(name, { id: column.id(), at: column.timestamp() })
    await DB.connection().executeCompiled({ sql: `INSERT INTO \`${name}\` (at) VALUES ('2026-11-04 23:30:00+00:00')`, source: 'test' })

    const days = await db.transaction(async (tx) => {
      await tx.executeCompiled({ sql: `SET time_zone = '+09:00'`, source: 'test' })
      return [
        await tx.table(stamps).selectDate('day', 'at', { as: 'day' }).value('day'),
        await tx.table(stamps).selectDate('day', 'at', { as: 'day', timeZone: 'UTC' }).value('day'),
      ]
    })

    expect(days).toEqual(['2026-11-04', '2026-11-04'])
  })
})

describe.runIf(postgresIntegration)('date buckets on postgres columns that differ only in case', () => {
  afterEach(() => {
    resetDB()
  })

  it('reads the column with the exact spelling', async () => {
    useAppTimezone('UTC')
    const { db } = await openDatabase('postgres')
    const name = `bucket_cased_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await createSchemaService(db).dropTable(name)
    })
    await db.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, at date, "At" timestamptz)`, source: 'test' })
    await db.executeCompiled({ sql: `INSERT INTO "${name}" (id, at, "At") VALUES (1, '2026-11-03', '2026-11-03 23:30:00+00')`, source: 'test' })
    const cased = defineGeneratedTable(name, { id: column.integer().primaryKey(), at: column.date(), At: column.timestamp() })

    const day = await DB.table(cased).selectDate('day', 'At', { as: 'bucket', timeZone: 'Asia/Tokyo' }).value('bucket')

    expect(day).toBe('2026-11-04')
  })
})

describe.runIf(postgresIntegration)('date buckets on postgres qualifiers that differ only in case', () => {
  afterEach(() => {
    resetDB()
  })

  it('needs metadata from the table bound to the exact qualifier', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const name = `bucket_unknown_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const connection = DB.connection()
    onTestFinished(async () => {
      await createSchemaService(connection).dropTable(name)
    })
    await connection.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, billed_on timestamptz)`, source: 'test' })

    const shadow = events.tableName.toUpperCase()

    await expect(DB.table(events.tableName)
      .join(`${name} as ${shadow}`, `${shadow}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${shadow}.billed_on`, { as: 'day', timeZone: 'Asia/Tokyo' })
      .get()).rejects.toThrow(ConfigurationError)
  })
})

describe.runIf(postgresIntegration)('date buckets next to postgres wildcards of case-distinct aliases', () => {
  afterEach(() => {
    resetDB()
  })

  it('checks only the wildcard of the exactly named alias', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const plain = await createKeyedTable('bucket_plain', 'amount', [{ id: 1, value: 1 }])
    const tagged = await createKeyedTable('bucket_tagged', 'bucket', [{ id: 1, value: 1 }])
    registerGeneratedTables({ events, plain, tagged })

    const rows = await DB.table(events.tableName)
      .join(`${plain.tableName} as tags`, 'tags.id', '=', `${events.tableName}.id`)
      .join(`${tagged.tableName} as Tags`, 'Tags.id', '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelect('tags.*')
      .get()

    expect(rows).toEqual([{ bucket: '2026-11-03', id: 1, amount: 1 }])
  })
})

describe.runIf(postgresIntegration)('date buckets with postgres qualifiers that bind no joined name exactly', () => {
  afterEach(() => {
    resetDB()
  })

  it('rejects a schema-qualified wildcard next to a date bucket', async () => {
    useAppTimezone('UTC')
    const { events, facts } = await createFactsTable('postgres')

    await expect(DB.table(events.tableName)
      .join(facts, `${facts}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'bucket', timeZone: 'UTC' })
      .addSelect(`public.${facts}.*`)
      .get()).rejects.toThrow(SecurityError)
  })

  it('needs the exact alias to bucket a joined column', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const labels = await createLabelsTable()
    registerGeneratedTables({ events, labels })

    await expect(DB.table(events.tableName)
      .join(`${labels.tableName} as Tags`, 'Tags.id', '=', `${events.tableName}.id`)
      .selectDate('day', 'tags.at', { as: 'bucket', timeZone: 'UTC' })
      .get()).rejects.toThrow(ConfigurationError)
  })
})

describe.runIf(postgresIntegration)('grouped date bucket cursors on postgres columns that differ only in case', () => {
  afterEach(() => {
    resetDB()
  })

  it('resolves a bare grouped column to the table with its exact spelling', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const connection = DB.connection()
    const name = `bucket_upper_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await createSchemaService(connection).dropTable(name)
    })
    await connection.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, "TENANT_ID" integer)`, source: 'test' })
    await connection.executeCompiled({ sql: `INSERT INTO "${name}" (id, "TENANT_ID") VALUES (5, 99)`, source: 'test' })
    registerGeneratedTables({ events, upper: defineGeneratedTable(name, { id: column.id(), TENANT_ID: column.integer() }) })

    const page = await DB.table(events.tableName)
      .join(name, `${name}.id`, '=', `${events.tableName}.id`)
      .select(`${events.tableName}.tenant_id`)
      .addSelectDate('day', `${events.tableName}.occurred_at`, { as: 'day', timeZone: 'UTC' })
      .groupBy('tenant_id', 'day')
      .orderBy(`${events.tableName}.tenant_id`)
      .orderBy('day')
      .cursorPaginate(5)

    expect(page.data).toEqual([{ tenant_id: 1, day: '2026-11-05' }])
  })
})

describe.runIf(postgresIntegration)('grouped date bucket cursors on postgres output names', () => {
  afterEach(() => {
    resetDB()
  })

  it('pages past output names PostgreSQL truncates to the same name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const alias = `k${'e'.repeat(62)}`
    const page = (cursor: string | null) => DB.table(events)
      .where('tenant_id', 1)
      .whereNotNull('occurred_at')
      .select(`id as ${alias}`, `tenant_id as ${alias}x`)
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('id', 'day')
      .orderBy('id')
      .cursorPaginate(3, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data].map(row => row.day)).toEqual(['2026-11-03', '2026-11-03', '2026-11-04', '2026-11-04', '2026-11-05', '2026-12-31'])
  })

  it('rejects a grouped order key that an alias shadows after PostgreSQL truncates it', async () => {
    useAppTimezone('UTC')
    const { db } = await openDatabase('postgres')
    const key = `k${'e'.repeat(62)}`
    const name = `bucket_long_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await createSchemaService(db).dropTable(name)
    })
    await db.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, "${key}" integer, at timestamp)`, source: 'test' })
    const long = defineGeneratedTable(name, { id: column.id(), [key]: column.integer(), at: column.datetime() })

    await expect(DB.table(long)
      .select(`id as ${key}x`)
      .addSelectDate('day', 'at', { as: 'day', timeZone: 'UTC' })
      .groupBy(key, 'day', 'id')
      .orderBy(key)
      .orderBy('day')
      .cursorPaginate(1)).rejects.toThrow(SecurityError)
  })

  it('orders by a key that differs from an output alias only in case', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')

    const page = await DB.table(events)
      .whereIn('id', [1, 2])
      .select('id', 'tenant_id as ID')
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .groupBy('id', 'day')
      .orderBy('id')
      .cursorPaginate(5)

    expect(page.data.map(row => row.id)).toEqual([1, 2])
  })
})

describe.runIf(postgresIntegration)('date buckets next to postgres domains and vectors', () => {
  afterEach(() => {
    resetDB()
  })

  it('reads a domain over timestamptz as an instant', async () => {
    useAppTimezone('UTC')
    const name = `bucket_domain_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const domain = `${name}_instant`
    const db = createDatabase({
      connectionName: 'default',
      adapter: createPostgresAdapter({ config: { ...postgresTestConnection(), options: '-c TimeZone=Asia/Tokyo' } }),
      dialect: createDialect('postgres'),
    })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    const instants = defineGeneratedTable(name, { id: column.integer().primaryKey(), at: column.timestamp() })
    try {
      await db.executeCompiled({ sql: `CREATE DOMAIN "${domain}" AS timestamptz`, source: 'test' })
      await db.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, at "${domain}")`, source: 'test' })
      await db.executeCompiled({ sql: `INSERT INTO "${name}" (id, at) VALUES (1, '2026-11-04 23:30:00+00')`, source: 'test' })

      const day = await DB.table(instants).selectDate('day', 'at', { as: 'day', timeZone: 'UTC' }).value('day')

      expect(day).toBe('2026-11-04')
    } finally {
      await db.executeCompiled({ sql: `DROP TABLE IF EXISTS "${name}"`, source: 'test' })
      await db.executeCompiled({ sql: `DROP DOMAIN IF EXISTS "${domain}"`, source: 'test' })
      await db.disconnect()
    }
  })

  it('orders by vector similarity of a joined column named like a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    const connection = DB.connection()
    const name = `bucket_vectors_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await createSchemaService(connection).dropTable(name)
    })
    await connection.executeCompiled({ sql: `CREATE TABLE "${name}" (id integer PRIMARY KEY, embedding vector(2))`, source: 'test' })
    await connection.executeCompiled({ sql: `INSERT INTO "${name}" (id, embedding) VALUES (1, '[1,2]'), (2, '[9,9]')`, source: 'test' })
    registerGeneratedTables({ events, vectors: defineGeneratedTable(name, { id: column.id(), embedding: column.vector({ dimensions: 2 }) }) })

    const rows = await DB.table(events.tableName)
      .join(name, `${name}.id`, '=', `${events.tableName}.id`)
      .selectDate('day', `${events.tableName}.occurred_at`, { as: 'embedding', timeZone: 'UTC' })
      .orderByVectorSimilarity('embedding', [1, 2])
      .get()

    expect(rows).toEqual([{ embedding: '2026-11-03' }, { embedding: '2026-11-03' }])
  })
})

describe.runIf(postgresIntegration)('date buckets on postgres before the common era', () => {
  afterEach(() => {
    resetDB()
  })

  it('gives a null bucket outside years 1 to 9999', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable('postgres')
    await DB.connection().executeCompiled({ sql: `INSERT INTO "${events.tableName}" (tenant_id, billed_on) VALUES (7, '0001-01-01 BC'), (7, '0001-01-01'), (7, '10000-01-01'), (7, '300000-01-01')`, source: 'test' })
    await DB.connection().executeCompiled({ sql: `INSERT INTO "${events.tableName}" (tenant_id, occurred_at) VALUES (9, '294276-12-31 23:59:59')`, source: 'test' })

    const days = await DB.table(events).where('tenant_id', 7).selectDate('day', 'billed_on', { as: 'day' }).orderBy('billed_on').pluck('day')
    const lastInstant = await DB.table(events).where('tenant_id', 9).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Asia/Tokyo' }).value('day')

    expect(days).toEqual([null, '0001-01-01', null, null])
    expect(lastInstant).toBeNull()
  })
})
