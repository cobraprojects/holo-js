import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CapabilityError, DB, SecurityError, column, defineGeneratedTable, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

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
})

describe.skipIf(!drivers.includes('mysql' as never))('date buckets on mysql without time zone tables', () => {
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
})
