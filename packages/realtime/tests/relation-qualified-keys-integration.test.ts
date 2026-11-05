import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, latestOfMany } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

async function openLibrary(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const authorsName = `holo_qk_authors_${suffix}`
  const postsName = `holo_qk_posts_${suffix}`
  const tagsName = `holo_qk_tags_${suffix}`
  const pivotName = `holo_qk_post_tag_${suffix}`
  const reviewsName = `holo_qk_reviews_${suffix}`
  onTestFinished(async () => {
    await schema.dropTable(reviewsName)
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(postsName)
    await schema.dropTable(authorsName)
  })
  await schema.createTable(authorsName, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(postsName, (table) => {
    table.id()
    table.integer('author_id')
    table.string('title')
  })
  await schema.createTable(tagsName, (table) => {
    table.id()
    table.string('label')
  })
  await schema.createTable(pivotName, (table) => {
    table.integer('post_id')
    table.integer('tag_id')
  })
  await schema.createTable(reviewsName, (table) => {
    table.id()
    table.integer('post_id')
    table.string('body')
  })
  const authors = defineGeneratedTable(authorsName, { id: column.id(), name: column.string() })
  const posts = defineGeneratedTable(postsName, { id: column.id(), author_id: column.integer(), title: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), label: column.string() })
  const reviews = defineGeneratedTable(reviewsName, { id: column.id(), post_id: column.integer(), body: column.string() })
  await db.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
  await db.table(posts).insert([{ id: 10, author_id: 1, title: 'Engines' }, { id: 20, author_id: 2, title: 'Compilers' }])
  await db.table(tags).insert([{ id: 100, label: 'math' }, { id: 200, label: 'code' }])
  await db.table(pivotName).insert([{ post_id: 10, tag_id: 100 }, { post_id: 20, tag_id: 200 }])
  await db.table(reviews).insert([{ id: 1000, post_id: 10, body: 'great' }])
  const Tag = defineModel(tags, { timestamps: false })
  const Review = defineModel(reviews, { timestamps: false })
  const defineLibrary = (key: (table: string, column: string) => string) => {
    const Post = defineModel(posts, {
      timestamps: false,
      relations: {
        author: belongsTo(() => Author, key(postsName, 'author_id'), key(authorsName, 'id')),
        tags: belongsToMany(() => Tag, pivotName, key(pivotName, 'post_id'), key(pivotName, 'tag_id'), key(postsName, 'id'), key(tagsName, 'id')),
      },
    })
    const Author = defineModel(authors, {
      timestamps: false,
      relations: {
        topPost: hasOne(() => Post, key(postsName, 'author_id'), key(authorsName, 'id')),
        posts: hasMany(() => Post, key(postsName, 'author_id'), key(authorsName, 'id')),
        latestPost: latestOfMany(() => Post, key(postsName, 'author_id'), key(authorsName, 'id'), key(postsName, 'id')),
        reviews: hasManyThrough(() => Review, () => Post, key(postsName, 'author_id'), key(reviewsName, 'post_id'), key(authorsName, 'id'), key(postsName, 'id')),
      },
    })
    return { Author, Post }
  }
  const { Author, Post } = defineLibrary((table, column) => `${table}.${column}`)
  const plainLibrary = defineLibrary((_table, column) => column)
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, Author, Post, PlainAuthor: plainLibrary.Author, PlainPost: plainLibrary.Post, posts, pivotName, reviews }
}

describe.each(drivers)('relations with table-qualified keys on %s', (driver) => {
  it('patches realtime hydration on those relations like unqualified keys and the same as a fresh read', async () => {
    const { db, Author, Post, PlainAuthor, PlainPost, posts, pivotName, reviews } = await openLibrary(driver)
    const readsOf = (author: typeof Author | typeof PlainAuthor, post: typeof Post | typeof PlainPost) => [
      () => db.model(author).query().with('topPost').orderBy('id').getJson(),
      () => db.model(author).query().with('posts').orderBy('id').getJson(),
      () => db.model(post).query().with('author').orderBy('id').getJson(),
      () => db.model(post).query().with('tags').orderBy('id').getJson(),
      () => db.model(author).query().with('latestPost').orderBy('id').getJson(),
      () => db.model(author).query().with('reviews').orderBy('id').getJson(),
    ]
    const queries = readsOf(Author, Post)
    const plainQueries = readsOf(PlainAuthor, PlainPost)
    const subscribe = (reads: typeof queries) => {
      const runs = reads.map(() => 0)
      const subscriptions = Promise.all(reads.map((handler, index) => subscribeRealtimeQuery(
        defineRealtimeQuery({ access: 'public', handler: () => {
          runs[index]! += 1
          return handler()
        } }),
        {},
        { onData: () => {}, onError: (error) => { throw error } },
      )))
      return { runs, subscriptions }
    }
    const qualified = subscribe(queries)
    const plain = subscribe(plainQueries)
    const subscriptions = await qualified.subscriptions
    const plainSubscriptions = await plain.subscriptions
    const expectCurrent = async () => {
      const fresh = await Promise.all(queries.map(handler => handler()))
      expect(subscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
      expect(plainSubscriptions.map(subscription => subscription.current.data)).toEqual(fresh)
    }

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).where('id', 10).update({ title: 'Analytical Engines' }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(posts).insert({ id: 30, author_id: 2, title: 'Debugging' }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(pivotName).insert({ post_id: 30, tag_id: 100 }) }))
    await expectCurrent()
    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(reviews).insert({ id: 3000, post_id: 30, body: 'clear' }) }))
    await expectCurrent()
    expect(JSON.stringify(subscriptions[5]!.current.data)).toContain('clear')
    expect(JSON.stringify(subscriptions[0]!.current.data)).toContain('Analytical Engines')
    expect(qualified.runs[0]).toBe(1)
    expect(qualified.runs).toEqual(plain.runs)
  })
})
