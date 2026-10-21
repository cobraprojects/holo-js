import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect as createDatabaseDialect,
  column,
  hasMany,
  resetDB,
  resetMorphRegistry,
  type Entity,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

describe('relation callbacks on nested eager loads', () => {
  beforeEach(() => {
    resetDB()
    resetMorphRegistry()
  })

  async function setup() {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('callback_users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('callback_posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string() })
    const comments = defineTable('callback_comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.string() })

    await createTestTable(db, users)
    await createTestTable(db, posts)
    await createTestTable(db, comments)
    await db.table(users).insert([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Bob' },
    ])
    await db.table(posts).insert([
      { id: 10, user_id: 1, title: 'Post A' },
      { id: 11, user_id: 1, title: 'Post B' },
      { id: 12, user_id: 2, title: 'Post C' },
    ])
    await db.table(comments).insert([
      { id: 100, post_id: 10, body: 'Hello' },
      { id: 101, post_id: 10, body: 'Bye' },
      { id: 102, post_id: 11, body: 'Hello' },
      { id: 103, post_id: 12, body: 'Bye' },
    ])

    const Comment = defineModelFromTable(comments)
    const Post = defineModelFromTable(posts, {
      relations: {
        comments: hasMany(() => Comment, 'post_id') } })
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id') } })

    return { User }
  }

  function commentBodiesOf(post: Entity): string[] {
    return (post.getRelation<Entity[]>('comments') ?? []).map(comment => String(comment.get('body')))
  }

  it('applies a nested callback only to the named leaf relation', async () => {
    const { User } = await setup()

    const users = await User.query()
      .with('posts.comments', query => query.where('body', 'Hello'))
      .orderBy('id')
      .get()

    const adaPosts = users[0]?.getRelation<Entity[]>('posts') ?? []
    expect(adaPosts.map(post => post.get('id'))).toEqual([10, 11])
    expect(commentBodiesOf(adaPosts[0] as Entity)).toEqual(['Hello'])
    expect(commentBodiesOf(adaPosts[1] as Entity)).toEqual(['Hello'])

    const bobPosts = users[1]?.getRelation<Entity[]>('posts') ?? []
    expect(bobPosts.map(post => post.get('id'))).toEqual([12])
    expect(commentBodiesOf(bobPosts[0] as Entity)).toEqual([])
  })

  it('applies object-form nested callbacks only to the named leaf relation', async () => {
    const { User } = await setup()

    const users = await User.query()
      .with({ 'posts.comments': query => query.where('body', 'Bye') })
      .orderBy('id')
      .get()

    const adaPosts = users[0]?.getRelation<Entity[]>('posts') ?? []
    expect(adaPosts.map(post => post.get('id'))).toEqual([10, 11])
    expect(commentBodiesOf(adaPosts[0] as Entity)).toEqual(['Bye'])
    expect(commentBodiesOf(adaPosts[1] as Entity)).toEqual([])
  })

  it('keeps a root callback applied to the root relation', async () => {
    const { User } = await setup()

    const users = await User.query()
      .with('posts', query => query.where('title', 'Post B'))
      .orderBy('id')
      .get()

    expect((users[0]?.getRelation<Entity[]>('posts') ?? []).map(post => post.get('id'))).toEqual([11])
    expect((users[1]?.getRelation<Entity[]>('posts') ?? []).map(post => post.get('id'))).toEqual([])
  })
})
