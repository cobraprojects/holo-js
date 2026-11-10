import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

async function openOwnedPosts(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_delete_posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('author_id')
    table.string('title')
  })
  onTestFinished(() => schema.dropTable(name))
  const posts = defineGeneratedTable(name, { id: column.id(), author_id: column.integer(), title: column.string() })
  await db.table(posts).insert({ id: 1, author_id: 1, title: 'mine' })
  await db.table(posts).insert({ id: 2, author_id: 2, title: 'theirs' })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, posts }
}

describe.each(drivers)('realtime delete predicates on %s', (driver) => {
  it('re-runs a subscription exactly once when a real DELETE removes only rows outside its predicate', async () => {
    const { db, posts } = await openOwnedPosts(driver)
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

    await db.table(posts).where('id', 2).delete()

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([{ id: 1, author_id: 1, title: 'mine' }])
  })

  it('refreshes a subscription when a real DELETE removes a row inside its predicate', async () => {
    const { db, posts } = await openOwnedPosts(driver)
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

    await db.table(posts).where('id', 1).delete()

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([])
  })
})
