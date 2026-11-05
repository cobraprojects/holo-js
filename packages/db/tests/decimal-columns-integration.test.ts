import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

async function openPrices(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const name = `holo_prices_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('label')
    table.decimal('amount')
    table.decimal('discount').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  const prices = defineGeneratedTable(name, {
    id: column.id(),
    label: column.string(),
    amount: column.decimal(),
    discount: column.decimal().nullable(),
  })
  return { prices, schema }
}

describe.each(drivers)('decimal columns on %s', (driver) => {
  it('round-trips decimal text through models', async () => {
    const { prices } = await openPrices(driver)
    const Price = defineModel(prices, { fillable: ['label', 'amount', 'discount'], timestamps: false })

    const exact = await Price.create({ label: 'exact', amount: '12.34', discount: '0.50' })
    const padded = await Price.create({ label: 'padded', amount: '12.30', discount: null })

    const readExact = await Price.findOrFail(exact.get('id'))
    const readPadded = await Price.findOrFail(padded.get('id'))
    expectTypeOf(readExact.get('amount')).toEqualTypeOf<string>()
    expect(readExact.get('amount')).toBe('12.34')
    expect(readExact.get('discount')).toBe('0.50')
    expect(readPadded.get('amount')).toBe('12.30')
    expect(readPadded.get('discount')).toBeNull()
    expect((await Price.where('amount', '>', '12.31').get()).map(price => price.get('label'))).toEqual(['exact'])
  })

  it('round-trips decimal text through the query builder', async () => {
    const { prices } = await openPrices(driver)
    await DB.table(prices).insert([
      { label: 'exact', amount: '12.34' },
      { label: 'padded', amount: '12.30' },
    ])

    const rows = await DB.table(prices).orderBy('id').get()
    expectTypeOf(rows[0]!.amount).toEqualTypeOf<string>()
    expect(rows.map(row => row.amount)).toEqual(['12.34', '12.30'])
    expect(await DB.table(prices).where('label', 'padded').value('amount')).toBe('12.30')
    expect(await DB.table(prices).orderBy('id').pluck('amount')).toEqual(['12.34', '12.30'])
    expect(await DB.table(prices).select('amount as price').where('label', 'padded').first()).toEqual({ price: '12.30' })
    expect(await DB.table(prices).where('label', 'padded').first()).toMatchObject({ amount: '12.30', discount: null })
  })

  it('chunks by a decimal column in numeric order when the rows are sorted in memory', async () => {
    const { prices } = await openPrices(driver)
    await DB.table(prices).insert([
      { label: 'ten', amount: '10.00' },
      { label: 'two', amount: '2.00' },
      { label: 'nine', amount: '9.00' },
      { label: 'negative', amount: '-3.50' },
    ])

    const ascending: string[] = []
    await DB.table(prices).select('amount').distinct().chunkById(2, (rows) => {
      ascending.push(...rows.map(row => String(row.amount)))
    }, 'amount')
    const descending: string[] = []
    await DB.table(prices).select('amount').distinct().chunkByIdDesc(2, (rows) => {
      descending.push(...rows.map(row => String(row.amount)))
    }, 'amount')

    const aliased: string[] = []
    await DB.table(prices).select('amount as price').distinct().chunkById(2, (rows) => {
      aliased.push(...rows.map(row => String(row.price)))
    }, 'price')

    expect(ascending).toEqual(['-3.50', '2.00', '9.00', '10.00'])
    expect(descending).toEqual(['10.00', '9.00', '2.00', '-3.50'])
    expect(aliased).toEqual(['-3.50', '2.00', '9.00', '10.00'])
  })

  it('chunks by a joined decimal column in numeric order', async () => {
    const { prices, schema } = await openPrices(driver)
    const ordersName = `holo_orders_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ordersName, (table) => {
      table.id()
      table.integer('price_id')
    })
    onTestFinished(() => schema.dropTable(ordersName))
    const orders = defineGeneratedTable(ordersName, { id: column.id(), price_id: column.integer() })
    await DB.table(prices).insert([
      { id: 1, label: 'ten', amount: '10.00' },
      { id: 2, label: 'two', amount: '2.00' },
      { id: 3, label: 'nine', amount: '9.00' },
    ])
    await DB.table(orders).insert([{ price_id: 1 }, { price_id: 2 }, { price_id: 3 }])

    const amounts: string[] = []
    await DB.table(orders)
      .join(prices, `${ordersName}.price_id`, '=', `${prices.tableName}.id`)
      .select(`${prices.tableName}.amount`)
      .chunkById(2, (rows) => {
        amounts.push(...rows.map(row => String(row.amount)))
      }, `${prices.tableName}.amount`)

    expect(amounts).toEqual(['2.00', '9.00', '10.00'])
  })

})
