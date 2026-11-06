import { randomUUID } from 'node:crypto'
import { belongsToMany, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openDatabase } from '../../db/tests/support/database'
import { integrationDrivers } from '../../../tests/support/real-database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Database = Awaited<ReturnType<typeof openDatabase>>['db']
type Tables = Awaited<ReturnType<typeof openPostTags>>
type Step = (db: Database, tables: Tables) => Promise<unknown>

async function openPostTags(driver: 'sqlite' | 'postgres' | 'mysql') {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const postsName = `holo_sibling_posts_${suffix}`
  const tagsName = `holo_sibling_tags_${suffix}`
  const pivotName = `holo_sibling_post_tag_${suffix}`
  await schema.createTable(postsName, (table) => {
    table.integer('id').primaryKey()
    table.string('title')
  })
  await schema.createTable(tagsName, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await schema.createTable(pivotName, (table) => {
    table.integer('id').primaryKey()
    table.integer('post_id')
    table.integer('tag_id')
  })
  onTestFinished(async () => {
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(postsName)
  })
  const posts = defineGeneratedTable(postsName, { id: column.integer().primaryKey(), title: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.integer().primaryKey(), name: column.string() })
  const postTag = defineGeneratedTable(pivotName, { id: column.integer().primaryKey(), post_id: column.integer(), tag_id: column.integer() })
  await db.table(posts).insert({ id: 10, title: 'Post' })
  await db.table(tags).insert([{ id: 1, name: 'one' }, { id: 2, name: 'two' }, { id: 3, name: 'three' }])
  await db.table(postTag).insert([{ id: 1, post_id: 10, tag_id: 1 }, { id: 2, post_id: 10, tag_id: 2 }])
  const Tag = defineModel(tags, { timestamps: false })
  const Post = defineModel(posts, { timestamps: false, relations: { tags: belongsToMany(() => Tag, postTag, 'post_id', 'tag_id') } })
  const OrderedPost = defineModel(posts, { timestamps: false, relations: { tags: belongsToMany(() => Tag, postTag, 'post_id', 'tag_id').withPivot('id').orderByPivot('id') } })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, OrderedPost, Post, postTag, tags }
}

const sequences: Record<string, readonly Step[]> = {
  'a pivot delete then a related delete': [
    (db, { postTag }) => db.table(postTag).where('post_id', 10).where('tag_id', 1).delete(),
    (db, { tags }) => db.table(tags).where('id', 2).delete(),
  ],
  'a related delete then a pivot delete': [
    (db, { tags }) => db.table(tags).where('id', 2).delete(),
    (db, { postTag }) => db.table(postTag).where('post_id', 10).where('tag_id', 1).delete(),
  ],
  'a pivot insert then a related update and a pivot delete': [
    (db, { postTag }) => db.table(postTag).insert({ id: 3, post_id: 10, tag_id: 3 }),
    (db, { tags }) => db.table(tags).where('id', 1).update({ name: 'renamed' }),
    (db, { postTag }) => db.table(postTag).where('post_id', 10).where('tag_id', 2).delete(),
  ],
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('realtime sibling observations on %s', (driver) => {
  it.each(Object.entries(sequences))('keeps an eager-loaded belongsToMany equal to a fresh read after %s', async (_, steps) => {
    const tables = await openPostTags(driver)
    const { db, Post } = tables
    const handler = () => db.model(Post).query().with('tags').orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })

    for (const [index, step] of steps.entries()) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => step(db, tables) }))
      const fresh = JSON.parse(JSON.stringify(await handler()))
      expect({ step: index, data: JSON.parse(JSON.stringify(subscription.current.data)) }).toEqual({ step: index, data: fresh })
    }
  })

  it('patches an ordered belongsToMany pivot insert and then a related update from the current result', async () => {
    const tables = await openPostTags(driver)
    const { db, OrderedPost, postTag, tags } = tables
    const read = () => db.model(OrderedPost).query().with('tags').orderBy('id').getJson()
    let subscriptionReads = 0
    const handler = () => {
      subscriptionReads += 1
      return read()
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, { onData: () => {}, onError: (error) => { throw error } })
    const steps = [
      () => db.table(postTag).insert({ id: 3, post_id: 10, tag_id: 3 }),
      () => db.table(tags).where('id', 1).update({ name: 'renamed' }),
    ]

    for (const [index, step] of steps.entries()) {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: step }))
      const fresh = JSON.parse(JSON.stringify(await read()))
      expect({ step: index, reads: subscriptionReads, data: JSON.parse(JSON.stringify(subscription.current.data)) }).toEqual({ step: index, reads: 1, data: fresh })
    }
  })
})
