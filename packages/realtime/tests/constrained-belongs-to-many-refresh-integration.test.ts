import { randomUUID } from 'node:crypto'
import { belongsToMany, column, defineGeneratedTable, defineModel, scopeRelation, type ModelDefinitionLike } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

async function openBlog(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    posts: `holo_cbtm_posts_${suffix}`,
    tags: `holo_cbtm_tags_${suffix}`,
    postTags: `holo_cbtm_post_tags_${suffix}`,
  }
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  const create = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    created.push(name)
  }
  await create(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.string('title')
  })
  await create(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('label')
    table.integer('active')
  })
  await create(names.postTags, (table) => {
    table.integer('post_id')
    table.integer('tag_id')
  })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), title: column.string() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), label: column.string(), active: column.integer() })
  const postTags = defineGeneratedTable(names.postTags, { post_id: column.integer(), tag_id: column.integer() })
  await db.table(posts).insert([{ id: 10, title: 'Engines' }, { id: 20, title: 'Compilers' }])
  await db.table(tags).insert([{ id: 1, label: 'math', active: 1 }, { id: 2, label: 'code', active: 0 }, { id: 3, label: 'radio', active: 1 }])
  await db.table(postTags).insert([{ post_id: 10, tag_id: 1 }, { post_id: 10, tag_id: 2 }, { post_id: 20, tag_id: 3 }])

  const Tag = defineModel(tags, { timestamps: false })
  const Post = defineModel(posts, {
    timestamps: false,
    relations: {
      tags: belongsToMany((): ModelDefinitionLike => Tag, names.postTags, 'post_id', 'tag_id'),
      allTags: belongsToMany((): ModelDefinitionLike => Tag, names.postTags, 'post_id', 'tag_id'),
      activeTags: scopeRelation(belongsToMany((): ModelDefinitionLike => Tag, names.postTags, 'post_id', 'tag_id'), query => query.where('active', 1).orderBy('id')),
    },
  })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, posts, tags, postTags, Post }
}

async function subscribeAll(reads: Record<string, () => Promise<unknown>>) {
  const current: Record<string, () => unknown> = {}
  for (const [name, handler] of Object.entries(reads)) {
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    current[name] = () => subscription.current.data
  }
  return async (step: string, handler: () => Promise<unknown>) => {
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
    for (const [name, read] of Object.entries(reads)) {
      expect(current[name]!(), `${name} after ${step}`).toEqual(JSON.parse(JSON.stringify(await read())))
    }
  }
}

describe.each(drivers)('realtime constrained belongsToMany on %s', (driver) => {
  it('keeps a constrained belongsToMany next to an unconstrained sibling equal to a fresh read', async () => {
    const { db, posts, tags, postTags, Post } = await openBlog(driver)
    const reads = {
      constrainedWithSibling: () => db.model(Post).query()
        .with({ tags: query => query.where('active', 1).orderBy('id') })
        .with('allTags')
        .orderBy('id')
        .getJson(),
      siblingFirst: () => db.model(Post).query()
        .with('allTags')
        .with({ tags: query => query.where('active', 1).orderBy('id') })
        .orderBy('id')
        .getJson(),
      scopedWithSibling: () => db.model(Post).query().with('activeTags', 'allTags').orderBy('id').getJson(),
      constrainedOnly: () => db.model(Post).query()
        .with({ tags: query => query.where('active', 1).orderBy('id') })
        .orderBy('id')
        .getJson(),
    }
    const mutate = await subscribeAll(reads)

    await mutate('activating a tag', () => db.table(tags).where('id', 2).update({ active: 1 }))
    await mutate('deactivating a tag', () => db.table(tags).where('id', 1).update({ active: 0 }))
    await mutate('relabeling a tag', () => db.table(tags).where('id', 3).update({ label: 'signals' }))
    await mutate('inserting an inactive tag', () => db.table(tags).insert({ id: 4, label: 'draft', active: 0 }))
    await mutate('inserting an active tag', () => db.table(tags).insert({ id: 5, label: 'live', active: 1 }))
    await mutate('attaching an inactive tag', () => db.table(postTags).insert({ post_id: 20, tag_id: 4 }))
    await mutate('attaching an active tag', () => db.table(postTags).insert({ post_id: 20, tag_id: 5 }))
    await mutate('moving a pivot row', () => db.table(postTags).where('tag_id', 2).update({ post_id: 20 }))
    await mutate('retargeting a pivot row', () => db.table(postTags).where('tag_id', 4).update({ tag_id: 1 }))
    await mutate('deleting a pivot row', () => db.table(postTags).where('tag_id', 5).delete())
    await mutate('deleting a tag', () => db.table(tags).where('id', 3).delete())
    await mutate('inserting a post', () => db.table(posts).insert({ id: 30, title: 'Frequency Hopping' }))
    await mutate('tagging the new post', () => db.table(postTags).insert({ post_id: 30, tag_id: 2 }))
  })

  it('keeps a lazily loaded scoped belongsToMany equal to a fresh read', async () => {
    const { db, tags, postTags, Post } = await openBlog(driver)
    const mutate = await subscribeAll({
      activeTags: async () => (await (await db.model(Post).query().orderBy('id').get()).load('activeTags')).toJSON(),
    })

    await mutate('activating a tag', () => db.table(tags).where('id', 2).update({ active: 1 }))
    await mutate('deactivating a tag', () => db.table(tags).where('id', 1).update({ active: 0 }))
    await mutate('attaching a tag', () => db.table(postTags).insert({ post_id: 20, tag_id: 2 }))
    await mutate('moving a pivot row', () => db.table(postTags).where('tag_id', 3).update({ post_id: 10 }))
    await mutate('deleting a pivot row', () => db.table(postTags).where('post_id', 20).delete())
    await mutate('deleting a tag', () => db.table(tags).where('id', 3).delete())
  })

  it('keeps an unconstrained belongsToMany equal to a fresh read when a pivot row changes its keys', async () => {
    const { db, postTags, Post } = await openBlog(driver)
    const mutate = await subscribeAll({
      allTags: () => db.model(Post).query().with('allTags').orderBy('id').getJson(),
    })

    await mutate('moving a pivot row', () => db.table(postTags).where('tag_id', 2).update({ post_id: 20 }))
    await mutate('retargeting a pivot row', () => db.table(postTags).where('tag_id', 3).update({ tag_id: 1 }))
  })
})
