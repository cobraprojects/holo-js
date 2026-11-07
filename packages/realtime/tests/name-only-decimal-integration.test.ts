import { randomUUID } from 'node:crypto'
import { clearGeneratedTables, column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

describe.each(drivers)('name-only realtime decimal reads on %s', driver => {
  it('patches generated-schema decimal rows without running the handler again', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_live_prices_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.decimal('amount', 10, 4)
    })
    onTestFinished(() => schema.dropTable(name))
    onTestFinished(() => {
      resetRealtimeRuntime()
      clearGeneratedTables()
    })
    const prices = defineGeneratedTable(name, { id: column.integer().primaryKey(), amount: column.decimal(undefined, 10, 4) })
    registerGeneratedTables({ prices })
    await db.table(prices).insert({ id: 1, amount: '12.3000' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let runs = 0
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      runs += 1
      return db.table(name).select('id', 'amount').orderBy('id').get()
    } }), {}, { onData: () => {}, onError: error => { throw error } })
    onTestFinished(() => subscription.unsubscribe())
    expect(subscription.current.data).toEqual([{ id: 1, amount: '12.3000' }])

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).insert({ id: 2, amount: '8.2500' }) }))
    expect(subscription.current.data).toEqual([{ id: 1, amount: '12.3000' }, { id: 2, amount: '8.2500' }])
    expect(runs).toBe(1)
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).where('id', 1).update({ amount: '9.5000' }) }))
    expect(subscription.current.data).toEqual(await db.table(prices).select('id', 'amount').orderBy('id').get())
    expect(subscription.current.data).toEqual([{ id: 1, amount: '9.5000' }, { id: 2, amount: '8.2500' }])
    expect(runs).toBe(1)
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(name).where('id', 2).delete() }))
    expect(subscription.current.data).toEqual([{ id: 1, amount: '9.5000' }])
    expect(runs).toBe(1)
  })
})
