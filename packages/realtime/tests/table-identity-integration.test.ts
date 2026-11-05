import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, mysqlTestConnection, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Driver = 'sqlite' | 'postgres' | 'mysql'

function tableSpellings(driver: Driver, tableName: string) {
  const bare = tableName.split('.').at(-1)!
  const schema = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database
  return { bare, qualified: `${schema}.${bare}` }
}

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
