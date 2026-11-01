import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, column, configureDB, createConnectionManager, createDatabase, createDialect, hasMany, morphTo, resetDB } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

const users = defineTable('users', { id: column.id(), name: column.string(), email: column.string().unique() })
const posts = defineTable('posts', { id: column.id(), userId: column.integer(), title: column.string(), votes: column.integer() })
const tags = defineTable('tags', { id: column.id(), name: column.string() })
const postTags = defineTable('post_tags', { id: column.id(), postId: column.integer(), tagId: column.integer() })
const images = defineTable('images', { id: column.id(), imageableType: column.string(), imageableId: column.integer() })

async function seedBlog() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  for (const table of [users, posts, tags, postTags, images]) await createTestTable(db, table)
  await db.table(users).insert([
    { id: 1, name: 'Mohamed', email: 'mo@example.com' },
    { id: 2, name: 'Amina', email: 'amina@example.com' },
    { id: 3, name: 'Sara', email: 'sara@example.com' },
  ])
  await db.table(posts).insert([
    { id: 10, userId: 1, title: 'Hello', votes: 5 },
    { id: 11, userId: 1, title: 'Draft', votes: 1 },
    { id: 12, userId: 2, title: 'Notes', votes: 8 },
  ])
  await db.table(tags).insert([{ id: 20, name: 'news' }, { id: 21, name: 'tips' }])
  await db.table(postTags).insert([{ id: 1, postId: 10, tagId: 20 }, { id: 2, postId: 12, tagId: 21 }])
  await db.table(images).insert([
    { id: 30, imageableType: 'User', imageableId: 1 },
    { id: 31, imageableType: 'Post', imageableId: 12 },
    { id: 32, imageableType: 'Post', imageableId: 11 },
  ])

  const Tag = defineModelFromTable(tags)
  const Post = defineModelFromTable(posts, {
    name: 'Post',
    relations: { tags: belongsToMany(() => Tag, postTags, 'postId', 'tagId') },
  })
  const User = defineModelFromTable(users, {
    name: 'User',
    fillable: ['name', 'email'],
    relations: { posts: hasMany(() => Post, 'userId') },
  })
  const Image = defineModelFromTable(images, {
    relations: { imageable: morphTo('imageable', 'imageableType', 'imageableId') },
  })
  return { User, Post, Tag, Image }
}

beforeEach(() => resetDB())

describe('model eloquent helpers', () => {
  it('filters by primary key', async () => {
    const { User } = await seedBlog()

    expect(await User.whereKey(2).pluck('name')).toEqual(['Amina'])
    expect(await User.whereKey([1, 3]).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Sara'])
    expect(await User.whereKeyNot(2).orderBy('id').pluck('name')).toEqual(['Mohamed', 'Sara'])
    expect(await User.whereKeyNot([1, 3]).pluck('name')).toEqual(['Amina'])
  })

  it('falls back when nothing is found', async () => {
    const { User } = await seedBlog()

    expect((await User.findOr(2, () => 'missing'))).toMatchObject({ name: 'Amina' })
    expect(await User.findOr(99, () => 'missing')).toBe('missing')
    expect(await User.where('name', 'Sara').firstOr(() => 'missing')).toMatchObject({ id: 3 })
    expect(await User.where('name', 'Nobody').firstOr(async () => 'missing')).toBe('missing')

    const fresh = await User.findOrNew(99)
    expect(fresh.exists()).toBe(false)
    expect((await User.findOrNew(1)).get('name')).toBe('Mohamed')
  })

  it('creates a record or returns the one that already holds the unique value', async () => {
    const { User } = await seedBlog()

    const created = await User.createOrFirst({ email: 'lina@example.com' }, { name: 'Lina' })
    const existing = await User.createOrFirst({ email: 'mo@example.com' }, { name: 'Other' })
    const inTransaction = await DB.transaction(async () => {
      const user = await User.createOrFirst({ email: 'amina@example.com' }, { name: 'Other' })
      return { user, total: await User.count() }
    })

    expect(created.get('name')).toBe('Lina')
    expect(existing.get('id')).toBe(1)
    expect(existing.get('name')).toBe('Mohamed')
    expect(inTransaction.user.get('id')).toBe(2)
    expect(inTransaction.total).toBe(4)
  })

  it('filters by missing related column values', async () => {
    const { User } = await seedBlog()

    expect(await User.whereDoesntHaveRelation('posts', 'votes', '>', 4).orderBy('id').pluck('name')).toEqual(['Sara'])
    expect(await User.where('id', 1).orWhereDoesntHaveRelation('posts', 'title', 'Notes').orderBy('id').pluck('name')).toEqual(['Mohamed', 'Sara'])
  })

  it('filters polymorphic relations by type', async () => {
    const { Image, User } = await seedBlog()

    expect(await Image.hasMorph('imageable', 'Post').orderBy('id').pluck('id')).toEqual([31, 32])
    expect(await Image.whereHasMorph('imageable', ['Post'], query => query.where('votes', '>', 4)).pluck('id')).toEqual([31])
    expect(await Image.whereHasMorph('imageable', [User]).pluck('id')).toEqual([30])
    expect(await Image.where('id', 30).orWhereHasMorph('imageable', 'Post', query => query.where('title', 'Draft')).orderBy('id').pluck('id')).toEqual([30, 32])
    expect(await Image.where('id', 30).orHasMorph('imageable', 'Post').orderBy('id').pluck('id')).toEqual([30, 31, 32])
    expect(await Image.doesntHaveMorph('imageable', 'Post').pluck('id')).toEqual([30])
    expect(await Image.whereDoesntHaveMorph('imageable', 'Post', query => query.where('votes', '>', 4)).orderBy('id').pluck('id')).toEqual([30, 32])
    expect(await Image.where('id', 31).orDoesntHaveMorph('imageable', 'User').orderBy('id').pluck('id')).toEqual([31, 32])
    expect(await Image.whereMorphDoesntHaveRelation('imageable', 'Post', 'votes', '>', 4).orderBy('id').pluck('id')).toEqual([30, 32])
    expect(await Image.where('id', 31).orWhereMorphDoesntHaveRelation('imageable', 'Post', 'votes', '>', 4).orderBy('id').pluck('id')).toEqual([30, 31, 32])
    expect(await Image.where('id', 31).orWhereDoesntHaveMorph('imageable', 'Post', query => query.where('votes', '>', 0)).orderBy('id').pluck('id')).toEqual([30, 31])
  })

  it('loads relation aggregates by function name', async () => {
    const { User } = await seedBlog()

    const authors = await User.withAggregate('posts', 'votes', 'sum').orderBy('id').get()

    const counted = await User.withAggregate('posts', '*', 'count').orderBy('id').get()

    expect(authors.map(user => (user.toJSON() as Record<string, unknown>).posts_sum_votes)).toEqual([6, 8, 0])
    expect(counted.map(user => (user.toJSON() as Record<string, unknown>).posts_count)).toEqual([2, 1, 0])
  })

  it('filters by attached related models', async () => {
    const { Post, Tag } = await seedBlog()
    const news = await Tag.findOrFail(20)
    const tips = await Tag.findOrFail(21)

    expect(await Post.whereAttachedTo(news).pluck('id')).toEqual([10])
    expect(await Post.whereAttachedTo([news, tips], 'tags').orderBy('id').pluck('id')).toEqual([10, 12])
    expect(await Post.where('id', 11).orWhereAttachedTo(tips).orderBy('id').pluck('id')).toEqual([11, 12])
  })
})
