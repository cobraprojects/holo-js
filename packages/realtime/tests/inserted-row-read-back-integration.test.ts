import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

type QueryName = 'rows' | 'first' | 'count' | 'models'

async function openFixture(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_read_back_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('email').unique()
    table.string('name')
    table.string('note').nullable()
    table.integer('score').default(5)
  })
  onTestFinished(() => schema.dropTable(name))
  const members = defineGeneratedTable(name, {
    id: column.id(),
    email: column.string().unique(),
    name: column.string(),
    note: column.string().nullable(),
    score: column.integer().default(5),
  })
  await db.table(members).insert({ email: 'first@example.com', name: 'first', note: 'kept', score: 1 })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Member = defineModel(members, { timestamps: false, fillable: ['email', 'name', 'note', 'score'] })
  const queries: Record<QueryName, () => Promise<unknown>> = {
    rows: () => db.table(members).orderBy('id').get(),
    first: () => db.table(members).where('id', 1).first(),
    count: () => db.table(members).count(),
    models: () => db.model(Member).query().orderBy('id').getJson(),
  }
  const names = Object.keys(queries) as QueryName[]
  const errors: unknown[] = []
  const reads = { rows: 0, first: 0, count: 0, models: 0 }
  const subscriptions = {} as Record<QueryName, Awaited<ReturnType<typeof subscribeRealtimeQuery>>>
  for (const key of names) {
    subscriptions[key] = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: (): Promise<unknown> => {
        reads[key] += 1
        return queries[key]()
      } }),
      {},
      { onData: () => {}, onError: (error) => { errors.push(error) } },
    )
  }
  const expectFresh = async () => {
    const fresh = Object.fromEntries(await Promise.all(names.map(async key => [key, await queries[key]()] as const)))
    expect({ errors, data: Object.fromEntries(names.map(key => [key, subscriptions[key].current.data])) }).toEqual({ errors: [], data: fresh })
  }
  return { db, members, Member, subscriptions, reads, expectFresh }
}

describe.each(drivers)('realtime inserts read back the stored rows on %s', (driver) => {
  it('leaves subscriptions equal to a fresh query when insertOrIgnore conflicts with an existing row', async () => {
    const { db, members, subscriptions, expectFresh } = await openFixture(driver)

    await mutate(() => db.table(members).insertOrIgnore([
      { id: 1, email: 'ignored@example.com', name: 'ignored', note: 'ignored', score: 9 },
      { id: 20, email: 'second@example.com', name: 'second', note: 'new', score: 2 },
    ]))
    await expectFresh()
    await mutate(() => db.table(members).insertOrIgnore({ id: 30, email: 'first@example.com', name: 'duplicate', note: null, score: 3 }))
    await expectFresh()
    await mutate(() => db.table(members).insertOrIgnore([
      { email: 'second@example.com', name: 'duplicate', score: 4 },
      { email: 'fourth@example.com', name: 'fourth', score: 4 },
    ]))
    await expectFresh()

    expect(subscriptions.first.current.data).toEqual({ id: 1, email: 'first@example.com', name: 'first', note: 'kept', score: 1 })
  })

  it('patches a created model with the nulls and defaults the database fills in', async () => {
    const { db, Member, subscriptions, reads, expectFresh } = await openFixture(driver)

    await mutate(() => db.model(Member).create({ email: 'created@example.com', name: 'created' }))
    await expectFresh()
    await mutate(() => db.model(Member).create({ email: 'scored@example.com', name: 'scored', score: 8 }))
    await expectFresh()

    expect(subscriptions.rows.current.data).toEqual([
      { id: 1, email: 'first@example.com', name: 'first', note: 'kept', score: 1 },
      { id: 2, email: 'created@example.com', name: 'created', note: null, score: 5 },
      { id: 3, email: 'scored@example.com', name: 'scored', note: null, score: 8 },
    ])
    if (driver !== 'sqlite') expect(reads.rows).toBe(1)
  })

  it('patches table inserts that leave columns unset with the stored rows', async () => {
    const { db, members, expectFresh } = await openFixture(driver)

    await mutate(() => db.table(members).insert({ email: 'single@example.com', name: 'single' }))
    await expectFresh()
    await mutate(() => db.table(members).insert([
      { id: 10, email: 'ten@example.com', name: 'ten', score: 6 },
      { id: 11, email: 'eleven@example.com', name: 'eleven', score: 7 },
    ]))
    await expectFresh()
    await mutate(() => db.table(members).insert([
      { email: 'auto-a@example.com', name: 'auto a' },
      { email: 'auto-b@example.com', name: 'auto b' },
    ]))
    await expectFresh()
  })

  it('patches upserts that update or insert rows by a unique column with the stored rows', async () => {
    const { db, members, expectFresh } = await openFixture(driver)

    await mutate(() => db.table(members).upsert({ email: 'first@example.com', name: 'renamed', score: 9 }, ['email'], ['name']))
    await expectFresh()
    await mutate(() => db.table(members).upsert({ email: 'upserted@example.com', name: 'upserted', score: 9 }, ['email'], ['name']))
    await expectFresh()
    await mutate(() => db.table(members).upsert({ id: 1, email: 'first@example.com', name: 'keyed', score: 9 }, ['id'], ['name']))
    await expectFresh()
  })
})
