import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
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
  return { db, prices }
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
})
