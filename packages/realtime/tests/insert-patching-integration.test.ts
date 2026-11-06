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

async function openPosts(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const name = `holo_insert_posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  await schema.createTable(name, (table) => {
    table.id()
    table.string('title')
    table.integer('votes')
  })
  onTestFinished(() => schema.dropTable(name))
  const posts = defineGeneratedTable(name, { id: column.id(), title: column.string(), votes: column.integer() })
  const Post = defineModel(posts, { timestamps: false, fillable: ['title', 'votes'] })
  await db.table(posts).insert({ title: 'first', votes: 1 })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, posts, Post }
}

async function subscribeCounted(queries: Record<string, () => Promise<unknown>>) {
  const handlerRuns = Object.fromEntries(Object.keys(queries).map(key => [key, 0]))
  const errors: unknown[] = []
  const subscriptions = await Promise.all(Object.entries(queries).map(([key, handler]) => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: () => {
      handlerRuns[key]! += 1
      return handler()
    } }),
    {},
    { onData: () => {}, onError: (error) => { errors.push(error) } },
  )))
  const expectPatched = async (step: string, runs = 1) => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    expect({ step, errors }).toEqual({ step, errors: [] })
    expect({ step, data: subscriptions.map(subscription => subscription.current.data) }).toEqual({ step, data: fresh })
    expect({ step, handlerRuns }).toEqual({ step, handlerRuns: Object.fromEntries(Object.keys(queries).map(key => [key, runs])) })
  }
  return { subscriptions, expectPatched }
}

describe.each(drivers)('realtime inserts on %s', (driver) => {
  it('patches a row and a list subscription on a simple table in one read', async () => {
    const { db, posts } = await openPosts(driver)
    const { subscriptions, expectPatched } = await subscribeCounted({
      row: () => db.table(posts).orderBy('id', 'desc').first(),
      list: () => db.table(posts).orderBy('id').get(),
    })

    await mutate(() => db.table(posts).insert({ title: 'second', votes: 2 }))
    await expectPatched('generated key')
    await mutate(() => db.table(posts).insert({ id: 3, title: 'third', votes: 3 }))
    await expectPatched('explicit key')
    expect(subscriptions.map(subscription => subscription.current.data)).toEqual([
      { id: 3, title: 'third', votes: 3 },
      [{ id: 1, title: 'first', votes: 1 }, { id: 2, title: 'second', votes: 2 }, { id: 3, title: 'third', votes: 3 }],
    ])
  })

  it('patches table and model subscriptions after model creates and multi-row inserts, re-running only for keyless MySQL multi-row inserts', async () => {
    const { db, posts, Post } = await openPosts(driver)
    const { expectPatched } = await subscribeCounted({
      table: () => db.table(posts).select('id', 'title').orderBy('id').get(),
      models: () => db.model(Post).query().orderBy('id').getJson(),
    })

    await mutate(() => db.model(Post).create({ title: 'created', votes: 2 }))
    await expectPatched('create')
    await mutate(() => db.table(posts).insert([{ title: 'third', votes: 3 }, { title: 'fourth', votes: 4 }]))
    const runs = driver === 'mysql' ? 2 : 1
    await expectPatched('multi-row insert', runs)
  })

  it('keeps subscriptions equal to fresh queries after insertOrIgnore skips a row, re-running on MySQL', async () => {
    const { db, posts, Post } = await openPosts(driver)
    const { expectPatched } = await subscribeCounted({
      table: () => db.table(posts).select('id', 'title').orderBy('id').get(),
      models: () => db.model(Post).query().orderBy('id').getJson(),
    })

    await mutate(() => db.table(posts).insertOrIgnore([{ id: 1, title: 'ignored', votes: 9 }, { id: 2, title: 'second', votes: 2 }]))
    await expectPatched('insertOrIgnore', driver === 'mysql' ? 2 : 1)
  })
})
