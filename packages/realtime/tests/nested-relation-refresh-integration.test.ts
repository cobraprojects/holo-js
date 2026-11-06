import { randomUUID } from 'node:crypto'
import { belongsToMany, column, hasMany, defineGeneratedTable, defineModel, type ModelDefinitionLike } from '@holo-js/db'
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
    authors: `holo_nrr_authors_${suffix}`,
    posts: `holo_nrr_posts_${suffix}`,
    tags: `holo_nrr_tags_${suffix}`,
    postTags: `holo_nrr_post_tags_${suffix}`,
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
    table.integer('published')
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
  const authors = defineGeneratedTable(names.authors, { id: column.integer().primaryKey(), name: column.string() })
  const posts = defineGeneratedTable(names.posts, { id: column.integer().primaryKey(), author_id: column.integer(), title: column.string(), published: column.integer() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), label: column.string(), active: column.integer() })
  const postTags = defineGeneratedTable(names.postTags, { post_id: column.integer(), tag_id: column.integer() })
  await db.table(authors).insert([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }, { id: 3, name: 'Hedy' }])
  await db.table(posts).insert([{ id: 10, author_id: 1, title: 'Engines', published: 1 }, { id: 20, author_id: 2, title: 'Compilers', published: 0 }])
  await db.table(tags).insert([{ id: 1, label: 'math', active: 1 }, { id: 2, label: 'code', active: 0 }, { id: 3, label: 'radio', active: 1 }])
  await db.table(postTags).insert([{ post_id: 10, tag_id: 1 }, { post_id: 10, tag_id: 2 }, { post_id: 20, tag_id: 3 }])

  const Tag = defineModel(tags, {
    timestamps: false,
    relations: {
      posts: belongsToMany((): ModelDefinitionLike => Post, names.postTags, 'tag_id', 'post_id'),
    },
  })
  const Post = defineModel(posts, {
    timestamps: false,
    relations: {
      tags: belongsToMany((): ModelDefinitionLike => Tag, names.postTags, 'post_id', 'tag_id'),
      allTags: belongsToMany((): ModelDefinitionLike => Tag, names.postTags, 'post_id', 'tag_id'),
    },
  })
  const Author = defineModel(authors, {
    timestamps: false,
    relations: {
      posts: hasMany((): ModelDefinitionLike => Post, 'author_id'),
      allPosts: hasMany((): ModelDefinitionLike => Post, 'author_id'),
    },
  })
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, authors, posts, tags, postTags, Author, Post }
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

type Blog = Awaited<ReturnType<typeof openBlog>>
type Mutate = Awaited<ReturnType<typeof subscribeAll>>

const extraTags = [{ id: 4, label: 'draft', active: 0 }, { id: 5, label: 'live', active: 1 }]

async function swapTagActivity({ db, tags }: Blog) {
  await db.table(tags).where('id', 2).update({ active: 1 })
  await db.table(tags).where('id', 1).update({ active: 0 })
}

async function seedPublishedPost(blog: Blog) {
  await swapTagActivity(blog)
  await blog.db.table(blog.posts).where('id', 20).update({ title: 'Parsers', published: 1 })
}

async function seedPivotChanges(blog: Blog) {
  const { db, postTags } = blog
  await seedPublishedPost(blog)
  await db.table(postTags).where('tag_id', 2).update({ post_id: 20 })
  await db.table(postTags).insert({ post_id: 20, tag_id: 1 })
}

const writes: readonly { name: string, seed?: (blog: Blog) => Promise<unknown>, run: (mutate: Mutate, blog: Blog) => Promise<void> }[] = [
  {
    name: 'tag updates',
    run: async (mutate, { db, tags }) => {
      await mutate('activating a tag', () => db.table(tags).where('id', 2).update({ active: 1 }))
      await mutate('deactivating a tag', () => db.table(tags).where('id', 1).update({ active: 0 }))
      await mutate('relabeling a tag', () => db.table(tags).where('id', 3).update({ label: 'signals' }))
    },
  },
  {
    name: 'tag inserts and deletes',
    seed: async (blog) => {
      const { db, posts, postTags } = blog
      await seedPivotChanges(blog)
      await db.table(posts).insert({ id: 30, author_id: 3, title: 'Frequency Hopping', published: 1 })
      await db.table(postTags).insert({ post_id: 30, tag_id: 3 })
    },
    run: async (mutate, { db, tags }) => {
      await mutate('inserting an inactive tag', () => db.table(tags).insert({ id: 4, label: 'draft', active: 0 }))
      await mutate('inserting an active tag', () => db.table(tags).insert({ id: 5, label: 'live', active: 1 }))
      await mutate('deleting a tag', () => db.table(tags).where('id', 3).delete())
    },
  },
  {
    name: 'pivot inserts',
    seed: async (blog) => {
      await seedPublishedPost(blog)
      await blog.db.table(blog.tags).insert(extraTags)
    },
    run: async (mutate, { db, postTags }) => {
      await mutate('attaching an inactive tag', () => db.table(postTags).insert({ post_id: 20, tag_id: 4 }))
      await mutate('attaching an active tag', () => db.table(postTags).insert({ post_id: 20, tag_id: 5 }))
    },
  },
  {
    name: 'pivot updates and deletes',
    seed: async (blog) => {
      const { db, tags, postTags } = blog
      await seedPublishedPost(blog)
      await db.table(tags).insert(extraTags)
      await db.table(postTags).insert([{ post_id: 20, tag_id: 4 }, { post_id: 20, tag_id: 5 }])
    },
    run: async (mutate, { db, postTags }) => {
      await mutate('moving a pivot row', () => db.table(postTags).where('tag_id', 2).update({ post_id: 20 }))
      await mutate('retargeting a pivot row', () => db.table(postTags).where('tag_id', 4).update({ tag_id: 1 }))
      await mutate('deleting a pivot row', () => db.table(postTags).where('tag_id', 5).delete())
    },
  },
  {
    name: 'post updates',
    seed: swapTagActivity,
    run: async (mutate, { db, posts }) => {
      await mutate('retitling a post', () => db.table(posts).where('id', 20).update({ title: 'Parsers' }))
      await mutate('publishing a post', () => db.table(posts).where('id', 20).update({ published: 1 }))
    },
  },
  {
    name: 'post inserts, moves and deletes',
    seed: seedPivotChanges,
    run: async (mutate, { db, posts, postTags }) => {
      await mutate('inserting a post', () => db.table(posts).insert({ id: 30, author_id: 3, title: 'Frequency Hopping', published: 1 }))
      await mutate('tagging the new post', () => db.table(postTags).insert({ post_id: 30, tag_id: 3 }))
      await mutate('moving a post to another author', () => db.table(posts).where('id', 20).update({ author_id: 1 }))
      await mutate('deleting a post', () => db.table(posts).where('id', 10).delete())
    },
  },
  {
    name: 'author writes',
    seed: async (blog) => {
      const { db, posts, postTags, tags } = blog
      await seedPivotChanges(blog)
      await db.table(posts).insert({ id: 30, author_id: 3, title: 'Frequency Hopping', published: 1 })
      await db.table(postTags).insert({ post_id: 30, tag_id: 3 })
      await db.table(tags).where('id', 3).delete()
      await db.table(posts).where('id', 20).update({ author_id: 1 })
    },
    run: async (mutate, { db, authors, posts }) => {
      await mutate('inserting an author', () => db.table(authors).insert({ id: 4, name: 'Radia' }))
      await mutate('writing a post for the new author', () => db.table(posts).insert({ id: 40, author_id: 4, title: 'Spanning Trees', published: 0 }))
      await mutate('renaming an author', () => db.table(authors).where('id', 2).update({ name: 'Grace Hopper' }))
    },
  },
]

