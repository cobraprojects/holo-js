import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

async function openPrices(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_live_prices_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('group_id')
    table.decimal('amount')
  })
  onTestFinished(() => schema.dropTable(name))
  const prices = defineGeneratedTable(name, { id: column.id(), group_id: column.integer(), amount: column.decimal() })
  await db.table(prices).insert([
    { id: 1, group_id: 1, amount: '12.30' },
    { id: 2, group_id: 2, amount: '12.34' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, prices, schema }
}

describe.each(drivers)('realtime decimal columns on %s', (driver) => {
  it('keeps grouped and aggregate subscriptions over a decimal column correct after inserts and updates', async () => {
    const { db, prices } = await openPrices(driver)
    const queries = {
      groupedByAmount: () => db.table(prices).select('amount').addSelectCount('total').groupBy('amount').orderBy('amount').get(),
      havingByAmount: () => db.table(prices).select('amount').addSelectCount('total').groupBy('amount').having('count(*)', '>', 1).orderBy('amount').get(),
      summedByGroup: () => db.table(prices).select('group_id').addSelectSum('total', 'amount').groupBy('group_id').orderBy('group_id').get(),
      maxByGroup: () => db.table(prices).select('group_id').addSelectMax('highest', 'amount').groupBy('group_id').orderBy('group_id').get(),
      rows: () => db.table(prices).select('id', 'amount').orderBy('id').get(),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).insert({ id: 3, group_id: 1, amount: '12.30' }) }))
    await expectCurrent()
    expect(subscriptions[1]!.current.data).toEqual([{ amount: '12.30', total: 2 }])
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).where('id', 2).update({ amount: '12.30' }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).where('id', 1).update({ amount: '9.50', group_id: 2 }) }))
    await expectCurrent()
    expect(subscriptions[4]!.current.data).toEqual([{ id: 1, amount: '9.50' }, { id: 2, amount: '12.30' }, { id: 3, amount: '12.30' }])
  })

  it('keeps patching subscriptions that read no decimal column', async () => {
    const { db, prices } = await openPrices(driver)
    let handlerRuns = 0
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      handlerRuns += 1
      return db.table(prices).select('group_id').addSelectCount('total').groupBy('group_id').orderBy('group_id').get()
    } }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).insert({ id: 3, group_id: 1, amount: '1.00' }) }))

    expect(subscription.current.data).toEqual([{ group_id: 1, total: 2 }, { group_id: 2, total: 1 }])
    expect(handlerRuns).toBe(1)
  })

  it('keeps eager-loaded decimal relations correct after a related insert', async () => {
    const { db, prices, schema } = await openPrices(driver)
    const groupsName = `holo_live_groups_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
    })
    onTestFinished(() => schema.dropTable(groupsName))
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
    await db.table(groups).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
    const Price = defineModel(prices, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { prices: hasMany(() => Price, 'group_id') } })
    const handler = () => db.model(Group).query().with({ prices: query => query.orderBy('id') }).orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).insert({ id: 3, group_id: 1, amount: '9.50' }) }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"9.50"')
  })

  it('keeps decimal pivot attributes correct after a pivot update', async () => {
    const { db, schema } = await openPrices(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const groupsName = `holo_pivot_groups_${suffix}`
    const tagsName = `holo_pivot_tags_${suffix}`
    const pivotName = `holo_pivot_rates_${suffix}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(tagsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(pivotName, (table) => {
      table.id()
      table.integer('group_id')
      table.integer('tag_id')
      table.decimal('rate')
    })
    onTestFinished(async () => {
      await schema.dropTable(pivotName)
      await schema.dropTable(tagsName)
      await schema.dropTable(groupsName)
    })
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
    const tags = defineGeneratedTable(tagsName, { id: column.id(), name: column.string() })
    const rates = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.integer(), tag_id: column.integer(), rate: column.decimal() })
    await db.table(groups).insert({ id: 1, name: 'first' })
    await db.table(tags).insert({ id: 1, name: 'sale' })
    await db.table(rates).insert({ id: 1, group_id: 1, tag_id: 1, rate: '12.30' })
    const Tag = defineModel(tags, { timestamps: false })
    const Rate = defineModel(rates, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { tags: belongsToMany(() => Tag, rates, 'group_id', 'tag_id').withPivot('rate').using(() => Rate) } })
    const handler = () => db.model(Group).query().with('tags').orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(rates).where('id', 1).update({ rate: '2.50' }) }))

    const fresh = JSON.stringify(await handler())
    const current = JSON.stringify(subscription.current.data)
    expect({ current, fresh }).toEqual({ current: fresh, fresh })
    expect(current).toContain('"2.50"')
  })

  it.runIf(driver === 'sqlite')('keeps belongs-to decimal relations correct after a parent insert and a related update', async () => {
    const { db, prices, schema } = await openPrices(driver)
    const ordersName = `holo_live_orders_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(ordersName, (table) => {
      table.id()
      table.integer('price_id')
    })
    onTestFinished(() => schema.dropTable(ordersName))
    const orders = defineGeneratedTable(ordersName, { id: column.id(), price_id: column.integer() })
    await db.table(orders).insert({ id: 1, price_id: 1 })
    const Price = defineModel(prices, { timestamps: false })
    const Order = defineModel(orders, { timestamps: false, relations: { price: belongsTo(() => Price, 'price_id') } })
    const handler = () => db.model(Order).query().with('price').orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(orders).insert({ id: 2, price_id: 1 }) }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(prices).where('id', 1).update({ amount: '9.5' }) }))

    const current = JSON.stringify(subscription.current.data)
    expect(current).toBe(JSON.stringify(await handler()))
    expect(current).toContain('"9.50"')
  })

  it('keeps decimal pivot model attributes correct when the pivot table is given by name', async () => {
    const { db, schema } = await openPrices(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const groupsName = `holo_named_groups_${suffix}`
    const tagsName = `holo_named_tags_${suffix}`
    const pivotName = `holo_named_rates_${suffix}`
    await schema.createTable(groupsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(tagsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(pivotName, (table) => {
      table.id()
      table.integer('group_id')
      table.integer('tag_id')
      table.decimal('rate')
    })
    onTestFinished(async () => {
      await schema.dropTable(pivotName)
      await schema.dropTable(tagsName)
      await schema.dropTable(groupsName)
    })
    const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
    const tags = defineGeneratedTable(tagsName, { id: column.id(), name: column.string() })
    const rates = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.integer(), tag_id: column.integer(), rate: column.decimal() })
    await db.table(groups).insert({ id: 1, name: 'first' })
    await db.table(tags).insert({ id: 1, name: 'sale' })
    await db.table(rates).insert({ id: 1, group_id: 1, tag_id: 1, rate: '12.30' })
    const Tag = defineModel(tags, { timestamps: false })
    const Rate = defineModel(rates, { timestamps: false })
    const Group = defineModel(groups, { timestamps: false, relations: { tags: belongsToMany(() => Tag, pivotName, 'group_id', 'tag_id').withPivot('rate').using(() => Rate) } })
    const handler = () => db.model(Group).query().with('tags').orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(rates).where('id', 1).update({ rate: '2.50' }) }))

    const current = JSON.stringify(subscription.current.data)
    expect(current).toBe(JSON.stringify(await handler()))
    expect(current).toContain('"2.50"')
  })
})
