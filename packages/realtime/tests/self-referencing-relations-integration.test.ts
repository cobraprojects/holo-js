import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne, type ModelDefinitionLike, type TableDefinition } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, realtimeRuntimeInternals, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

type Driver = typeof drivers[number]
type Database = Awaited<ReturnType<typeof openDatabase>>['db']

async function openSelfReferencingDatabase(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsTable = `holo_live_authors_${suffix}`
  const followsTable = `holo_live_follows_${suffix}`
  await schema.createTable(authorsTable, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
    table.integer('mentor_id').nullable()
  })
  onTestFinished(() => schema.dropTable(authorsTable))
  await schema.createTable(followsTable, (table) => {
    table.integer('id').primaryKey()
    table.integer('follower_id')
    table.integer('followed_id')
  })
  onTestFinished(() => schema.dropTable(followsTable))
  await db.table(authorsTable).insert([
    { id: 1, name: 'Ada', mentor_id: null },
    { id: 2, name: 'Grace', mentor_id: 1 },
    { id: 3, name: 'Linus', mentor_id: 1 },
    { id: 4, name: 'Barbara', mentor_id: 2 },
  ])
  await db.table(followsTable).insert([
    { id: 1, follower_id: 1, followed_id: 2 },
    { id: 2, follower_id: 1, followed_id: 3 },
    { id: 3, follower_id: 2, followed_id: 4 },
  ])
  const authorColumns = { id: column.integer().primaryKey(), name: column.string(), mentor_id: column.integer().nullable() }
  const Author: ModelDefinitionLike<TableDefinition> = defineModel(defineGeneratedTable(authorsTable, authorColumns), {
    timestamps: false,
    relations: {
      mentees: hasMany(() => Author, 'mentor_id'),
      protege: hasOne(() => Author, 'mentor_id'),
      mentor: belongsTo(() => Author, 'mentor_id'),
      following: belongsToMany(() => Author, followsTable, 'follower_id', 'followed_id'),
    },
  })
  onTestFinished(() => resetRealtimeRuntime())
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, Author, authorsTable, followsTable }
}

function plain(value: unknown) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function readId(value: unknown): number {
  return value && typeof value === 'object' && 'id' in value ? Number(value.id) : 0
}

function sortedById(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedById).sort((left, right) => readId(left) - readId(right))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sortedById(entry)]))
  }

  return value
}

async function subscribe(fetch: () => Promise<unknown>, ordered = false) {
  const errors: unknown[] = []
  const read = async () => {
    const data = plain(await fetch())
    return ordered ? data : sortedById(data)
  }
  const subscription = await subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: fetch }),
    {},
    { onData: () => {}, onError: (error) => { errors.push(error) } },
  )
  const current = () => {
    expect(errors).toEqual([])
    const data = plain(subscription.current.data)
    return ordered ? data : sortedById(data)
  }
  return { current, read }
}

async function mutate(db: Database, handler: (db: Database) => Promise<unknown>) {
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => handler(db) }))
}

describe.each(drivers)('realtime self-referencing relations on %s', (driver) => {
  it.each([
    ['hasMany', 'mentees', false],
    ['hasOne', 'protege', true],
    ['belongsTo', 'mentor', false],
    ['belongsToMany', 'following', false],
  ] as const)('keeps %s subscriptions equal to a fresh read when related rows change', async (_kind, relation, needsOrder) => {
    const { db, Author, authorsTable, followsTable } = await openSelfReferencingDatabase(driver)
    const query = () => db.model(Author).query()
    const load = (builder: ReturnType<typeof query>) => needsOrder ? builder.with(relation, related => related.orderBy('id')) : builder.with(relation)
    const lives = await Promise.all([
      subscribe(() => load(query()).orderBy('id').get()),
      subscribe(() => load(query().where('id', 1)).get()),
      subscribe(() => query().whereIn('id', [1, 2]).with(relation, related => related.orderBy('id', 'desc')).orderBy('id').get(), true),
      subscribe(() => load(query().where('id', 2)).first()),
    ])
    const mutations: Array<(db: Database) => Promise<unknown>> = [
      db => db.table(authorsTable).where('id', 3).update({ name: 'Linus T' }),
      db => db.table(authorsTable).where('id', 1).update({ name: 'Ada L' }),
      db => db.table(authorsTable).where('id', 4).update({ name: 'Barbara L' }),
      db => db.table(authorsTable).insert({ id: 5, name: 'Margaret', mentor_id: 1 }),
      db => db.table(followsTable).insert({ id: 4, follower_id: 1, followed_id: 5 }),
      db => db.table(authorsTable).where('id', 3).update({ mentor_id: 2 }),
      db => db.table(authorsTable).where('id', 2).update({ name: 'Grace H' }),
      db => db.table(authorsTable).where('id', 2).delete(),
      db => db.table(authorsTable).where('id', 5).update({ name: 'Margaret H' }),
    ]

    for (const [step, apply] of mutations.entries()) {
      await mutate(db, apply)
      for (const [index, live] of lives.entries()) {
        expect({ step, index, data: live.current() }).toEqual({ step, index, data: await live.read() })
      }
    }
  })

  it('keeps a subscription that reads one table unfiltered and through different keys equal to a fresh read', async () => {
    const { db, authorsTable } = await openSelfReferencingDatabase(driver)
    const live = await subscribe(async () => ({
      all: await db.table(authorsTable).orderBy('id').get(),
      byId: await db.table(authorsTable).whereIn('id', [1, 2]).orderBy('id').get(),
      byMentor: await db.table(authorsTable).whereIn('mentor_id', [2]).orderBy('id').get(),
    }), true)
    const mutations: Array<(db: Database) => Promise<unknown>> = [
      db => db.table(authorsTable).insert({ id: 6, name: 'Hedy', mentor_id: 3 }),
      db => db.table(authorsTable).insert({ id: 7, name: 'Frances', mentor_id: 2 }),
      db => db.table(authorsTable).where('id', 6).update({ name: 'Hedy L' }),
    ]

    for (const [step, apply] of mutations.entries()) {
      await mutate(db, apply)
      expect({ step, data: live.current() }).toEqual({ step, data: await live.read() })
    }
  })

  it('refreshes on inserts after a refresh turns one of its reads of a table unfiltered', async () => {
    const { db, authorsTable } = await openSelfReferencingDatabase(driver)
    let unfiltered = false
    const live = await subscribe(async () => ({
      byId: await db.table(authorsTable).whereIn('id', [1, 2]).orderBy('id').get(),
      authors: await (unfiltered ? db.table(authorsTable) : db.table(authorsTable).whereIn('id', [1, 2])).orderBy('id').get(),
    }), true)
    unfiltered = true
    for (const subscription of realtimeRuntimeInternals.getRuntimeState().subscriptions.values()) {
      await realtimeRuntimeInternals.scheduleSubscriptionRefresh(subscription)
    }
    expect(live.current()).toEqual(await live.read())

    await mutate(db, db => db.table(authorsTable).insert({ id: 6, name: 'Hedy', mentor_id: 3 }))

    expect(live.current()).toEqual(await live.read())
  })
})
