import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

async function openItems(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const items = defineGeneratedTable(`items_${suffix}`, { id: column.integer().primaryKey(), owner: column.integer() })
  const authors = defineGeneratedTable(`authors_${suffix}`, { id: column.integer().primaryKey() })
  await schema.createTable(items.tableName, table => {
    table.integer('id').primaryKey()
    table.integer('owner')
  })
  await schema.createTable(authors.tableName, table => { table.integer('id').primaryKey() })
  onTestFinished(async () => {
    await schema.dropTable(items.tableName)
    await schema.dropTable(authors.tableName)
  })
  await db.table(authors).insert({ id: 1 })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, items, authors }
}

async function observe(handler: () => Promise<unknown>) {
  return subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
    onData: () => {},
    onError: (error) => { throw error },
  })
}

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

describe.each(drivers)('inserts beyond source predicates on %s', (driver) => {
  it('refreshes posts joined to authors where authors.id = 1 after inserting post id 2 with author_id 1', async () => {
    const { db, items: posts, authors } = await openItems(driver)
    await db.executeCompiled({ sql: `ALTER TABLE ${db.getDialect().quoteIdentifier(posts.tableName)} RENAME COLUMN owner TO author_id`, source: 'schema' })
    const handler = () => db.table(`${posts.tableName} as posts`)
      .join(`${authors.tableName} as authors`, 'posts.author_id', '=', 'authors.id')
      .where('authors.id', 1)
      .select('posts.id', 'posts.author_id').get()
    const subscription = await observe(handler)
    expect(subscription.current.data).toEqual([])

    await mutate(() => db.table(posts.tableName).insert({ id: 2, author_id: 1 }))

    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toEqual([{ id: 2, author_id: 1 }])
  })

  it.each(['exists', 'nested exists', 'union', 'having', 'raw predicate', 'raw selection', 'raw order', 'subquery selection', 'subquery predicate'] as const)('refreshes a %s reading beyond owner 1 after inserting owner 2', async (shape) => {
    const { db, items } = await openItems(driver)
    await db.table(items).insert({ id: 1, owner: 1 })
    const outer = () => db.table(items).where('owner', 1)
    const other = () => db.table(items).select('id').where('owner', 2)
    const quote = db.getDialect().quoteIdentifier
    const exists = `EXISTS (SELECT id FROM ${quote(items.tableName)} WHERE owner = 2)`
    let runs = 0
    const handler = () => {
      runs += 1
      switch (shape) {
        case 'exists': return outer().whereExists(other()).get()
        case 'nested exists': return db.table(items).where(group => group.where('owner', 1).where(nested => nested.whereExists(other()))).get()
        case 'union': return outer().union(db.table(items).where('owner', 2)).orderBy('id').get()
        case 'having': return outer().select('owner').groupBy('owner').having('count(*)', '>', 0).get()
        case 'raw predicate': return outer().unsafeWhere(exists, []).get()
        case 'raw selection': return outer().select('id').addUnsafeSelect(`(SELECT COUNT(*) FROM ${quote(items.tableName)}) AS total`, []).get()
        case 'raw order': return outer().select('id').unsafeOrderBy(`(SELECT COUNT(*) FROM ${quote(items.tableName)})`, []).get()
        case 'subquery selection': return outer().select('id').addSelectSub(other(), 'other').get()
        case 'subquery predicate': return outer().whereSub('id', '<', other()).get()
      }
    }
    const subscription = await observe(handler)
    const initial = subscription.current.data

    await mutate(() => db.table(items).insert({ id: 2, owner: 2 }))

    expect(runs).toBe(2)
    expect(subscription.current.data).toEqual(await handler())
    if (shape !== 'raw order' && shape !== 'having') expect(subscription.current.data).not.toEqual(initial)
  })

  it('skips a contradicted plain single-table insert without running its handler', async () => {
    const { db, items } = await openItems(driver)
    let runs = 0
    const handler = async () => {
      runs += 1
      return db.table(items).where('owner', 1).get()
    }
    const subscription = await observe(handler)

    await mutate(() => db.table(items).insert({ id: 2, owner: 2 }))

    expect(runs).toBe(1)
    expect(subscription.current.data).toEqual([])
  })
})
