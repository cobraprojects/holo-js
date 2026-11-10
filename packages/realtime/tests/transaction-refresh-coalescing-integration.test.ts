import { column, configureDatabaseQueryCacheBridge, defineGeneratedTable, resetDatabaseQueryCacheBridge, type DatabaseQueryCacheBridge } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openDatabase } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const evictionLatencyMilliseconds = 30

function createSlowEvictionBridge(): DatabaseQueryCacheBridge {
  return {
    async get() { return null },
    async put() {},
    async flexible(_key, _ttl, callback) { return await callback() },
    async forget() { return false },
    async invalidateDependencies() {
      await new Promise<void>((resolve) => { setTimeout(resolve, evictionLatencyMilliseconds) })
    },
  }
}

describe('transaction refresh coalescing with a slow cache bridge', () => {
  it('refreshes a subscription once for two writes in one transaction when eviction is slow', async () => {
    const { db, schema } = await openDatabase('sqlite')
    onTestFinished(() => {
      resetRealtimeRuntime()
      resetDatabaseQueryCacheBridge()
    })
    await schema.createTable('posts', (table) => {
      table.id()
      table.integer('author_id')
      table.string('title')
    })
    const posts = defineGeneratedTable('posts', { id: column.id(), author_id: column.integer(), title: column.string() })
    await db.table(posts).insert({ id: 1, author_id: 1, title: 'one' })
    await db.table(posts).insert({ id: 2, author_id: 1, title: 'two' })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    configureDatabaseQueryCacheBridge(createSlowEvictionBridge())

    let handlerRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        handlerRuns += 1
        return await context.table(posts).where('author_id', 1).orderBy('id').get()
      },
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = snapshot.data },
    })
    expect(handlerRuns).toBe(1)

    await db.transaction(async (transaction) => {
      await transaction.table(posts).where('id', 1).update({ title: 'one updated' })
      await transaction.table(posts).where('id', 2).update({ title: 'two updated' })
    })

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([{ id: 1, author_id: 1, title: 'one updated' }, { id: 2, author_id: 1, title: 'two updated' }])
  })
})
