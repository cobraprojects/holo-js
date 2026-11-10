import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

async function openItems(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_subquery_items_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('owner')
    table.string('label')
  })
  onTestFinished(() => schema.dropTable(name))
  const items = defineGeneratedTable(name, { id: column.id(), owner: column.integer(), label: column.string() })
  await db.table(items).insert({ id: 1, owner: 1, label: 'one' })
  await db.table(items).insert({ id: 2, owner: 2, label: 'two' })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, items }
}

type Row = Readonly<Record<string, unknown>>

describe.each(drivers)('realtime subquery predicates on %s', (driver) => {
  it('refreshes a subscription with whereExists when a delete removes the row the subquery reads', async () => {
    const { db, items } = await openItems(driver)
    let handlerRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        handlerRuns += 1
        return await context.table(items)
          .where('owner', 1)
          .whereExists(context.table(items).select('id').where('owner', 2))
          .get()
      },
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = snapshot.data },
    })
    expect(latest).toEqual([{ id: 1, owner: 1, label: 'one' }])

    await db.table(items).where('id', 2).delete()

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([])
  })

  it('refreshes a subscription whose nested group holds a subquery when a delete removes the row it reads', async () => {
    const { db, items } = await openItems(driver)
    let handlerRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        handlerRuns += 1
        return await context.table(items)
          .where(group => group
            .where('owner', 1)
            .whereExists(context.table(items).select('id').where('owner', 2)))
          .get()
      },
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = snapshot.data },
    })
    expect(latest).toEqual([{ id: 1, owner: 1, label: 'one' }])

    await db.table(items).where('id', 2).delete()

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([])
  })

  it('refreshes a subscription whose selected subquery reads a row outside its predicate', async () => {
    const { db, items } = await openItems(driver)
    let handlerRuns = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        handlerRuns += 1
        return await context.table(items)
          .select('id')
          .where('owner', 1)
          .addSelectSub(context.table(items).select('label').where('owner', 2), 'other')
          .get()
      },
    })
    let latest: unknown
    await subscribeRealtimeQuery(query, {}, {
      onData: (snapshot: { readonly data: unknown }) => { latest = snapshot.data as readonly Row[] },
    })
    expect(latest).toEqual([{ id: 1, other: 'two' }])

    await db.table(items).where('id', 2).update({ label: 'deux' })

    expect(handlerRuns).toBe(2)
    expect(latest).toEqual([{ id: 1, other: 'deux' }])
  })
})
