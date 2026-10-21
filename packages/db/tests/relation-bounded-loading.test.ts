import { onTestFinished, describe, expect, it } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  type Entity,
  belongsToMany,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect as createDatabaseDialect,
  latestOfMany,
  morphToMany,
  scopeRelation,
  hasMany,
  type TableDefinition,
} from '../src'

type QueryStartLog = { sql: string, bindings: readonly unknown[] }
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

function openSQLite(logger?: { onQueryStart(entry: QueryStartLog): void }) {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({
    adapter,
    dialect: createDatabaseDialect('sqlite'),
    logger,
    security: { redactBindingsInLogs: false, maxLoggedBindings: 100_000 },
  })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

function collectBindingCounts(entries: readonly QueryStartLog[]): number[] {
  return entries.map(entry => entry.bindings.length).filter(count => count > 0)
}

describe('bounded relation loading', () => {
  it('selects only the pivot keys and declared pivot columns on belongsToMany relations', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const roles = defineTable('roles', { id: column.id(), name: column.string() })
    const roleUser = defineTable('role_user', {
      id: column.id(),
      userId: column.integer(),
      roleId: column.integer(),
      granted: column.boolean(),
      secret: column.string(),
    })
    await createTestTable(db, users)
    await createTestTable(db, roles)
    await createTestTable(db, roleUser)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    await db.table(roles).insert([{ id: 1, name: 'Admin' }])
    await db.table(roleUser).insert([{ id: 1, userId: 1, roleId: 1, granted: true, secret: 'hidden' }])

    const Role = defineModelFromTable(roles)
    const User = defineModelFromTable(users, {
      relations: {
        roles: belongsToMany(() => Role, roleUser, 'userId', 'roleId').withPivot('granted'),
      },
    })

    const [user] = await User.with('roles').get()
    const [role] = user!.getRelation<Entity<TableDefinition>[]>('roles')!
    const pivot = role!.getRelation<Record<string, unknown>>('pivot')!

    expect(Object.keys(pivot).sort()).toEqual(['granted', 'roleId', 'userId'])
    expect(pivot).not.toHaveProperty('secret')
    expect(pivot).not.toHaveProperty('id')
  })

  it('selects only the morph keys and declared pivot columns on morphToMany relations', async () => {
    const db = openSQLite()
    const articles = defineTable('articles', { id: column.id(), title: column.string() })
    const tags = defineTable('tags', { id: column.id(), name: column.string() })
    const taggables = defineTable('taggables', {
      id: column.id(),
      tagId: column.integer(),
      taggableId: column.integer(),
      taggableType: column.string(),
      note: column.string().nullable(),
      secret: column.string().nullable(),
    })
    await createTestTable(db, articles)
    await createTestTable(db, tags)
    await createTestTable(db, taggables)
    await db.table(articles).insert([{ id: 1, title: 'Hello' }])
    await db.table(tags).insert([{ id: 1, name: 'news' }])
    await db.table(taggables).insert([{ id: 1, tagId: 1, taggableId: 1, taggableType: 'articles', note: 'pinned', secret: 'hidden' }])

    const Tag = defineModelFromTable(tags)
    const Article = defineModelFromTable(articles, {
      morphClass: 'articles',
      relations: {
        tags: morphToMany(() => Tag, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId').withPivot('note'),
      },
    })

    const [article] = await Article.with('tags').get()
    const [tag] = article!.getRelation<Entity<TableDefinition>[]>('tags')!
    const pivot = tag!.getRelation<Record<string, unknown>>('pivot')!

    expect(Object.keys(pivot).sort()).toEqual(['note', 'tagId', 'taggableId', 'taggableType'])
    expect(pivot).not.toHaveProperty('secret')
  })

  it('splits eager-load key lists into bounded chunks', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', { id: column.id(), userId: column.integer(), title: column.string() })
    await createTestTable(db, users)
    await createTestTable(db, posts)

    const userRows = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    const postRows = userRows.map(user => ({ id: user.id, userId: user.id, title: `post ${user.id}` }))
    for (let index = 0; index < userRows.length; index += 200) {
      await db.table(users).insert(userRows.slice(index, index + 200))
      await db.table(posts).insert(postRows.slice(index, index + 200))
    }

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'userId'),
      },
    })

    queries.length = 0
    const loaded = await User.with('posts').orderBy('id').get()

    expect(loaded).toHaveLength(1000)
    expect(loaded.every(user => user.getRelation<Entity<TableDefinition>[]>('posts')?.length === 1)).toBe(true)

    const sizes = collectBindingCounts(queries)
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256)
    expect(new Set(sizes).size).toBeLessThanOrEqual(9)
  })

  it('splits findMany key lists into bounded chunks and returns each row once', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const users = defineTable('users', { id: column.id(), name: column.string() })
    await createTestTable(db, users)

    const userRows = Array.from({ length: 1000 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    for (let index = 0; index < userRows.length; index += 200) {
      await db.table(users).insert(userRows.slice(index, index + 200))
    }

    const User = defineModelFromTable(users)
    const keys = [...userRows.map(user => user.id), 1, 2, 3]

    queries.length = 0
    const found = await User.findMany(keys)

    expect(found).toHaveLength(1000)
    expect(new Set(found.map(user => user.get('id'))).size).toBe(1000)

    const sizes = collectBindingCounts(queries)
    expect(sizes.length).toBeGreaterThan(0)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(256)
    expect(new Set(sizes).size).toBeLessThanOrEqual(9)
  })

  it('pads ModelCollection.toQuery key lists up to 256 to a power-of-two IN size', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const users = defineTable('users', { id: column.id(), name: column.string() })
    await createTestTable(db, users)

    const userRows = Array.from({ length: 200 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    await db.table(users).insert(userRows)

    const User = defineModelFromTable(users)
    const collection = await User.get()

    queries.length = 0
    const rows = await collection.toQuery().orderBy('id').get()

    expect(rows.map(user => user.get('id'))).toEqual(userRows.map(user => user.id))
    expect(collectBindingCounts(queries)).toEqual([256])
  })

  it('returns every row for a ModelCollection.toQuery key list longer than 256', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    await createTestTable(db, users)

    const userRows = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    await db.table(users).insert(userRows)

    const User = defineModelFromTable(users)
    const collection = await User.get()
    const rows = await collection.toQuery().orderBy('id').get()

    expect(rows.map(user => user.get('id'))).toEqual(userRows.map(user => user.id))
  })

  it('inlines a toQuery integer key list above SQLite bind limits and keeps order and limit on the builder', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const users = defineTable('users', { id: column.id(), name: column.string() })
    await createTestTable(db, users)

    const userRows = Array.from({ length: 40_000 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    for (let index = 0; index < userRows.length; index += 500) {
      await db.table(users).insert(userRows.slice(index, index + 500))
    }

    const User = defineModelFromTable(users)
    const collection = await User.get()

    queries.length = 0
    const everyRow = await collection.toQuery().get()
    expect(everyRow).toHaveLength(40_000)
    expect(collectBindingCounts(queries)).toEqual([])

    const newest = await collection.toQuery().orderBy('id', 'desc').limit(3).get()
    expect(newest.map(user => user.get('id'))).toEqual([40_000, 39_999, 39_998])
  })

  it('binds a toQuery key list above 256 when a string key looks numeric or injects SQL', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const codes = defineTable('codes', { code: column.string().primaryKey(), label: column.string() })
    await createTestTable(db, codes)

    const codeRows = [
      { code: '1 OR 1=1', label: 'injected' },
      { code: '1', label: 'numeric' },
      ...Array.from({ length: 298 }, (_, index) => ({ code: `code-${index + 1}`, label: `code ${index + 1}` })),
    ]
    await db.table(codes).insert(codeRows)

    const Code = defineModelFromTable(codes)
    const collection = await Code.get()

    queries.length = 0
    const rows = await collection.toQuery().get()

    expect(rows).toHaveLength(300)
    expect(queries.some(entry => entry.sql.includes('1 OR 1=1'))).toBe(false)
    expect(queries.flatMap(entry => entry.bindings)).toEqual(expect.arrayContaining(['1 OR 1=1', '1']))
  })

  it('binds a toQuery key list above 256 when it contains an integer beyond the safe range', async () => {
    const queries: QueryStartLog[] = []
    const db = openSQLite({ onQueryStart: entry => queries.push(entry) })
    const users = defineTable('users', { id: column.integer().primaryKey(), name: column.string() })
    await createTestTable(db, users)

    const userRows = Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
    await db.table(users).insert(userRows)

    const User = defineModelFromTable(users)
    const collection = await User.get()
    collection.push(User.make().forceFill({ id: Number.MAX_SAFE_INTEGER + 1, name: 'unsafe' }))

    queries.length = 0
    const rows = await collection.toQuery().get()

    expect(rows).toHaveLength(300)
    expect(queries.some(entry => entry.sql.includes(String(Number.MAX_SAFE_INTEGER + 1)))).toBe(false)
    expect(queries.flatMap(entry => entry.bindings)).toContain(Number.MAX_SAFE_INTEGER + 1)
  })

  it('resolves one-of-many relations to no related model when every candidate value is NULL', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer().nullable(),
    })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }])
    await db.table(posts).insert([
      { id: 10, userId: 1, title: 'Post A', score: null },
      { id: 11, userId: 1, title: 'Post B', score: null },
      { id: 12, userId: 2, title: 'Post C', score: 3 },
    ])

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        topScoringPost: latestOfMany(() => Post, 'userId', 'id', 'score'),
      },
    })

    const loaded = await User.with('topScoringPost').orderBy('id').get()
    expect(loaded[0]?.getRelation('topScoringPost')).toBeNull()
    expect(loaded[1]?.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title')).toBe('Post C')
  })

  it('applies a scopeRelation constraint inside the one-of-many lookup', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer().nullable(),
    })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    await db.table(posts).insert([
      { id: 10, userId: 1, title: 'Post A', score: 9 },
      { id: 11, userId: 1, title: 'Post B', score: null },
      { id: 12, userId: 1, title: 'Post C', score: 4 },
    ])

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        topScoringPost: scopeRelation(latestOfMany(() => Post, 'userId', 'id', 'score'), query => query.where('title', '!=', 'Post A')),
      },
    })

    const [user] = await User.with('topScoringPost').get()
    expect(user!.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title')).toBe('Post C')
  })

  it('keeps a constraint that filters on the foreign key and orders the candidates', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer().nullable(),
    })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }])
    await db.table(posts).insert([
      { id: 10, userId: 1, title: 'Post A', score: 9 },
      { id: 11, userId: 1, title: 'Post B', score: 3 },
      { id: 12, userId: 2, title: 'Post C', score: 5 },
    ])

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        topScoringPost: scopeRelation(
          latestOfMany(() => Post, 'userId', 'id', 'score'),
          query => query.where('userId', '=', 1).orderBy('id', 'desc'),
        ),
      },
    })

    const loaded = await User.with('topScoringPost').orderBy('id').get()
    expect(loaded[0]?.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title')).toBe('Post A')
    expect(loaded[1]?.getRelation('topScoringPost')).toBeNull()
  })

  it('loads only the columns a relation constraint selects', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', {
      id: column.id(),
      userId: column.integer(),
      title: column.string(),
      score: column.integer().nullable(),
    })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }])
    await db.table(posts).insert([{ id: 10, userId: 1, title: 'Post A', score: 9 }])

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        topScoringPost: latestOfMany(() => Post, 'userId', 'id', 'score'),
      },
    })

    const [user] = await User.with({ topScoringPost: query => query.select('id', 'userId') }).get()
    const loaded = user!.getRelation<Entity<TableDefinition>>('topScoringPost')!
    expect(Object.keys(loaded.toAttributes()).sort()).toEqual(['id', 'userId'])
  })

  it('applies a one-of-many offset once, to the outer eager query', async () => {
    const db = openSQLite()
    const users = defineTable('users', { id: column.id(), name: column.string() })
    const posts = defineTable('posts', { id: column.id(), userId: column.integer(), title: column.string() })
    await createTestTable(db, users)
    await createTestTable(db, posts)
    await db.table(users).insert([{ id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }, { id: 3, name: 'Salma' }])
    await db.table(posts).insert([
      { id: 10, userId: 1, title: 'Post A' },
      { id: 11, userId: 2, title: 'Post B' },
      { id: 12, userId: 3, title: 'Post C' },
    ])

    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        latestPost: latestOfMany(() => Post, 'userId'),
      },
    })

    const loaded = await User.with('latestPost', query => query.orderBy('id').offset(1).limit(10)).orderBy('id').get()

    expect(loaded.map(user => user.getRelation<Entity<TableDefinition>>('latestPost')?.get('title') ?? null))
      .toEqual([null, 'Post B', 'Post C'])
  })

  it('applies a limit to the whole eager load across key chunks', async () => {
    const User = await seedUsersWithOnePostEach(300)
    const loaded = await User.with('posts', query => query.orderBy('id').limit(5)).get()

    expect(postIdsAcross(loaded)).toEqual([1, 2, 3, 4, 5])
  })

  it('applies an offset to the whole eager load across key chunks', async () => {
    const User = await seedUsersWithOnePostEach(300)
    const loaded = await User.with('posts', query => query.orderBy('id').offset(290).limit(1000)).get()

    expect(postIdsAcross(loaded)).toEqual([291, 292, 293, 294, 295, 296, 297, 298, 299, 300])
  })
})

async function seedUsersWithOnePostEach(count: number) {
  const db = openSQLite()
  const users = defineTable('users', { id: column.id(), name: column.string() })
  const posts = defineTable('posts', { id: column.id(), userId: column.integer(), title: column.string() })
  await createTestTable(db, users)
  await createTestTable(db, posts)
  const userRows = Array.from({ length: count }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` }))
  for (let index = 0; index < userRows.length; index += 100) {
    await db.table(users).insert(userRows.slice(index, index + 100))
    await db.table(posts).insert(userRows.slice(index, index + 100).map(user => ({ id: user.id, userId: user.id, title: `post ${user.id}` })))
  }

  const Post = defineModelFromTable(posts)
  return defineModelFromTable(users, {
    relations: {
      posts: hasMany(() => Post, 'userId'),
    },
  })
}

function postIdsAcross(users: readonly { getRelation<T>(name: string): T }[]): number[] {
  return users
    .flatMap(user => user.getRelation<Entity<TableDefinition>[]>('posts') ?? [])
    .map(post => post.get('id') as number)
    .sort((left, right) => left - right)
}