const subscriptions: readonly { name: string, reads: (blog: Blog) => Record<string, () => Promise<unknown>> }[] = [
  {
    name: 'keeps nested eager loads next to a sibling relation equal to a fresh read',
    reads: ({ db, Post }) => ({
      nestedWithSibling: () => db.model(Post).query().with('allTags.posts', 'tags').orderBy('id').getJson(),
      siblingFirst: () => db.model(Post).query().with('tags', 'allTags.posts').orderBy('id').getJson(),
      nestedOnly: () => db.model(Post).query().with('allTags.posts').orderBy('id').getJson(),
      nestedNextToItsParent: () => db.model(Post).query().with('allTags', 'allTags.posts').orderBy('id').getJson(),
      constrainedNested: () => db.model(Post).query()
        .with({ 'allTags.posts': query => query.where('published', 1) })
        .with('tags')
        .orderBy('id')
        .getJson(),
    }),
  },
  {
    name: 'keeps a constrained whereHas next to a sibling relation equal to a fresh read',
    reads: ({ db, Post }) => ({
      whereHasWithSibling: () => db.model(Post).query()
        .whereHas('tags', query => query.where('active', 1))
        .with('allTags')
        .orderBy('id')
        .getJson(),
      whereDoesntHaveWithSibling: () => db.model(Post).query()
        .whereDoesntHave('tags', query => query.where('active', 1))
        .with('allTags')
        .orderBy('id')
        .getJson(),
      hasWithSibling: () => db.model(Post).query()
        .has('tags')
        .with('allTags')
        .orderBy('id')
        .getJson(),
      whereHasOnly: () => db.model(Post).query()
        .whereHas('tags', query => query.where('active', 1))
        .orderBy('id')
        .getJson(),
    }),
  },
  {
    name: 'keeps a whereHas with a withCount on the same relation equal to a fresh read',
    reads: ({ db, Author, Post }) => ({
      hasManyWhereHasWithCount: () => db.model(Author).query().whereHas('posts').withCount('posts').orderBy('id').getJson(),
      hasManyConstrainedWhereHasWithCount: () => db.model(Author).query()
        .whereHas('posts', query => query.where('published', 1))
        .withCount('posts')
        .orderBy('id')
        .getJson(),
      hasManyWhereHasWithSibling: () => db.model(Author).query().whereHas('posts').with('allPosts').orderBy('id').getJson(),
      belongsToManyWhereHasWithCount: () => db.model(Post).query().whereHas('tags').withCount('tags').orderBy('id').getJson(),
    }),
  },
  {
    name: 'keeps a constrained withCount equal to a fresh read',
    reads: ({ db, Post }) => ({
      constrainedCount: () => db.model(Post).query()
        .withCount({ tags: query => query.where('active', 1) })
        .orderBy('id')
        .getJson(),
      constrainedCountWithSibling: () => db.model(Post).query()
        .withCount({ tags: query => query.where('active', 1) })
        .with('allTags')
        .orderBy('id')
        .getJson(),
      constrainedExists: () => db.model(Post).query()
        .withExists({ tags: query => query.where('active', 1) })
        .with('allTags')
        .orderBy('id')
        .getJson(),
    }),
  },
]

describe.each(drivers)('realtime nested and constrained relations on %s', (driver) => {
  for (const { name: subscriptionName, reads } of subscriptions) {
    describe(subscriptionName, () => {
      for (const { name: writeName, seed, run } of writes) {
        it(`across ${writeName}`, async () => {
          const blog = await openBlog(driver)
          await seed?.(blog)
          await run(await subscribeAll(reads(blog)), blog)
        })
      }
    })
  }
})
