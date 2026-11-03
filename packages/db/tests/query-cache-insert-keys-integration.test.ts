import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, clearGeneratedTables, column, registerGeneratedTables } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'

async function createTickets(driver: Driver) {
  const { schema, adapter } = await openDatabase(driver)
  const name = `tickets_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ tickets: defineTable(name, { ticket_no: column.id(), label: column.string() }) })
  await schema.createTable(name, (table) => {
    table.id('ticket_no')
    table.string('label')
  })
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await schema.dropTable(name)
  })
  return {
    cachedLabel: async (ticketNo: number) => (await DB.table(name).where('ticket_no', ticketNo).cache(60).first())?.label,
    insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => DB.table(name).insert(rows),
    insertGetId: (row: Record<string, unknown>) => DB.table(name).insertGetId(row),
    insertBehindTheCache: (ticketNo: number, label: string) => adapter.execute(`INSERT INTO ${name} (ticket_no, label) VALUES (${ticketNo}, '${label}')`),
  }
}

async function createVouchers(driver: Driver) {
  const { schema } = await openDatabase(driver)
  const name = `vouchers_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({ vouchers: defineTable(name, { code: column.string().primaryKey().default('SPRING'), label: column.string() }) })
  await schema.createTable(name, (table) => {
    table.string('code').primaryKey().default('SPRING')
    table.string('label')
  })
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await schema.dropTable(name)
  })
  return {
    cachedLabel: async (code: string) => (await DB.table(name).where('code', code).cache(60).first())?.label,
    insert: (row: Record<string, unknown>) => DB.table(name).insert(row),
  }
}

function registerInsertKeyScenarios(driver: Driver) {
  it('refreshes a cached read by key after inserting a row whose key comes from a database default', async () => {
    const vouchers = await createVouchers(driver)
    expect(await vouchers.cachedLabel('SPRING')).toBeUndefined()

    await vouchers.insert({ label: 'defaulted' })

    expect(await vouchers.cachedLabel('SPRING')).toBe('defaulted')
  })

  it('keeps an unrelated cached read by key after inserting a single row without its auto-increment key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(5)).toBeUndefined()
    await tickets.insertBehindTheCache(5, 'outside')

    await tickets.insertGetId({ label: 'next' })

    expect(await tickets.cachedLabel(5)).toBeUndefined()
  })

  it('refreshes a cached read by key after inserting a row without its generated key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(1)).toBeUndefined()

    await tickets.insert({ label: 'first' })

    expect(await tickets.cachedLabel(1)).toBe('first')
  })

  it('refreshes a cached read by key after a bulk insert without generated keys', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(2)).toBeUndefined()

    await tickets.insert([{ label: 'first' }, { label: 'second' }, { label: 'third' }])

    expect(await tickets.cachedLabel(2)).toBe('second')
  })

  it('keeps an unrelated cached read by key after inserting rows with explicit keys', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(5)).toBeUndefined()
    expect(await tickets.cachedLabel(6)).toBeUndefined()
    await tickets.insertBehindTheCache(5, 'outside')

    await tickets.insert([{ ticket_no: 6, label: 'sixth' }, { ticket_no: 7, label: 'seventh' }])

    expect(await tickets.cachedLabel(5)).toBeUndefined()
    expect(await tickets.cachedLabel(6)).toBe('sixth')
  })
}

describe('insert cache invalidation by primary key on sqlite', () => {
  registerInsertKeyScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('insert cache invalidation by primary key on postgres', () => {
  registerInsertKeyScenarios('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('insert cache invalidation by primary key on mysql', () => {
  registerInsertKeyScenarios('mysql')
})
