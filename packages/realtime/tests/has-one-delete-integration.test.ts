import { randomUUID } from 'node:crypto'
import { belongsTo, column, defineGeneratedTable, defineModel, hasOne, latestOfMany, oldestOfMany } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

async function openAuthors(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsName = `holo_one_authors_${suffix}`
  const postsName = `holo_one_posts_${suffix}`
  await schema.createTable(authorsName, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(postsName, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.string('title')
    table.integer('score').default(0)
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(authorsName)
  })
  const authors = defineGeneratedTable(authorsName, { id: column.id(), name: column.string() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), author_id: column.integer(), title: column.string(), score: column.integer() })
  await db.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
  await db.table(posts).insert([
    { id: 1, author_id: 1, title: 'first', score: 9 },
    { id: 2, author_id: 1, title: 'second', score: 5 },
    { id: 3, author_id: 2, title: 'other', score: 1 },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Post = defineModel(posts, { timestamps: false })
  const Author = defineModel(authors, {
    timestamps: false,
    relations: {
      post: hasOne(() => Post, 'author_id'),
      latestPost: latestOfMany(() => Post, 'author_id'),
      oldestPost: oldestOfMany(() => Post, 'author_id'),
    },
  })
  return { db, posts, Author }
}

async function subscribe(handler: () => Promise<unknown>) {
  return await subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )
}

describe.each(drivers)('realtime hasOne relations after deleting the loaded row on %s', (driver) => {
  it('loads the remaining row for an unordered hasOne', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with('post').orderBy('id').getJson()
    const subscription = await subscribe(handler)
    const loaded = (subscription.current.data as { post: { id: number } }[])[0]!.post.id

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', loaded).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toContainEqual(expect.objectContaining({ id: 1, post: expect.objectContaining({ id: 3 - loaded }) }))
  })

  it('loads the next matching row for hasOne', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with({ post: query => query.orderBy('id') }).orderBy('id').getJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"first"')

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')
  })

  it('loads the next top row for a hasOne ordered by a call-time constraint', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with('post', query => query.orderBy('score', 'desc')).orderBy('id').getJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"first"')

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')
  })

  it('keeps a hasOne constrained by a limit equal to a fresh batched load', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    await db.table(posts).where('id', 2).update({ author_id: 2 })
    await db.table(posts).where('id', 3).update({ author_id: 1 })
    const handler = () => db.model(Author).query().with({ post: query => query.orderBy('id').limit(1) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it.each([
    ['without its foreign key', ['id', 'title']],
    ['another column as its foreign key', ['id', 'author_id', 'title', 'score as author_id']],
    ['another column as its primary key', ['id', 'author_id', 'title', 'score as id']],
  ] as const)('keeps a hasOne whose constraint selects %s equal to a fresh load', async (_name, columns) => {
    const { db, posts, Author } = await openAuthors(driver)
    await db.table(posts).where('id', 3).update({ score: 1 })
    const handler = () => db.model(Author).query().with({ post: query => query.select(...columns).orderBy(`${posts.tableName}.id`) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 3).delete() }))
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).insert({ id: 4, author_id: 2, title: 'newest', score: 0 }) }))

    expect(subscription.current.data).toEqual(await handler())
  })

  it('loads the next matching row for latestOfMany', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with('latestPost').orderBy('id').getJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 2).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"first"')
  })

  it('loads the next matching row for oldestOfMany', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with('oldestPost').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')
  })

  it('keeps an ordered hasOne in step with inserts and deletes', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with({ post: query => query.orderBy('id', 'desc') }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).insert({ id: 4, author_id: 1, title: 'newest', score: 0 }) }))
    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"newest"')

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 4).delete() }))
    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')
  })

  it('keeps a subquery-constrained hasOne from loading rows its constraint hides', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with({ post: query => query.whereSub('id', 'in', db.table(posts).select('id').where('id', '!=', 2)) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"second"')
  })

  it('keeps a hasOne from loading rows a subquery global scope hides', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const ScopedPost = defineModel(posts, { timestamps: false, globalScopes: { visible: query => query.whereSub('id', 'in', db.table(posts).select('id').where('id', '!=', 2)) } })
    const ScopedAuthor = defineModel(Author.definition.table, { timestamps: false, relations: { post: hasOne(() => ScopedPost, 'author_id') } })
    const handler = () => db.model(ScopedAuthor).query().with('post').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"second"')
  })

  it.each([
    ['a nested eager load', 'post.author'],
    ['a constrained nested eager load', 'constrained'],
    ['a dotted eager load beside a constrained root', 'dotted'],
  ] as const)('keeps %s on the next hasOne row', async (_name, load) => {
    const { db, posts, Author } = await openAuthors(driver)
    const AuthoredPost = defineModel(posts, { timestamps: false, relations: { author: belongsTo(() => Author, 'author_id') } })
    const NestedAuthor = defineModel(Author.definition.table, { timestamps: false, relations: { post: hasOne(() => AuthoredPost, 'author_id') } })
    const loads = {
      'post.author': () => db.model(NestedAuthor).query().with('post.author'),
      'constrained': () => db.model(NestedAuthor).query().with({ post: query => query.orderBy('id').with('author') }),
      'dotted': () => db.model(NestedAuthor).query().with({ post: query => query.orderBy('id') }).with('post.author'),
    }
    const handler = () => loads[load]().orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 1).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"second"')
  })

  it('patches the relation to null when the last matching row is deleted', async () => {
    const { db, posts, Author } = await openAuthors(driver)
    const handler = () => db.model(Author).query().with('latestPost').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 3).delete() }))

    expect(subscription.current.data).toEqual(await handler())
    expect(subscription.current.data).toContainEqual(expect.objectContaining({ id: 2, latestPost: null }))
  })
})
