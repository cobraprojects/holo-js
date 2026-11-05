import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

const tokyoMidnightNov5 = new Date('2026-11-04T15:00:00Z')
const tokyoNoonNov5 = new Date('2026-11-05T03:00:00Z')
const tokyoMidnightNov6 = new Date('2026-11-05T15:00:00Z')
const tokyoMidnightNov7 = new Date('2026-11-06T15:00:00Z')

function useAppTimezoneAt(now: Date, timezone = 'Asia/Tokyo'): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone } } as never)
  process.env.TZ = 'America/New_York'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  onTestFinished(() => {
    vi.useRealTimers()
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

async function createEventsTable(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const name = `date_events_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.string('title')
    table.date('day').nullable()
    table.datetime('at').nullable()
  })
  const events = defineGeneratedTable(name, {
    id: column.id(),
    title: column.string(),
    day: column.date().nullable(),
    at: column.datetime().nullable(),
  })
  const Event = defineModel(events, { fillable: ['title', 'day', 'at'], timestamps: false })
  await Event.create({ title: 'model', day: tokyoMidnightNov5, at: new Date('2026-11-04T20:30:00Z') })
  await DB.table(events).insert({ title: 'calendar', day: '2026-11-05', at: new Date('2026-11-05T16:00:00Z') })
  await DB.table(events).insert({ title: 'later', day: '2026-11-07', at: new Date('2026-12-31T16:00:00Z') })
  return { events, Event }
}

describe.each(drivers)('date predicates in the app timezone on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('compares Date values with a DATE column as app-timezone calendar dates', async () => {
    useAppTimezoneAt(new Date('2026-11-04T20:00:00Z'))
    const { events, Event } = await createEventsTable(driver)
    const titles = (query: { orderBy(column: 'id'): { pluck(column: 'title'): Promise<unknown[]> } }) => query.orderBy('id').pluck('title')

    await expect(titles(DB.table(events).where('day', tokyoMidnightNov5))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).where('day', tokyoNoonNov5))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).where('day', '!=', tokyoMidnightNov5))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereIn('day', [tokyoMidnightNov5, tokyoMidnightNov7]))).resolves.toEqual(['model', 'calendar', 'later'])
    await expect(titles(DB.table(events).whereNotIn('day', [tokyoNoonNov5]))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).where('day', '<', tokyoMidnightNov7))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).where('day', '>', tokyoMidnightNov5))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).where('day', '>=', tokyoMidnightNov7))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereBetween('day', [tokyoNoonNov5, tokyoMidnightNov6]))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereNotBetween('day', [tokyoNoonNov5, tokyoMidnightNov6]))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).where('day', '2026-11-05'))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(Event.where('day', tokyoNoonNov5))).resolves.toEqual(['model', 'calendar'])
  })

  it('compares Date values with a DATE column holding datetime and calendar text when the app timezone is UTC', async () => {
    useAppTimezoneAt(new Date('2026-11-05T01:00:00Z'), 'UTC')
    const { events } = await createEventsTable(driver)
    const titles = (query: { orderBy(column: 'id'): { pluck(column: 'title'): Promise<unknown[]> } }) => query.orderBy('id').pluck('title')
    const utcMidnightNov4 = new Date('2026-11-04T00:00:00Z')

    await expect(titles(DB.table(events).where('day', utcMidnightNov4))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).where('day', new Date('2026-11-05T23:00:00Z')))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereIn('day', [utcMidnightNov4, new Date('2026-11-07T12:00:00Z')]))).resolves.toEqual(['model', 'later'])
    await expect(titles(DB.table(events).whereDate('day', '2026-11-04'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereDate('at', '2026-11-05'))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereToday('day'))).resolves.toEqual(['calendar'])
  })

  it('matches DATE and DATETIME rows by their app-timezone date parts', async () => {
    useAppTimezoneAt(new Date('2026-11-04T20:00:00Z'))
    const { events, Event } = await createEventsTable(driver)
    const titles = (query: { orderBy(column: 'id'): { pluck(column: 'title'): Promise<unknown[]> } }) => query.orderBy('id').pluck('title')

    await expect(titles(DB.table(events).whereDate('day', '2026-11-05'))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereDate('day', '>', '2026-11-05'))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereDate('day', tokyoNoonNov5))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereDate('at', '2026-11-05'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereDate('at', '2026-11-06'))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereDate('at', tokyoNoonNov5))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereToday('day'))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereToday('at'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereAfterToday('day'))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereAfterToday('at'))).resolves.toEqual(['calendar', 'later'])
    await expect(titles(DB.table(events).whereTodayOrBefore('day'))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereBeforeToday('day'))).resolves.toEqual([])
    await expect(titles(DB.table(events).whereDay('day', 5))).resolves.toEqual(['model', 'calendar'])
    await expect(titles(DB.table(events).whereDay('at', 5))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereDay('at', 1))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereMonth('day', 11))).resolves.toEqual(['model', 'calendar', 'later'])
    await expect(titles(DB.table(events).whereMonth('at', 1))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereYear('day', 2026))).resolves.toEqual(['model', 'calendar', 'later'])
    await expect(titles(DB.table(events).whereYear('at', 2027))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereTime('at', '05:30:00'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereTime('at', '<', '02:00:00'))).resolves.toEqual(['calendar', 'later'])
    await expect(titles(Event.whereDate('at', '2026-11-06'))).resolves.toEqual(['calendar'])
  })

  it('matches rows by the day the app timezone is in when the UTC day is behind it', async () => {
    useAppTimezoneAt(new Date('2026-11-05T14:00:00Z'), 'America/Los_Angeles')
    const { events } = await createEventsTable(driver)
    const titles = (query: { orderBy(column: 'id'): { pluck(column: 'title'): Promise<unknown[]> } }) => query.orderBy('id').pluck('title')

    await expect(titles(DB.table(events).whereDate('at', '2026-11-04'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereDate('at', '2026-11-05'))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereTime('at', '12:30:00'))).resolves.toEqual(['model'])
    await expect(titles(DB.table(events).whereDay('at', 31))).resolves.toEqual(['later'])
    await expect(titles(DB.table(events).whereYear('at', 2026))).resolves.toEqual(['model', 'calendar', 'later'])
    await expect(titles(DB.table(events).whereToday('at'))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereDate('day', '2026-11-05'))).resolves.toEqual(['calendar'])
    await expect(titles(DB.table(events).whereToday('day'))).resolves.toEqual(['calendar'])
  })
})
