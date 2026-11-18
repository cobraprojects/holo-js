import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CapabilityError, ConfigurationError, DB, SecurityError, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB } from '../src'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { integrationDrivers, mysqlIntegration, openDatabase, postgresIntegration, postgresTestConnection } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function useAppTimezone(timezone: string): void {
  configureConfigRuntime({ app: { timezone } } as never)
  onTestFinished(() => {
    resetConfigRuntime()
  })
}

async function createEventsTable(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
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

  it('rejects time zones that are not IANA names', async () => {
    const events = await createEventsTable(driver)

    expect(() => DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: '+03:00' })).toThrow(SecurityError)
    expect(() => DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'Mars/Olympus' })).toThrow(SecurityError)
  })

  it('keeps where clauses on the column when a date bucket alias reuses its name on a table passed by name', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)

    const rows = await DB.table(events.tableName)
      .where('tenant_id', 2)
      .selectDate('day', 'occurred_at', { as: 'tenant_id', timeZone: 'UTC' })
      .get()

    expect(rows).toEqual([{ tenant_id: '2026-11-04' }])
  })

  it('orders and cursor-paginates a union by a date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const daysBetween = (from: Date, to: Date) => DB.table(events)
      .where('tenant_id', 1)
      .whereBetween('occurred_at', [from, to])
      .selectDate('day', 'occurred_at', { as: 'bucket', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('bucket')
    const combined = () => daysBetween(new Date('2026-11-04T00:00:00Z'), new Date('2027-01-01T00:00:00Z'))
      .unionAll(daysBetween(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-03T23:59:59Z')))
      .orderByDesc('bucket')

    const rows = await combined().get()
    const first = await combined().cursorPaginate(2)
    const second = await combined().cursorPaginate(2, first.nextCursor)

    expect(rows).toEqual([
      { bucket: '2026-12-31', total: 1 },
      { bucket: '2026-11-05', total: 1 },
      { bucket: '2026-11-04', total: 2 },
      { bucket: '2026-11-03', total: 2 },
    ])
    expect(first.data).toEqual(rows.slice(0, 2))
    expect(second.data).toEqual(rows.slice(2))
    expect(second.nextCursor).toBeNull()
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

  it('reads a time zone link the way JavaScript does', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    await DB.table(events).insert({ tenant_id: 5, occurred_at: new Date('2026-07-15T12:00:00Z'), billed_on: null })
    const hourIn = (timeZone: string) => DB.table(events).where('tenant_id', 5).selectDate('hour', 'occurred_at', { as: 'hour', timeZone }).value('hour')

    await expect(hourIn('CET')).resolves.toBe('2026-07-15 14:00')
    await expect(hourIn('US/Eastern')).resolves.toBe('2026-07-15 08:00')
  })

  it('needs a date, datetime or timestamp column it can identify', async () => {
    useAppTimezone('UTC')
    const events = await createEventsTable(driver)
    const { schema } = await openDatabase(driver)
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
})
