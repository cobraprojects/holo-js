import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, hasOneThrough, latestMorphOne, latestOfMany, morphMany, morphOne, morphTo, morphToMany, morphedByMany, resetMorphRegistry, type ModelDefinitionLike } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

type Key = (table: string, column: string) => string

async function openLibrary(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => {
    resetRealtimeRuntime()
    resetMorphRegistry()
  })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = {
    authors: `holo_qk_authors_${suffix}`,
    posts: `holo_qk_posts_${suffix}`,
    tags: `holo_qk_tags_${suffix}`,
    postTag: `holo_qk_post_tag_${suffix}`,
    reviews: `holo_qk_reviews_${suffix}`,
    comments: `holo_qk_comments_${suffix}`,
    taggables: `holo_qk_taggables_${suffix}`,
  }
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  const create = async (name: string, build: Parameters<typeof schema.createTable>[1]) => {
    await schema.createTable(name, build)
    created.push(name)
  }
  await create(names.authors, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await create(names.posts, (table) => {
    table.integer('id').primaryKey()
    table.integer('author_id')
    table.string('title')
  })
  await create(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('label')
  })
  await create(names.postTag, (table) => {
    table.integer('post_id')
    table.integer('tag_id')
  })
  await create(names.reviews, (table) => {
    table.integer('id').primaryKey()
    table.integer('post_id')
    table.string('body')
  })
  await create(names.comments, (table) => {
    table.integer('id').primaryKey()
    table.string('commentable_type')
    table.integer('commentable_id')
    table.string('body')
  })
  await create(names.taggables, (table) => {
    table.integer('tag_id')
    table.string('taggable_type')
    table.integer('taggable_id')
  })
  const authors = defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), title: column.string() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), label: column.string() })
  const reviews = defineGeneratedTable(names.reviews, { id: column.integer().primaryKey(), post_id: column.integer(), body: column.string() })
  const comments = defineGeneratedTable(names.comments, { id: column.integer().primaryKey(), commentable_type: column.string(), commentable_id: column.integer(), body: column.string() })
  const postType = `HoloQkPost${suffix}`
  await db.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Hedy' }])
  await db.table(posts).insert([{ id: 10, author_id: 1, title: 'Engines' }, { id: 20, author_id: 2, title: 'Compilers' }])
  await db.table(tags).insert([{ id: 100, label: 'math' }, { id: 200, label: 'code' }])
  await db.table(names.postTag).insert([{ post_id: 10, tag_id: 100 }, { post_id: 20, tag_id: 200 }])
  await db.table(reviews).insert([{ id: 1000, post_id: 10, body: 'great' }])
  await db.table(comments).insert([{ id: 5000, commentable_type: postType, commentable_id: 10, body: 'first' }])
  await db.table(names.taggables).insert([{ tag_id: 100, taggable_type: postType, taggable_id: 10 }])

  const defineLibrary = (key: Key) => {
    const Review = defineModel(reviews, { timestamps: false })
    const Comment = defineModel(comments, {
      timestamps: false,
      relations: { commentable: morphTo('commentable', key(names.comments, 'commentable_type'), key(names.comments, 'commentable_id')) },
    })
    const Tag = defineModel(tags, {
      timestamps: false,
      relations: {
        taggedPosts: morphedByMany((): ModelDefinitionLike => Post, 'taggable', names.taggables, key(names.taggables, 'tag_id'), key(names.tags, 'id'), key(names.posts, 'id'), key(names.taggables, 'taggable_type'), key(names.taggables, 'taggable_id')),
      },
    })
    const Post = defineModel(posts, {
      morphClass: postType,
      timestamps: false,
      relations: {
        author: belongsTo((): ModelDefinitionLike => Author, key(names.posts, 'author_id'), key(names.authors, 'id')),
        tags: belongsToMany(() => Tag, names.postTag, key(names.postTag, 'post_id'), key(names.postTag, 'tag_id'), key(names.posts, 'id'), key(names.tags, 'id')),
        comments: morphMany(() => Comment, 'commentable', key(names.comments, 'commentable_type'), key(names.comments, 'commentable_id'), key(names.posts, 'id')),
        firstComment: morphOne(() => Comment, 'commentable', key(names.comments, 'commentable_type'), key(names.comments, 'commentable_id'), key(names.posts, 'id')),
        latestComment: latestMorphOne(() => Comment, 'commentable', key(names.comments, 'id'), key(names.comments, 'commentable_type'), key(names.comments, 'commentable_id'), key(names.posts, 'id')),
        morphTags: morphToMany(() => Tag, 'taggable', names.taggables, key(names.taggables, 'tag_id'), key(names.posts, 'id'), key(names.tags, 'id'), key(names.taggables, 'taggable_type'), key(names.taggables, 'taggable_id')),
      },
    })
    const Author = defineModel(authors, {
      timestamps: false,
      relations: {
        topPost: hasOne(() => Post, key(names.posts, 'author_id'), key(names.authors, 'id')),
        posts: hasMany(() => Post, key(names.posts, 'author_id'), key(names.authors, 'id')),
        latestPost: latestOfMany(() => Post, key(names.posts, 'author_id'), key(names.authors, 'id'), key(names.posts, 'id')),
        reviews: hasManyThrough(() => Review, () => Post, key(names.posts, 'author_id'), key(names.reviews, 'post_id'), key(names.authors, 'id'), key(names.posts, 'id')),
        firstReview: hasOneThrough(() => Review, () => Post, key(names.posts, 'author_id'), key(names.reviews, 'post_id'), key(names.authors, 'id'), key(names.posts, 'id')),
      },
    })
    return { Author, Post, Comment, Tag }
  }
  const plainLibrary = defineLibrary((_table, name) => name)
  const qualifiedLibrary = defineLibrary((table, name) => `${table}.${name}`)
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, qualifiedLibrary, plainLibrary, names, posts, reviews, comments, postType }
}

