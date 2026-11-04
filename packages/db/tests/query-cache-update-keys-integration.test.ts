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
  await DB.table(name).insert({ ticket_no: 1, label: 'first' })
  return {
    cachedLabel: async (ticketNo: number) => (await DB.table(name).where('ticket_no', ticketNo).cache(60).first())?.label,
    update: (ticketNo: number, values: Record<string, unknown>) => DB.table(name).where('ticket_no', ticketNo).update(values),
    increment: (ticketNo: number, amount: number) => DB.table(name).where('ticket_no', ticketNo).increment('ticket_no', amount),
    insertBehindTheCache: (ticketNo: number, label: string) => adapter.execute(`INSERT INTO ${name} (ticket_no, label) VALUES (${ticketNo}, '${label}')`),
  }
}

async function createSeats(driver: Driver) {
  const { schema } = await openDatabase(driver)
  const name = `seats_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
  registerGeneratedTables({
    seats: defineTable(name, {
      row_no: column.integer().primaryKey(),
      seat_no: column.integer().primaryKey(),
      label: column.string(),
    }),
  })
  await schema.createTable(name, (table) => {
    table.integer('row_no')
    table.integer('seat_no')
    table.string('label')
    table.primary(['row_no', 'seat_no'])
  })
  onTestFinished(async () => {
    clearGeneratedTables()
    resetCacheRuntime()
    await schema.dropTable(name)
  })
  await DB.table(name).insert({ row_no: 1, seat_no: 1, label: 'aisle' })
  return {
    cachedLabel: async (rowNo: number, seatNo: number) => (await DB.table(name).where('row_no', rowNo).where('seat_no', seatNo).cache(60).first())?.label,
    update: (rowNo: number, seatNo: number, values: Record<string, unknown>) => DB.table(name).where('row_no', rowNo).where('seat_no', seatNo).update(values),
  }
}

function registerUpdateKeyScenarios(driver: Driver) {
  it('refreshes cached reads of the old and new key after an update changes the primary key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(1)).toBe('first')
    expect(await tickets.cachedLabel(9)).toBeUndefined()

    await tickets.update(1, { ticket_no: 9 })

    expect(await tickets.cachedLabel(1)).toBeUndefined()
    expect(await tickets.cachedLabel(9)).toBe('first')
  })

  it('keeps an unrelated cached read by key after an update changes the primary key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(5)).toBeUndefined()
    await tickets.insertBehindTheCache(5, 'outside')

    await tickets.update(1, { ticket_no: 9 })

    expect(await tickets.cachedLabel(5)).toBeUndefined()
  })

  it('keeps an unrelated cached read by key after an update that does not touch the primary key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(1)).toBe('first')
    expect(await tickets.cachedLabel(5)).toBeUndefined()
    await tickets.insertBehindTheCache(5, 'outside')

    await tickets.update(1, { label: 'renamed' })

    expect(await tickets.cachedLabel(1)).toBe('renamed')
    expect(await tickets.cachedLabel(5)).toBeUndefined()
  })

  it('refreshes a cached read of the new key after incrementing the primary key', async () => {
    const tickets = await createTickets(driver)
    expect(await tickets.cachedLabel(9)).toBeUndefined()

    await tickets.increment(1, 8)

    expect(await tickets.cachedLabel(1)).toBeUndefined()
    expect(await tickets.cachedLabel(9)).toBe('first')
  })

  it('refreshes a cached read of the new composite key after an update changes one key column', async () => {
    const seats = await createSeats(driver)
    expect(await seats.cachedLabel(1, 4)).toBeUndefined()

    await seats.update(1, 1, { seat_no: 4 })

    expect(await seats.cachedLabel(1, 1)).toBeUndefined()
    expect(await seats.cachedLabel(1, 4)).toBe('aisle')
  })
}

describe('update cache invalidation by primary key on sqlite', () => {
  registerUpdateKeyScenarios('sqlite')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('update cache invalidation by primary key on postgres', () => {
  registerUpdateKeyScenarios('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('update cache invalidation by primary key on mysql', () => {
  registerUpdateKeyScenarios('mysql')
})
