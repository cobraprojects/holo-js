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
  type ModelQueryBuilder,
  resetMorphRegistry,
  type Entity,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

describe('named scopes on ModelQueryBuilder instances', () => {
  beforeEach(() => {
    resetDB()
    resetMorphRegistry()
  })

  async function setup() {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDatabaseDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))

    const users = defineTable('scope_builder_users', {
      id: column.id(),
      name: column.string() })
    const posts = defineTable('scope_builder_posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
      status: column.string() })

    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Cy' },
    ])
    await db.table(posts).insert([
      { id: 10, user_id: 1, title: 'Alpha', status: 'published' },
      { id: 11, user_id: 1, title: 'Beta', status: 'draft' },
      { id: 12, user_id: 2, title: 'Gamma', status: 'draft' },
    ])

    const Post = defineModelFromTable(posts, {
      scopes: {
        published: (query: ModelQueryBuilder<typeof posts>) => query.where('status', 'published'),
        titled: (query: ModelQueryBuilder<typeof posts>, title: string) => query.where('title', title),
      },
    })
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id'),
      },
    })

    return { Post, User }
  }

  function titlesOf(rows: readonly Entity[]): unknown[] {
    return rows.map(row => row.get('title'))
  }

  it('applies a scope when chained directly on Model.query()', async () => {
    const { Post } = await setup()

    const rows = await Post.query().published().orderBy('id').get()

    expect(rows.map(row => row.get('title'))).toEqual(['Alpha'])
  })

  it('chains a scope after builder methods and passes scope arguments through', async () => {
    const { Post } = await setup()

    const rows = await Post.query()
      .where('user_id', 1)
      .titled('Beta')
      .get()
    expect(rows.map(row => row.get('title'))).toEqual(['Beta'])

    expect(await Post.query().where('user_id', 1).published().count()).toBe(1)
  })

  it('chains scopes into each other on the same builder', async () => {
    const { Post } = await setup()

    expect(await Post.query().published().titled('Alpha').count()).toBe(1)
    expect(await Post.query().published().titled('Beta').count()).toBe(0)
  })

  it('applies a scope inside a whereHas constraint callback', async () => {
    const { User } = await setup()

    const users = await User.query()
      .whereHas('posts', query => query.published())
      .orderBy('id')
      .get()

    expect(users.map(user => user.get('name'))).toEqual(['Ada'])
  })

  it('applies a scope inside a with constraint callback', async () => {
    const { User } = await setup()

    const users = await User.query()
      .with('posts', query => query.published())
      .orderBy('id')
      .get()

    const adaPosts = users[0]?.getRelation<Entity[]>('posts') ?? []
    expect(titlesOf(adaPosts)).toEqual(['Alpha'])
    expect(users[1]?.getRelation<Entity[]>('posts')).toEqual([])
  })

  it('chains a scope after builder methods inside a whereHas constraint callback', async () => {
    const { User } = await setup()

    const users = await User.query()
      .whereHas('posts', query => query.where('user_id', 1).titled('Beta'))
      .orderBy('id')
      .get()

    expect(users.map(user => user.get('name'))).toEqual(['Ada'])
  })

  it('rejects scope names that would shadow a ModelQueryBuilder member', () => {
    const guarded = defineTable('scope_builder_guarded', { id: column.id() })

    for (const name of ['where', 'count', 'repository']) {
      expect(() => defineModelFromTable(guarded, {
        scopes: { [name]: (query: ModelQueryBuilder<typeof guarded>) => query },
      })).toThrow(`Model scope "${name}" conflicts with a ModelQueryBuilder member`)
    }
  })
})