type Library = Awaited<ReturnType<typeof openLibrary>>['qualifiedLibrary']

describe.each(drivers)('realtime relations with table-qualified keys on %s', (driver) => {
  it('patches every relation kind like unqualified keys and the same as a fresh read', async () => {
    const { db, qualifiedLibrary, plainLibrary, names, posts, reviews, comments, postType } = await openLibrary(driver)
    const readsOf = (library: Library) => ({
      topPost: () => db.model(library.Author).query().with('topPost').orderBy('id').getJson(),
      posts: () => db.model(library.Author).query().with('posts').orderBy('id').getJson(),
      latestPost: () => db.model(library.Author).query().with('latestPost').orderBy('id').getJson(),
      reviews: () => db.model(library.Author).query().with('reviews').orderBy('id').getJson(),
      firstReview: () => db.model(library.Author).query().with('firstReview').orderBy('id').getJson(),
      author: () => db.model(library.Post).query().with('author').orderBy('id').getJson(),
      tags: () => db.model(library.Post).query().with('tags').orderBy('id').getJson(),
      comments: () => db.model(library.Post).query().with('comments', 'firstComment', 'latestComment').orderBy('id').getJson(),
    })
    const subscribe = async (reads: ReturnType<typeof readsOf>) => {
      const runs: Record<string, number> = {}
      const current: Record<string, () => unknown> = {}
      for (const [name, handler] of Object.entries(reads)) {
        runs[name] = 0
        const subscription = await subscribeRealtimeQuery(
          defineRealtimeQuery({ access: 'public', handler: () => {
            runs[name]! += 1
            return handler()
          } }),
          {},
          { onData: () => {}, onError: (error) => { throw error } },
        )
        current[name] = () => subscription.current.data
      }
      return { runs, current }
    }
    const qualifiedReads = readsOf(qualifiedLibrary)
    const qualified = await subscribe(qualifiedReads)
    const plain = await subscribe(readsOf(plainLibrary))
    const expectCurrent = async (skipped: readonly string[] = []) => {
      for (const [name, handler] of Object.entries(qualifiedReads).filter(([name]) => !skipped.includes(name))) {
        const fresh = await handler()
        expect(qualified.current[name]!(), name).toEqual(fresh)
        expect(plain.current[name]!(), name).toEqual(fresh)
      }
    }
    const mutate = async (handler: () => Promise<unknown>, skipped: readonly string[] = []) => {
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
      await expectCurrent(skipped)
    }

    await mutate(() => db.table(posts).where('id', 10).update({ title: 'Analytical Engines' }))
    await mutate(() => db.table(posts).insert({ id: 30, author_id: 3, title: 'Frequency Hopping' }))
    await mutate(() => db.table(names.postTag).insert({ post_id: 30, tag_id: 100 }))
    await mutate(() => db.table(reviews).insert({ id: 3000, post_id: 30, body: 'clear' }))
    expect(JSON.stringify(qualified.current.reviews!())).toContain('clear')
    await mutate(() => db.table(comments).insert({ id: 7000, commentable_type: postType, commentable_id: 30, body: 'radio' }))
    await mutate(() => db.table(names.taggables).insert({ tag_id: 200, taggable_type: postType, taggable_id: 30 }))
    await mutate(() => db.table(comments).where('id', 5000).update({ body: 'edited' }))
    await mutate(() => db.table(posts).where('id', 20).delete())
    await mutate(() => db.table(posts).where('id', 30).update({ author_id: 2 }), ['reviews', 'firstReview'])

    expect(JSON.stringify(qualified.current.topPost!())).toContain('Analytical Engines')
    expect(JSON.stringify(qualified.current.comments!())).toContain('edited')
    expect(qualified.runs.topPost).toBe(1)
    expect(qualified.runs).toEqual(plain.runs)
  })
})
