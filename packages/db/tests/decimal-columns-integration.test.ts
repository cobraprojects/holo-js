import { randomUUID } from 'node:crypto'
import { describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, queryCacheInternals, resetDB, type DatabaseDependencyInvalidationEvent } from '../src'
import type { DatabaseMutationEvent } from '../src/cache'
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
  return defineGeneratedTable(name, {
    id: column.id(),
    label: column.string(),
    amount: column.decimal(),
    discount: column.decimal().nullable(),
  })
}

describe.each(drivers)('decimal columns on %s', (driver) => {
  it('round-trips decimal text through models', async () => {
    const prices = await openPrices(driver)
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
    const prices = await openPrices(driver)
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

  it('publishes mutation rows with the decimal text that queries read', async () => {
    const prices = await openPrices(driver)
    const mutations: DatabaseMutationEvent[] = []
    const unsubscribe = queryCacheInternals.onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { mutations?: readonly DatabaseMutationEvent[] }) => {
      mutations.push(...event.mutations ?? [])
    })
    onTestFinished(unsubscribe)

    await DB.table(prices).insert({ label: 'padded', amount: '12.30' })
    await DB.table(prices).where('label', 'padded').update({ discount: '0.50' })
    const { id } = (await DB.table(prices).where('label', 'padded').first())!
    await DB.table(prices).upsert({ id, label: 'padded', amount: '12.30' }, ['id'], ['label'])
    await DB.table(prices).where('label', 'padded').delete()

    const snapshots = mutations.flatMap(mutation => [...mutation.rows ?? [], ...mutation.previousRows ?? []])
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.map(row => row.amount)).toEqual(snapshots.map(() => '12.30'))
  })

  it('records grouped realtime state keyed by the decimal text that queries read', async () => {
    const prices = await openPrices(driver)
    await DB.table(prices).insert([
      { label: 'first', amount: '12.30', discount: '1.00' },
      { label: 'second', amount: '12.30', discount: '3.00' },
      { label: 'third', amount: '12.34', discount: '2.00' },
    ])

    const collected = await queryCacheInternals.collectDatabaseQueryDependencies(async () => ({
      counted: await DB.table(prices).select('amount').addSelectCount('total').groupBy('amount').having('count(*)', '>', 1).get(),
      averaged: await DB.table(prices).select('amount').addSelectAvg('average', 'id').groupBy('amount').orderBy('amount').get(),
    }))

    expect(collected.value.counted).toEqual([{ amount: '12.30', total: 2 }])
    expect(collected.value.averaged.map(row => row.amount)).toEqual(['12.30', '12.34'])
    const groupKeys = collected.queries.flatMap(query => [
      ...query.groupedAggregate?.aggregateStates ?? [],
      ...query.groupedAggregate?.averageStates ?? [],
    ]).map(state => state.groupValue)
    expect(groupKeys).toEqual(expect.arrayContaining(['12.30', '12.34']))
    expect(groupKeys.every(key => typeof key === 'string')).toBe(true)
  })
})
