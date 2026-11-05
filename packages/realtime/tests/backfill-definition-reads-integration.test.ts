import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function openFixture(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const groupsName = `holo_fill_groups_${suffix}`
  const tagsName = `holo_fill_tags_${suffix}`
  const pivotName = `holo_fill_group_tags_${suffix}`
  const postsName = `holo_fill_posts_${suffix}`
  await schema.createTable(groupsName, (table) => {
    table.id()
    table.bigInteger('rank')
    table.string('name')
  })
  await schema.createTable(tagsName, (table) => {
    table.id()
    table.bigInteger('weight')
    table.string('name')
  })
  await schema.createTable(pivotName, (table) => {
    table.id()
    table.bigInteger('group_id')
    table.bigInteger('tag_id')
    table.bigInteger('position')
  })
  await schema.createTable(postsName, (table) => {
    table.id()
    table.bigInteger('group_id')
    table.bigInteger('score')
    table.string('title')
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(groupsName)
  })
  const groups = defineGeneratedTable(groupsName, { id: column.id(), rank: column.bigInteger(), name: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), weight: column.bigInteger(), name: column.string() })
  const groupTags = defineGeneratedTable(pivotName, { id: column.id(), group_id: column.bigInteger(), tag_id: column.bigInteger(), position: column.bigInteger() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), group_id: column.bigInteger(), score: column.bigInteger(), title: column.string() })
  await db.table(groups).insert([{ id: 1, rank: 10, name: 'first' }, { id: 2, rank: 20, name: 'second' }])
  await db.table(tags).insert([{ id: 1, weight: 5, name: 'sale' }, { id: 2, weight: 7, name: 'new' }, { id: 3, weight: 9, name: 'old' }])
  await db.table(groupTags).insert([{ id: 1, group_id: 1, tag_id: 1, position: 2 }])
  await db.table(posts).insert([
    { id: 1, group_id: 1, score: 3, title: 'a' },
    { id: 2, group_id: 1, score: 8, title: 'b' },
    { id: 3, group_id: 2, score: 6, title: 'c' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Tag = defineModel(tags, { timestamps: false })
  const Group = defineModel(groups, { timestamps: false, relations: {
    tags: belongsToMany(() => Tag, groupTags, 'group_id', 'tag_id').withPivot('position').orderByPivot('position'),
    posts: hasMany(() => Post, 'group_id'),
    topPost: hasOne(() => Post, 'group_id'),
  } })
  const Post = defineModel(posts, { timestamps: false, relations: { group: belongsTo(() => Group, 'group_id') } })
  return { db, groups, groupTags, posts, Group, Post }
}

async function subscribeAll(queries: Record<string, () => Promise<unknown>>) {
  const runs = Object.fromEntries(Object.keys(queries).map(name => [name, 0]))
  const subscriptions = await Promise.all(Object.entries(queries).map(([name, handler]) => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: () => {
      runs[name]! += 1
      return handler()
    } }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )))
  return async () => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    expect(Object.fromEntries(Object.keys(queries).map((name, index) => [name, subscriptions[index]!.current.data])))
      .toEqual(Object.fromEntries(Object.keys(queries).map((name, index) => [name, fresh[index]])))
    expect(runs).toEqual(Object.fromEntries(Object.keys(queries).map(name => [name, 1])))
  }
}

