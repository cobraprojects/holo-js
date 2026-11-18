import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { describe, expect, it, onTestFinished } from 'vitest'
import { CapabilityError, ConfigurationError, DB, SecurityError, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '../src'
import { integrationDrivers, mysqlIntegration, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function useAppTimezone(timezone: string): void {
  configureConfigRuntime({ app: { timezone } } as never)
  onTestFinished(() => {
    resetConfigRuntime()
  })
}

async function createEvents(driver: typeof drivers[number], options: Parameters<typeof openDatabase>[1] = {}) {
  const { schema } = await openDatabase(driver, options)
  const name = `bucket_events_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('tenant_id')
    table.datetime('occurred_at').nullable()
    table.timestamp('seen_at').nullable()
    table.date('billed_on').nullable()
  })
  const events = defineGeneratedTable(name, {
    id: column.id(),
    tenant_id: column.integer(),
    occurred_at: column.datetime().nullable(),
    seen_at: column.timestamp().nullable(),
    billed_on: column.date().nullable(),
  })
  registerGeneratedTables({ events })
  onTestFinished(() => clearGeneratedTables())
  const at = (iso: string) => ({ occurred_at: new Date(iso), seen_at: new Date(iso) })
  await DB.table(events).insert([
    { tenant_id: 1, ...at('2026-11-03T10:00:00Z'), billed_on: '2026-11-03' },
    { tenant_id: 1, ...at('2026-11-03T23:30:00Z'), billed_on: '2026-11-03' },
    { tenant_id: 1, ...at('2026-11-04T01:00:00Z'), billed_on: '2026-11-04' },
    { tenant_id: 2, ...at('2026-11-04T12:00:00Z'), billed_on: '2026-11-04' },
    { tenant_id: 1, ...at('2026-12-31T23:59:00Z'), billed_on: '2026-12-31' },
    { tenant_id: 1, occurred_at: null, seen_at: null, billed_on: null },
  ])
  return events
}

describe.each(drivers)('date buckets on %s', (driver) => {
  it('selects each unit as a zero-padded string', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)

    const row = await DB.table(events)
      .where('id', 3)
      .selectDate('year', 'occurred_at', { as: 'year', timeZone: 'UTC' })
      .addSelectDate('month', 'occurred_at', { as: 'month', timeZone: 'UTC' })
      .addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectDate('hour', 'occurred_at', { as: 'hour', timeZone: 'UTC' })
      .first()

    expect(row).toEqual({ year: '2026', month: '2026-11', day: '2026-11-04', hour: '2026-11-04 01:00' })
  })

  it.each(['occurred_at', 'seen_at'] as const)('converts %s to the requested time zone before taking the day', async (at) => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    const day = (timeZone: string) => DB.table(events).where('id', 2).selectDate('day', at, { as: 'day', timeZone }).value('day')

    expect(await day('UTC')).toBe('2026-11-03')
    expect(await day('Asia/Tokyo')).toBe('2026-11-04')
    expect(await day('America/New_York')).toBe('2026-11-03')
  })

  it('takes the day in app.timezone when no time zone is given', async () => {
    useAppTimezone('Asia/Tokyo')
    const events = await createEvents(driver)

    expect(await DB.table(events).where('id', 2).selectDate('day', 'occurred_at', { as: 'day' }).value('day')).toBe('2026-11-04')
  })

  it('keeps the calendar day of a date column in every time zone', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)

    expect(await DB.table(events).where('id', 2).selectDate('day', 'billed_on', { as: 'day', timeZone: 'Asia/Tokyo' }).value('day')).toBe('2026-11-03')
  })

  it('returns a null bucket for a null date', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)

    expect(await DB.table(events).where('id', 6).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).value('day')).toBeNull()
  })

  it('groups, filters and orders per-day totals newest first', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)

    const rows = await DB.table(events)
      .whereNotNull('occurred_at')
      .selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' })
      .addSelectCount('total')
      .groupBy('day')
      .having('day', '<', '2026-12-01')
      .orderByDesc('day')
      .get()

    expect(rows).toEqual([{ day: '2026-11-04', total: 2 }, { day: '2026-11-03', total: 2 }])
  })

  it('counts and paginates groups of days', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    const perDay = () => DB.table(events).whereNotNull('occurred_at').selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).addSelectCount('total').groupBy('day').orderBy('day')

    const page = await perDay().paginate(2, 2)

    expect(await perDay().count()).toBe(3)
    expect(page.meta.total).toBe(3)
    expect(page.data).toEqual([{ day: '2026-12-31', total: 1 }])
  })

  it('cursor-paginates per-day totals newest first, forward and back', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    const perDay = (cursor: string | null) => DB.table(events).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).addSelectCount('total').groupBy('day').orderByDesc('day').cursorPaginate(2, cursor)

    const first = await perDay(null)
    const second = await perDay(first.nextCursor)
    const back = await perDay(second.prevCursor)

    expect([...first.data, ...second.data].map(row => row.day)).toEqual(driver === 'postgres'
      ? [null, '2026-12-31', '2026-11-04', '2026-11-03']
      : ['2026-12-31', '2026-11-04', '2026-11-03', null])
    expect(second.nextCursor).toBeNull()
    expect(back.data).toEqual(first.data)
  })

  it('cursor-paginates rows by a date bucket and the primary key', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    const page = (cursor: string | null) => DB.table(events).whereNotNull('occurred_at').select('id').addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).orderBy('day').cursorPaginate(2, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)
    const third = await page(second.nextCursor)

    expect([...first.data, ...second.data, ...third.data].map(row => row.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('cursor-paginates a union by its date bucket', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    const daysOf = (tenantId: number) => DB.table(events).where('tenant_id', tenantId).whereNotNull('occurred_at').select('tenant_id').addSelectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).addSelectCount('total').groupBy('tenant_id', 'day')
    const page = (cursor: string | null) => daysOf(1).unionAll(daysOf(2)).orderBy('day').orderBy('tenant_id').cursorPaginate(2, cursor)

    const first = await page(null)
    const second = await page(first.nextCursor)

    expect([...first.data, ...second.data]).toEqual([
      { tenant_id: 1, day: '2026-11-03', total: 2 },
      { tenant_id: 1, day: '2026-11-04', total: 1 },
      { tenant_id: 2, day: '2026-11-04', total: 1 },
      { tenant_id: 1, day: '2026-12-31', total: 1 },
    ])
  })

  it('rejects an alias that names a column of the query', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)

    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'billed_on', timeZone: 'UTC' }).get()).rejects.toThrow(SecurityError)
  })

  it('rejects an unknown unit and a time zone abbreviation', async () => {
    const events = await createEvents(driver)

    expect(() => DB.table(events.tableName).selectDate('week' as 'day', 'occurred_at', { as: 'day' })).toThrow(SecurityError)
    expect(() => DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'CET' })).toThrow(SecurityError)
  })

  it('needs to know whether the column holds a date or an instant', async () => {
    useAppTimezone('UTC')
    const events = await createEvents(driver)
    clearGeneratedTables()

    await expect(DB.table(events.tableName).selectDate('day', 'occurred_at', { as: 'day', timeZone: 'UTC' }).get()).rejects.toThrow(ConfigurationError)
  })
})

describe.runIf(mysqlIntegration)('date buckets on mysql without time zone tables', () => {
  it('throws a CapabilityError instead of returning null buckets', async () => {
    useAppTimezone('UTC')
    const events = await createEvents('mysql', {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          const query = target.query.bind(target)
          if (property !== 'query') return Reflect.get(target, property, target)
          return async (...args: Parameters<typeof query>) => {
            const result = await query(...args)
            return typeof args[0] === 'string' && args[0].includes('CONVERT_TZ(\'2000-01-01 00:00:00\'')
              ? { ...result, rows: result.rows.map(row => Object.fromEntries(Object.keys(row).map(key => [key, null]))) }
              : result
          }
        },
      }),
    })

    await expect(DB.table(events).selectDate('day', 'seen_at', { as: 'day', timeZone: 'Asia/Tokyo' }).get()).rejects.toThrow(CapabilityError)
  })
})
