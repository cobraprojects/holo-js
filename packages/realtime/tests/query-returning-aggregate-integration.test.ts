import { expect, it, onTestFinished } from 'vitest'
import { openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  it(`patches native ${driver} grouped sums after value and membership updates without refreshing the handler`, async () => {
    const { db, schema, table } = await openDatabase(driver)
    onTestFinished(() => resetRealtimeRuntime())
    await schema.table(table.tableName, table => { table.integer('group_id'); table.integer('score') })
    await db.table(table.tableName).insert([
      { id: 1, name: 'First', group_id: 1, score: 10 },
      { id: 2, name: 'Second', group_id: 1, score: 20 },
      { id: 3, name: 'Third', group_id: 2, score: 30 },
    ])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let handlerRuns = 0
    const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
    const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
      handlerRuns += 1
      return db.table(table.tableName).select('group_id').addSelectSum('total', 'score').groupBy('group_id').orderBy('group_id').get()
    } })
    const subscription = await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(table.tableName).where('id', 1).update({ score: 15 }) }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(table.tableName).where('id', 2).update({ group_id: 2 }) }))
    expect(handlerRuns).toBe(1)
    expect(snapshots).toEqual([
      [{ group_id: 1, total: 30 }, { group_id: 2, total: 30 }],
      [{ group_id: 1, total: 35 }, { group_id: 2, total: 30 }],
      [{ group_id: 1, total: 15 }, { group_id: 2, total: 50 }],
    ])
    await Promise.all([21, 24].map(score => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => db.table(table.tableName).where('id', 1).update({ score }) }))))
    expect(subscription.current.data).toEqual(await db.table(table.tableName).select('group_id').addSelectSum('total', 'score').groupBy('group_id').orderBy('group_id').get())
    expect(handlerRuns).toBe(1)
  })
}