describe.each(drivers)('realtime backfills over tables outside the generated registry on %s', (driver) => {
  it('backfills a related row for an ordered belongsToMany insert the way a fresh model read does', async () => {
    const { db, groupTags, Group } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      eager: () => db.model(Group).query().with('tags').orderBy('id').getJson(),
    })

    await mutate(() => db.table(groupTags).insert({ id: 2, group_id: 1, tag_id: 2, position: 1 }))
    await expectFresh()
    await mutate(() => db.table(groupTags).insert({ id: 3, group_id: 2, tag_id: 3, position: 4 }))
    await expectFresh()
  })

  it('hydrates a belongsTo row for a new child the way a fresh model read does', async () => {
    const { db, posts, Post } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      eager: () => db.model(Post).query().with('group').orderBy('id').getJson(),
    })

    await mutate(() => db.table(posts).insert({ id: 4, group_id: 2, score: 1, title: 'd' }))
    await expectFresh()
    await mutate(() => db.table(posts).where('id', 1).update({ group_id: 2 }))
    await expectFresh()
  })

  it('hydrates ordered hasOne rows for several parents the way a fresh model read does', async () => {
    const { db, groups, posts, Group } = await openFixture(driver)
    await db.table(posts).insert([
      { id: 4, group_id: 3, score: 1, title: 'd' },
      { id: 5, group_id: 3, score: 9, title: 'e' },
      { id: 6, group_id: 4, score: 4, title: 'f' },
    ])
    const expectFresh = await subscribeAll({
      eager: () => db.model(Group).query().with('topPost', query => query.orderBy('score', 'desc')).orderBy('id').getJson(),
    })

    await mutate(() => db.table(groups).insert([{ id: 3, rank: 30, name: 'third' }, { id: 4, rank: 40, name: 'fourth' }]))
    await expectFresh()
  })

  it('backfills windows of several groups the way a fresh model read does', async () => {
    const { db, posts, Post } = await openFixture(driver)
    await db.table(posts).insert([{ id: 4, group_id: 2, score: 2, title: 'd' }])
    const expectFresh = await subscribeAll({
      first: () => db.model(Post).query().where('group_id', 1).orderBy('score').limit(1).getJson(),
      second: () => db.model(Post).query().where('group_id', 2).orderBy('score').limit(1).getJson(),
    })

    await mutate(() => db.table(posts).where('id', 'in', [1, 4]).delete())
    await expectFresh()
  })

  it('backfills aggregates the way a fresh model read does', async () => {
    const { db, posts, Post } = await openFixture(driver)
    const expectFresh = await subscribeAll({
      max: () => db.model(Post).query().max('score'),
      min: () => db.model(Post).query().min('id'),
      sum: () => db.model(Post).query().sum('score'),
    })

    await mutate(() => db.table(posts).where('id', 2).delete())
    await expectFresh()
    await mutate(() => db.table(posts).where('id', 1).delete())
    await expectFresh()
  })

  it('backfills pagination windows and totals the way a fresh model read does', async () => {
    const { db, groups, Group } = await openFixture(driver)
    await db.table(groups).insert([{ id: 3, rank: 30, name: 'third' }, { id: 4, rank: 40, name: 'fourth' }])
    const expectFresh = await subscribeAll({
      page: () => db.model(Group).query().orderBy('id').paginateJson(2, 1),
      simple: () => db.model(Group).query().orderBy('id').simplePaginateJson(2, 1),
      rows: () => db.table(groups).select('id', 'rank').orderBy('id').limit(2).get(),
    })

    await mutate(() => db.table(groups).where('id', 1).delete())
    await expectFresh()
    await mutate(() => db.table(groups).where('id', 2).delete())
    await expectFresh()
  })

  it('re-runs a subscription whose backfilled row holds an integer queries cannot read', async () => {
    const { db, groups, posts, Post } = await openFixture(driver)
    await db.table(groups).insert({ id: 3, rank: '9007199254740993', name: 'huge' })
    const errors: unknown[] = []
    let runs = 0
    const handler = () => db.model(Post).query().with('group').orderBy('id').getJson()
    await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler: () => {
      runs += 1
      return handler()
    } }), {}, { onData: () => {}, onError: error => errors.push(error) })

    await mutate(() => db.table(posts).insert({ id: 4, group_id: 3, score: 1, title: 'd' }))

    await expect(handler()).rejects.toThrow('9007199254740993')
    expect(runs).toBe(2)
    expect(String(errors[0])).toContain('9007199254740993')
  })
})
