import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, HydrationError, clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

describe.each(drivers)('name-only generated schema reads on %s', driver => {
  it('matches typed decimal scales and safe integer values while unknown tables keep driver values', async () => {
    const { schema } = await openDatabase(driver)
    const name = `holo_prices_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.bigInteger('quantity')
      table.decimal('amount', 10, 4)
      table.decimal('whole', 10, 0)
      table.decimal('optional', 10, 4).nullable()
    })
    onTestFinished(() => schema.dropTable(name))
    onTestFinished(() => clearGeneratedTables())
    const prices = defineGeneratedTable(name, {
      id: column.integer().primaryKey(),
      quantity: column.bigInteger(),
      amount: column.decimal(undefined, 10, 4),
      whole: column.decimal(undefined, 10, 0),
      optional: column.decimal(undefined, 10, 4).nullable(),
    })
    await DB.table(prices).insert({ id: 1, quantity: 5, amount: '12.3000', whole: '12', optional: null })
    const native = await DB.table(name).first()
    expect(native).toEqual({ id: 1, quantity: driver === 'postgres' ? '5' : 5, amount: driver === 'sqlite' ? 12.3 : '12.3000', whole: driver === 'sqlite' ? 12 : '12', optional: null })
    registerGeneratedTables({ prices })
    const expected = { id: 1, quantity: 5, amount: '12.3000', whole: '12', optional: null }
    expect(await DB.table(prices).first()).toEqual(expected)
    expect(await DB.table(name).first()).toEqual(expected)
    expect(await DB.table(name).select('amount as value').first()).toEqual({ value: '12.3000' })
    expect(await DB.table(name).value('quantity')).toBe(5)
    expect(await DB.table(name).pluck('amount')).toEqual(['12.3000'])
  })
})

describe.each(drivers)('name-only integer overflow on %s', driver => {
  it('rejects unsafe declared integers and leaves unknown-table integers in driver form', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_overflow_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.bigInteger('quantity')
    })
    onTestFinished(() => schema.dropTable(name))
    onTestFinished(() => clearGeneratedTables())
    await db.table(name).insert({ quantity: '9007199254740993' })
    expect(await db.table(name).value('quantity')).toBe('9007199254740993')
    const quantities = defineGeneratedTable(name, { quantity: column.bigInteger() })
    registerGeneratedTables({ quantities })
    await expect(db.table(quantities).get()).rejects.toBeInstanceOf(HydrationError)
    await expect(db.table(name).get()).rejects.toBeInstanceOf(HydrationError)
  })
})


describe.each(drivers)('generated bigint arithmetic on %s', driver => {
  it('adjusts unsafe bigint values in SQL while public reads still reject them', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_counters_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.bigInteger('quantity')
    })
    onTestFinished(() => schema.dropTable(name))
    onTestFinished(() => clearGeneratedTables())
    const counters = defineGeneratedTable(name, { id: column.integer().primaryKey(), quantity: column.bigInteger() })
    await db.table(name).insert({ id: 1, quantity: '9007199254740993' })
    registerGeneratedTables({ counters })

    expect((await db.table(name).where('id', 1).increment('quantity', 1)).affectedRows).toBe(1)
    await expect(db.table(name).where('id', 1).first()).rejects.toBeInstanceOf(HydrationError)
    await expect(db.table(counters).where('id', 1).first()).rejects.toBeInstanceOf(HydrationError)
    clearGeneratedTables()
    expect(await db.table(name).where('id', 1).value('quantity')).toBe('9007199254740994')
    registerGeneratedTables({ counters })

    expect((await db.table(name).where('id', 1).decrement('quantity', 2)).affectedRows).toBe(1)
    await expect(db.table(name).where('id', 1).first()).rejects.toBeInstanceOf(HydrationError)
    clearGeneratedTables()
    expect(await db.table(name).where('id', 1).value('quantity')).toBe('9007199254740992')
  })
})
