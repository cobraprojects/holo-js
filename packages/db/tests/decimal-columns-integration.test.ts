import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
import { DB, column, defineGeneratedTable, defineModel, hasMany, resetDB } from '../src'
import { mysqlTestConnection, openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

async function openPrices(driver: Driver, options: Parameters<typeof openDatabase>[1] = {}) {
  const { schema } = await openDatabase(driver, options)
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
  return { prices, schema, name }
}

function defaultSchema(driver: Driver): string {
  return driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database
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

  it('converts cached rows for the builder that reads them', async () => {
    const { prices } = await openPrices(driver)
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    await DB.table(prices).insert({ label: 'padded', amount: '12.30' })

    const named = await DB.table(prices.tableName).select('amount').cache(60).first()
    const typed = await DB.table(prices).select('amount').cache(60).first()

    expect(typed).toEqual({ amount: '12.30' })
    expect(named).toEqual(await DB.table(prices.tableName).select('amount').first())
  })

  it('returns driver values to name-only reads after a typed cache miss', async () => {
    const { prices } = await openPrices(driver)
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    onTestFinished(() => resetCacheRuntime())
    await DB.table(prices).insert({ label: 'padded', amount: '12.30' })

    expect(await DB.table(prices).select('amount').cache(60).first()).toEqual({ amount: '12.30' })
    expect(await DB.table(prices.tableName).select('amount').cache(60).first())
      .toEqual(await DB.table(prices.tableName).select('amount').first())
  })

  it('reads a decimal column through its schema-qualified table by the bare table name', async () => {
    const { prices, name, schema } = await openPrices(driver)
    const qualified = defineGeneratedTable(`${defaultSchema(driver)}.${name}`, { id: column.id(), label: column.string(), amount: column.decimal() })
    await DB.table(prices).insert({ label: 'padded', amount: '12.30' })

    expect(await DB.table(qualified).select(`${name}.amount` as never).first()).toEqual({ amount: '12.30' })
    const ordersName = `holo_qualified_orders_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ordersName, (table) => {
      table.id()
      table.integer('price_id')
    })
    onTestFinished(() => schema.dropTable(ordersName))
    const orders = defineGeneratedTable(ordersName, { id: column.id(), price_id: column.integer() })
    const { id } = (await DB.table(prices).first())!
    await DB.table(orders).insert({ price_id: id })
    expect(await DB.table(orders).join(qualified, `${ordersName}.price_id` as never, '=', `${name}.id` as never).select(`${name}.amount` as never).first()).toEqual({ amount: '12.30' })
  })

  it('leaves a raw selection that reuses a decimal or integer key as the driver returns it', async () => {
    const { prices } = await openPrices(driver, { security: { allowUnsafeRawSql: true } })
    await DB.table(prices).insert({ label: 'padded', amount: '12.30' })

    const row = await DB.table(prices).select('id', 'amount').addUnsafeSelect('0.5 AS id, 1 AS amount', []).first()

    expect(Number(row?.id)).toBe(0.5)
    expect(Number(row?.amount)).toBe(1)
    expect(row?.amount).not.toBe('1.00')
  })

  it('counts and checks existence when a decimal column shares the synthetic result key', async () => {
    const { schema } = await openPrices(driver)
    const name = `holo_marks_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, (table) => {
      table.id()
      table.decimal('__holo_exists')
      table.decimal('__holo_count')
    })
    onTestFinished(() => schema.dropTable(name))
    const marks = defineGeneratedTable(name, { id: column.id(), __holo_exists: column.decimal(), __holo_count: column.decimal() })
    await DB.table(marks).insert({ __holo_exists: '1.00', __holo_count: '1.00' })

    expect(await DB.table(marks).exists()).toBe(true)
    expect(await DB.table(marks).doesntExist()).toBe(false)
    expect(await DB.table(marks).count()).toBe(1)
    expect((await DB.table(marks).paginate(10)).meta.total).toBe(1)
  })

  it('aggregates decimal columns through models and relations', async () => {
    const { prices, schema } = await openPrices(driver)
    const linesName = `holo_lines_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(linesName, (table) => {
      table.id()
      table.integer('price_id')
      table.decimal('total')
    })
    onTestFinished(() => schema.dropTable(linesName))
    const lines = defineGeneratedTable(linesName, { id: column.id(), price_id: column.integer(), total: column.decimal() })
    const Line = defineModel(lines, { timestamps: false })
    const Price = defineModel(prices, { timestamps: false, relations: { lines: hasMany(() => Line, 'price_id') } })
    await DB.table(prices).insert([{ id: 1, label: 'low', amount: '1.25' }, { id: 2, label: 'high', amount: '2.50' }])
    await DB.table(lines).insert([{ price_id: 1, total: '0.50' }, { price_id: 1, total: '1.00' }])

    expect(await Price.sum('amount')).toBe(3.75)
    expect(await Price.avg('amount')).toBe(1.875)
    expect(await Price.min('amount')).toBe(1.25)
    expect(await Price.max('amount')).toBe(2.5)
    const withTotals = await Price.withSum('lines', 'total').orderBy('id').get()
    expect(withTotals.map(price => (price.toJSON() as Record<string, unknown>).lines_sum_total)).toEqual([1.5, 0])
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

  it('reads a decimal column that two joined tables share as decimal text', async () => {
    const { prices, schema } = await openPrices(driver)
    const ratesName = `holo_rates_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ratesName, (table) => {
      table.id()
      table.decimal('amount')
    })
    onTestFinished(() => schema.dropTable(ratesName))
    const rates = defineGeneratedTable(ratesName, { id: column.id(), amount: column.decimal() })
    await DB.table(prices).insert({ label: 'exact', amount: '12.30' })
    await DB.table(rates).insert({ amount: '2.50' })

    const rows = await DB.table(prices).crossJoin(rates).get()

    expect(rows).toHaveLength(1)
    expect(['12.30', '2.50']).toContain(rows[0]!.amount)
  })

  it('leaves a column that a later unknown wildcard may overwrite as the driver returns it', async () => {
    const { prices, schema } = await openPrices(driver)
    const legacyName = `holo_legacy_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(legacyName, (table) => {
      table.id()
      table.integer('amount')
    })
    onTestFinished(() => schema.dropTable(legacyName))
    await DB.table(prices).insert({ label: 'exact', amount: '12.30' })
    await DB.table(legacyName).insert({ amount: 7 })

    const row = await DB.table(prices).crossJoin(legacyName).select(`${prices.tableName}.*`, `${legacyName}.*`).first()

    expect(row?.amount).toBe(7)
    const legacy = defineGeneratedTable(legacyName, { id: column.id(), amount: column.integer() })
    expect((await DB.table(legacy).crossJoin(prices).first())?.amount).toBe('12.30')
    expect((await DB.table(prices).crossJoin(legacy).first())?.amount).toBe(7)
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
    const projected: string[] = []
    await DB.table(orders)
      .join(prices, `${ordersName}.price_id`, '=', `${prices.tableName}.id`)
      .select(`${prices.tableName}.amount`)
      .chunkByIdDesc(2, (rows) => {
        projected.push(...rows.map(row => String(row.amount)))
      }, 'amount')
    expect(projected).toEqual(['10.00', '9.00', '2.00'])
    const joined = () => DB.table(prices).join(orders, `${ordersName}.price_id`, '=', `${prices.tableName}.id`).where(`${prices.tableName}.label`, 'two')
    expect(await joined().select('amount').first()).toEqual({ amount: '2.00' })
    expect(await joined().first()).toMatchObject({ amount: '2.00', label: 'two', price_id: 2 })
  })

})
