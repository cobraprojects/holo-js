import { randomUUID } from 'node:crypto'
import { belongsTo, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Driver = typeof drivers[number]

async function openPosts(driver: Driver) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsName = `holo_owner_authors_${suffix}`
  const postsName = `holo_owner_posts_${suffix}`
  await schema.createTable(authorsName, (table) => {
    table.id()
    table.string('name')
    table.boolean('active')
    table.timestamp('deleted_at').nullable()
  })
  await schema.createTable(postsName, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.string('title')
  })
  onTestFinished(async () => {
    await schema.dropTable(postsName)
    await schema.dropTable(authorsName)
  })
  const authors = defineGeneratedTable(authorsName, { id: column.id(), name: column.string(), active: column.boolean(), deleted_at: column.timestamp().nullable() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), author_id: column.integer(), title: column.string() })
  await db.table(authors).insert([
    { id: 1, name: 'Ada', active: true, deleted_at: null },
    { id: 2, name: 'Grace', active: true, deleted_at: null },
    { id: 3, name: 'Hidden', active: false, deleted_at: null },
  ])
  await db.table(posts).insert([
    { id: 1, author_id: 1, title: 'first' },
    { id: 2, author_id: 2, title: 'second' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Author = defineModel(authors, { timestamps: false, softDeletes: true })
  const Post = defineModel(posts, { timestamps: false, relations: { author: belongsTo(() => Author, 'author_id') } })
  return { db, schema, suffix, authors, posts, Author, Post }
}

async function subscribe(handler: () => Promise<unknown>) {
  return await subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )
}

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

describe.each(drivers)('realtime belongsTo owners hidden by constraints or scopes on %s', (driver) => {
  it('drops an owner that stops passing a call-time constraint', async () => {
    const { db, authors, Post } = await openPosts(driver)
    const handler = () => db.model(Post).query().with({ author: query => query.where('active', true) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"Ada"')

    await mutate(() => db.table(authors).where('id', 1).update({ active: false }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Ada"')
  })

  it('keeps a constrained owner hidden when a post moves onto it', async () => {
    const { db, posts, Post } = await openPosts(driver)
    const handler = () => db.model(Post).query().with({ author: query => query.where('active', true) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await mutate(() => db.table(posts).where('id', 1).update({ author_id: 3 }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Hidden"')
  })

  it('drops a soft-deleted owner', async () => {
    const { db, Author, Post } = await openPosts(driver)
    const handler = () => db.model(Post).query().with('author').orderBy('id').getJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"Ada"')

    await mutate(() => db.model(Author).query().where('id', 1).delete())

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Ada"')
  })

  it('keeps a soft-deleted owner hidden when a post moves onto it', async () => {
    const { db, authors, posts, Post } = await openPosts(driver)
    await db.table(authors).where('id', 3).update({ deleted_at: new Date() })
    const handler = () => db.model(Post).query().with('author').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await mutate(() => db.table(posts).where('id', 1).update({ author_id: 3 }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Hidden"')
  })

  it('keeps a constrained owner hidden from an inserted post', async () => {
    const { db, posts, Post } = await openPosts(driver)
    const handler = () => db.model(Post).query().with({ author: query => query.where('active', true) }).orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await mutate(() => db.table(posts).insert({ id: 3, author_id: 3, title: 'third' }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"third"')
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Hidden"')
  })

  it('keeps a soft-deleted owner hidden from an inserted post', async () => {
    const { db, authors, posts, Post } = await openPosts(driver)
    await db.table(authors).where('id', 3).update({ deleted_at: new Date() })
    const handler = () => db.model(Post).query().with('author').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await mutate(() => db.table(posts).insert({ id: 3, author_id: 3, title: 'third' }))

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).toContain('"third"')
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Hidden"')
  })

  it('keeps an owner hidden by a comparison global scope from an inserted post', async () => {
    const { db, authors, posts } = await openPosts(driver)
    const ActiveAuthor = defineModel(authors, { timestamps: false, globalScopes: { active: query => query.where('active', true) } })
    const ScopedPost = defineModel(posts, { timestamps: false, relations: { author: belongsTo(() => ActiveAuthor, 'author_id') } })
    const handler = () => db.model(ScopedPost).query().with('author').orderBy('id').getJson()
    const subscription = await subscribe(handler)

    await mutate(() => db.table(posts).insert({ id: 3, author_id: 3, title: 'third' }))
    expect(subscription.current.data).toEqual(await handler())

    await mutate(() => db.table(posts).where('id', 1).update({ author_id: 3 }))
    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Hidden"')
  })

  it.each([
    ['an unconstrained', false],
    ['a comparison-constrained', true],
  ] as const)('patches %s owner in place when a post moves', async (_name, constrained) => {
    const { db, schema, suffix, posts } = await openPosts(driver)
    const writersName = `holo_owner_writers_${suffix}`
    await schema.createTable(writersName, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    onTestFinished(() => schema.dropTable(writersName))
    const writers = defineGeneratedTable(writersName, { id: column.integer().primaryKey(), name: column.string() })
    await db.table(writers).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Hidden' }])
    const Writer = defineModel(writers, { timestamps: false })
    const Post = defineModel(posts, { timestamps: false, relations: { author: belongsTo(() => Writer, 'author_id') } })
    let reads = 0
    const read = () => (constrained ? db.model(Post).query().with({ author: query => query.where('name', '!=', 'Hidden') }) : db.model(Post).query().with('author')).orderBy('id').getJson()
    const subscription = await subscribe(() => {
      reads += 1
      return read()
    })

    await mutate(() => db.table(posts).where('id', 1).update({ author_id: 2 }))
    expect(subscription.current.data).toEqual(await read())
    expect(JSON.stringify(subscription.current.data).match(/"Grace"/g)).toHaveLength(2)

    await mutate(() => db.table(posts).where('id', 1).update({ author_id: 3 }))
    expect(subscription.current.data).toEqual(await read())
    expect(reads).toBe(1)
  })

  it('drops a single post subscription owner that is soft-deleted', async () => {
    const { db, Author, Post } = await openPosts(driver)
    const handler = () => db.model(Post).query().with('author').where('id', 1).firstJson()
    const subscription = await subscribe(handler)
    expect(JSON.stringify(subscription.current.data)).toContain('"Ada"')

    await mutate(() => db.model(Author).query().where('id', 1).delete())

    expect(subscription.current.data).toEqual(await handler())
    expect(JSON.stringify(subscription.current.data)).not.toContain('"Ada"')
  })
})
