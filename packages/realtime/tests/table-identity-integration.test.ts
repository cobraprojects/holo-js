import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase, tableSpellings } from '../../db/tests/support/database'
import { resolveTableIdentity } from '../../db/src/query/tableIdentity'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { isQueryObservationContradictedByExactPredicates, readExactPredicateValues } from '../src/runtime/predicate-dependency-matching'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'
import type { TestDriver as Driver } from '../../../tests/support/real-database'

async function openLiveTable(driver: Driver) {
  const { db, table } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  await db.table(table.tableName).insert({ id: 1, name: 'first', active: false })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return tableSpellings(driver, table.tableName)
}

async function subscribeNames(tableName: string) {
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => (await db.table(tableName).orderBy('id').get()).map(row => row.name) })
  return subscribeRealtimeQuery(query, {}, { onData: () => undefined, onError: (error) => { throw error } })
}

function mutate(handler: Parameters<typeof defineRealtimeMutation>[0]['handler']) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)) {
  describe(`${driver} realtime table identity`, () => {
    it('refreshes an unqualified subscription after writes through the qualified spelling', async () => {
      const { bare, qualified } = await openLiveTable(driver)
      const subscription = await subscribeNames(bare)
      expect(subscription.current.data).toEqual(['first'])

      await mutate(({ db }) => db.table(qualified).insert({ id: 2, name: 'second', active: false }))
      expect(subscription.current.data).toEqual(['first', 'second'])

      await mutate(({ db }) => db.table(qualified).where('id', 1).update({ name: 'renamed' }))
      expect(subscription.current.data).toEqual(['renamed', 'second'])

      await mutate(({ db }) => db.table(qualified).where('id', 2).delete())
      expect(subscription.current.data).toEqual(['renamed'])
    })

    it('refreshes a qualified subscription after writes through the unqualified spelling', async () => {
      const { bare, qualified } = await openLiveTable(driver)
      const subscription = await subscribeNames(qualified)
      expect(subscription.current.data).toEqual(['first'])

      await mutate(({ db }) => db.table(bare).insert({ id: 2, name: 'second', active: false }))
      expect(subscription.current.data).toEqual(['first', 'second'])

      await mutate(({ db }) => db.table(bare).where('id', 1).update({ name: 'renamed' }))
      expect(subscription.current.data).toEqual(['renamed', 'second'])

      await mutate(({ db }) => db.table(bare).where('id', 2).delete())
      expect(subscription.current.data).toEqual(['renamed'])
    })
  })
}

describe('sqlite realtime predicate dependencies by table identity', () => {
  it('reads the exact predicate dependencies of a qualified subscription from its canonical table key', async () => {
    const { db, table } = await openDatabase('sqlite')
    const { bare, qualified } = tableSpellings('sqlite', table.tableName)
    await resolveTableIdentity(db, qualified)
    const exactPredicates = new Map([[`db:default:${bare}`, new Map([['id', new Set([encodeURIComponent('1')])]])]])
    const subscription = { connectionName: 'default', dependencies: [], orderBy: [], patchable: true, predicates: [{ column: 'id', operator: '=' as const, value: 2 }], tableName: qualified }

    expect(readExactPredicateValues(exactPredicates, 'default', qualified, 'id')).toEqual([1])
    expect(isQueryObservationContradictedByExactPredicates(subscription, exactPredicates)).toBe(true)
  })
})
