import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Driver = typeof drivers[number]

async function openScores(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_live_scores_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('group_id')
    table.integer('points')
    table.decimal('amount')
    table.decimal('bonus').nullable()
  })
  onTestFinished(() => schema.dropTable(name))
  const scores = defineGeneratedTable(name, { id: column.id(), group_id: column.integer(), points: column.integer(), amount: column.decimal(), bonus: column.decimal().nullable() })
  await db.table(scores).insert([
    { id: 1, group_id: 1, points: 1, amount: '1.00' },
    { id: 2, group_id: 1, points: 2, amount: '2.00' },
    { id: 3, group_id: 2, points: 5, amount: '5.00' },
    { id: 5, group_id: 2, points: 3, amount: '3.01' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, scores }
}

describe.each(drivers)('realtime averages on %s', (driver) => {
  it.each(['points', 'amount'] as const)('keeps grouped and plain averages over the %s column equal to a fresh query', async (averaged) => {
    const { db, scores } = await openScores(driver)
    const queries: Record<string, () => Promise<unknown>> = {
      grouped: () => db.table(scores).select('group_id').addSelectAvg('average', averaged).groupBy('group_id').orderBy('group_id').get(),
      selected: () => db.table(scores).selectAvg('average', averaged).get(),
      filtered: () => db.table(scores).where('group_id', 1).selectAvg('average', averaged).get(),
      plain: () => db.table(scores).avg(averaged),
    }
    const subscriptions = await Promise.all(Object.values(queries).map(handler => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))
    const expectCurrent = async () => {
      const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
      expect(Object.fromEntries(Object.keys(queries).map((key, index) => [key, subscriptions[index]!.current.data])))
        .toEqual(Object.fromEntries(Object.keys(queries).map((key, index) => [key, fresh[index]])))
    }
    const mutate = (handler: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))

    await expectCurrent()
    await mutate(() => db.table(scores).insert({ id: 4, group_id: 1, points: 4, amount: '4.01' }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 3).update({ points: 8, amount: '7.33' }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 2).update({ group_id: 2 }))
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 1).delete())
    await expectCurrent()
    await mutate(() => db.table(scores).where('id', 4).delete())
    await expectCurrent()
  })
  it('keeps a plain average over a nullable column equal to a fresh query', async () => {
    const { db, scores } = await openScores(driver)
    const handler = () => db.table(scores).avg('bonus')
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const mutate = (mutation: () => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: mutation }))

    await mutate(() => db.table(scores).where('id', 1).update({ bonus: '1.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 2).update({ bonus: '2.01' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).insert({ id: 6, group_id: 1, points: 1, amount: '1.00', bonus: '4.00' }))
    expect(subscription.current.data).toEqual(await handler())
    await mutate(() => db.table(scores).where('id', 6).delete())
    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toBeCloseTo(1.505)
  })
})
