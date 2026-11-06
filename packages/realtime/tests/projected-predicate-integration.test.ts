import { randomUUID } from 'node:crypto'
import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Rows = Record<string, unknown>[]

async function openItems(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_projected_items_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('n')
    table.string('label')
    table.decimal('amount')
  })
  onTestFinished(() => schema.dropTable(name))
  const items = defineGeneratedTable(name, { id: column.id(), n: column.integer(), label: column.string(), amount: column.decimal() })
  await db.table(items).insert([
    { id: 1, n: 0, label: 'first', amount: '1.50' },
    { id: 2, n: 1, label: 'second', amount: '2.50' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, items, name }
}

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function subscribeAll(queries: Record<string, () => Promise<unknown>>) {
  const names = Object.keys(queries)
  const subscriptions = Object.fromEntries(await Promise.all(names.map(async name => [name, await subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: queries[name]! }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )] as const)))
  const current = (name: string) => subscriptions[name]!.current.data as Rows
  const expectCurrent = async () => {
    for (const name of names) {
      const fresh = await queries[name]!() as Rows
      expect({ name, rows: current(name) }).toEqual({ name, rows: name.endsWith('Unordered') ? expect.arrayContaining(fresh) : fresh })
      expect(current(name)).toHaveLength(fresh.length)
    }
  }
  const ids = (name: string) => current(name).map(row => Number(row.id)).sort()
  return { current, expectCurrent, ids }
}

describe.each(drivers)('realtime projected queries filtered on an unselected column on %s', (driver) => {
  it('drops a row an update stops matching and picks up a row an update starts matching', async () => {
    const { db, items, name } = await openItems(driver)
    const { current, expectCurrent, ids } = await subscribeAll({
      idsUnordered: () => db.table(items).select('id').where('n', 0).get(),
      labels: () => db.table(items).select('label').where('n', 0).orderBy('label').get(),
      ordered: () => db.table(items).select('id', 'label').where('n', 0).orderBy('id').get(),
      limited: () => db.table(items).select('id').where('n', 0).orderBy('id').limit(5).get(),
      namedUnordered: () => db.table(name).select('id').where('n', 0).get(),
      namedOrdered: () => db.table(name).select('id', 'amount').where('n', 0).orderBy('id').get(),
    })
    expect(ids('idsUnordered')).toEqual([1])

    await mutate(() => db.table(items).where('id', 1).update({ n: 1 }))
    await expectCurrent()
    expect(ids('idsUnordered')).toEqual([])
    expect(ids('namedUnordered')).toEqual([])

    await mutate(() => db.table(name).where('id', 2).update({ n: 0 }))
    await expectCurrent()
    expect(ids('idsUnordered')).toEqual([2])
    expect(ids('namedUnordered')).toEqual([2])

    await mutate(() => db.table(items).where('label', 'first').update({ n: 0 }))
    await expectCurrent()
    expect(ids('ordered')).toEqual([1, 2])
    expect(ids('namedOrdered')).toEqual([1, 2])
    expect(current('labels')).toEqual([{ label: 'first' }, { label: 'second' }])

    await mutate(() => db.table(name).where('n', 0).update({ n: 2 }))
    await expectCurrent()
    expect(ids('idsUnordered')).toEqual([])
    expect(ids('limited')).toEqual([])
  })

  it('keeps subscriptions through a table name and a table definition equal to a fresh query after writes through either', async () => {
    const { db, items, name } = await openItems(driver)
    const { expectCurrent } = await subscribeAll({
      definitionRows: () => db.table(items).orderBy('id').get(),
      namedRows: () => db.table(name).orderBy('id').get(),
      definitionProjected: () => db.table(items).select('id', 'amount').where('n', 0).orderBy('id').get(),
      namedProjected: () => db.table(name).select('id', 'amount').where('n', 0).orderBy('id').get(),
    })

    await mutate(() => db.table(items).insert({ id: 3, n: 0, label: 'third', amount: '3.25' }))
    await expectCurrent()
    await mutate(() => db.table(name).insert({ id: 4, n: 0, label: 'fourth', amount: '4.75' }))
    await expectCurrent()
    await mutate(() => db.table(items).where('id', 3).update({ amount: '9.50' }))
    await expectCurrent()
    await mutate(() => db.table(items).where('id', 4).update({ n: 1, amount: '8.25' }))
    await expectCurrent()
    await mutate(() => db.table(items).where('id', 1).delete())
    await expectCurrent()
    await mutate(() => db.table(name).where('label', 'second').delete())
    await expectCurrent()
  })

  it('refills a limited projected window from the same column form after a row stops matching', async () => {
    const { db, items } = await openItems(driver)
    await db.table(items).where('id', 2).update({ n: 0 })
    const { expectCurrent, ids } = await subscribeAll({
      firstMatching: () => db.table(items).select('id').where('n', 0).orderBy('id').limit(1).get(),
      firstLabel: () => db.table(items).select('id', 'label').where('n', 0).orderBy('label').limit(1).get(),
    })
    expect(ids('firstMatching')).toEqual([1])

    await mutate(() => db.table(items).where('id', 1).update({ n: 1 }))
    await expectCurrent()
    expect(ids('firstMatching')).toEqual([2])
  })

  it('keeps belongs-to relations hydrated after a bulk update points rows at different owners', async () => {
    const { db, schema } = await openDatabase(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const authorsName = `holo_projected_authors_${suffix}`
    const postsName = `holo_projected_posts_${suffix}`
    await schema.createTable(authorsName, (table) => {
      table.id()
      table.string('name')
    })
    await schema.createTable(postsName, (table) => {
      table.id()
      table.foreignId('author_id')
      table.integer('n')
    })
    onTestFinished(async () => {
      await schema.dropTable(postsName)
      await schema.dropTable(authorsName)
    })
    const authors = defineGeneratedTable(authorsName, { id: column.id(), name: column.string() })
    const posts = defineGeneratedTable(postsName, { id: column.id(), author_id: column.foreignId(), n: column.integer() })
    await db.table(authors).insert([{ id: 1, name: 'ada' }, { id: 2, name: 'bob' }, { id: 3, name: 'cy' }])
    await db.table(posts).insert([{ id: 1, author_id: 1, n: 0 }, { id: 2, author_id: 1, n: 0 }])
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    const Author = defineModel(authors, { timestamps: false })
    const Post = defineModel(posts, { timestamps: false, relations: { author: belongsTo(() => Author, 'author_id') } })
    const { expectCurrent } = await subscribeAll({
      posts: () => db.model(Post).query().with('author').where('n', 0).orderBy('id').getJson(),
    })

    await mutate(async () => {
      await db.table(posts).where('id', 1).update({ author_id: 2 })
      await db.table(posts).where('id', 2).update({ author_id: 3 })
    })
    await expectCurrent()
  })
})
