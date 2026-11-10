import { randomUUID } from 'node:crypto'
import { clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, hasMany, hasManyThrough, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { integrationDrivers, mysqlTestConnection, postgresTestConnection, type TestDriver } from '../../../tests/support/real-database'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery, type RealtimeDatabaseContext } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Database = Pick<RealtimeDatabaseContext, 'model' | 'table'>
type Post = { id: number, title: string }

function createAdapter(driver: TestDriver): DriverAdapter {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: ':memory:' })
  }

  if (driver === 'postgres') {
    return createPostgresAdapter({ config: postgresTestConnection() })
  }

  return createMySQLAdapter({ config: mysqlTestConnection() })
}

async function createPosts(driver: TestDriver) {
  const adapter = createAdapter(driver)
  const tableName = `posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  let queryReads = 0
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main', security: { debugSqlInLogs: true }, logger: { onQuerySuccess: event => { if (event.kind === 'query' && event.sql?.startsWith('SELECT ') && [tableName, ...extraTables].some(table => event.sql!.includes(table))) queryReads += 1 } } })
  const extraTables: string[] = []
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    resetDB()
    clearGeneratedTables()
    for (const table of [tableName, ...extraTables]) {
      await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
    }
    await adapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, title VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${tableName} (id, title) VALUES (1, 'First'), (2, 'Second')`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { adapter, db, extraTables, tableName, queryReads: () => queryReads }
}

const transforms: ReadonlyArray<readonly [string, (db: Database, tableName: string) => Promise<unknown>]> = [
  ['derived total beside get()', async (db, tableName) => {
    const posts = await db.table(tableName).select('id', 'title').orderBy('id').get()
    return { posts, total: posts.length }
  }],
  ['count() clamped at its initial value', async (db, tableName) => Math.max(await db.table(tableName).count(), 2)],
  ['count() doubled from zero', async (db, tableName) => (await db.table(tableName).where('id', '>', 2).count()) * 2],
  ['first() conditionally returned by content', async (db, tableName) => {
    const post = await db.table(tableName).select('id', 'title').orderBy('id').first() as Post | undefined
    return post?.title === 'First' ? post : null
  }],
  ['get() filtered in place without initially removing rows', async (db, tableName) => {
    const posts = await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]
    posts.splice(0, posts.length, ...posts.filter(post => post.id !== 3))
    return posts
  }],
  ['first() ?? null', async (db, tableName) => (await db.table(tableName).select('id', 'title').orderBy('id').first()) ?? null],
  ['find() ?? null', async (db, tableName) => (await db.table(tableName).select('id', 'title').find(1)) ?? null],
  ['nested first() ?? null', async (db, tableName) => ({ post: (await db.table(tableName).select('id', 'title').orderBy('id').first()) ?? null })],
  ['a mapped get()', async (db, tableName) => (await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]).map(post => ({ id: post.id, title: post.title.toUpperCase() }))],
  ['a filtered get()', async (db, tableName) => (await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]).filter(post => post.id !== 3)],
  ['a nested mapped get()', async (db, tableName) => ({ posts: (await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]).map(post => ({ id: post.id, title: post.title.toUpperCase() })) })],
  ['get() or null when empty', async (db, tableName) => {
    const posts = await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]
    return posts.length > 0 ? posts : null
  }],
  ['a reversed get()', async (db, tableName) => (await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]).reverse()],
  ['a sorted get()', async (db, tableName) => (await db.table(tableName).select('id', 'title').orderBy('id').get() as Post[]).sort((left, right) => right.id - left.id)],
  ['find() next to a transformed find()', async (db, tableName) => {
    const first = await db.table(tableName).select('id', 'title').find(1) as Post | undefined
    const second = await db.table(tableName).select('id', 'title').find(2) as Post | undefined
    return [first ?? null, second ? second.title.toUpperCase() : null]
  }],
  ['get() with a column deleted in place', async (db, tableName) => {
    const posts = await db.table(tableName).select('id', 'title').orderBy('id').get() as Array<Partial<Post>>
    for (const post of posts) delete post.title
    return posts
  }],
  ['first() with a column rewritten in place', async (db, tableName) => {
    const post = await db.table(tableName).select('id', 'title').orderBy('id').first() as Post | undefined
    if (post) post.title = post.title.toUpperCase()
    return post ?? null
  }],
  ['count() + 1', async (db, tableName) => (await db.table(tableName).count()) + 1],
  ['count() * 2 + 1', async (db, tableName) => (await db.table(tableName).count()) * 2 + 1],
  ['nested count() + 1', async (db, tableName) => ({ total: (await db.table(tableName).count()) + 1 })],
]

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a handler that transforms its query result on %s', (driver) => {
  it('refreshes valid Date results after a subscriber changes the previous Date getter', async () => {
    const { db, tableName } = await createPosts(driver)
    const handler = async () => {
      const total = (await db.table(tableName).count()) * 2
      return { stamp: new Date(1_700_000_000_000 + total), total }
    }
    const deliveries: Awaited<ReturnType<typeof handler>>[] = []
    const errors: unknown[] = []
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { deliveries.push(snapshot.data) },
      onError: error => { errors.push(error) },
    })
    Object.defineProperty(subscription.current.data.stamp, 'getTime', { get() { throw new Error('Subscriber Date getter') } })
    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table(tableName).insert({ id: 3, title: 'Third' }),
    }))
    const fresh = await handler()
    expect(errors).toEqual([])
    expect(deliveries.map(data => data.total)).toEqual([4, 6])
    expect(subscription.current.data).toEqual(fresh)
    expect(deliveries.at(-1)).toEqual(fresh)
  })

  it('preserves an undefined array item when native ordering moves it', async () => {
    const { db, tableName } = await createPosts(driver)
    const handler = async () => (await db.table(tableName).orderBy('title').get() as Post[]).map(post => post.id === 1 ? undefined : post.title)
    const deliveries: unknown[] = []
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: snapshot => { deliveries.push(snapshot.data) },
      onError: error => { throw error },
    })
    expect(deliveries).toEqual([[undefined, 'Second']])
    await executeRealtimeMutation(defineRealtimeMutation({
      access: 'public',
      handler: () => db.table(tableName).where('id', 1).update({ title: 'Third' }),
    }))
    const fresh = await handler()
    expect(fresh).toEqual(['Second', undefined])
    expect(subscription.current.data).toEqual(fresh)
    expect(deliveries).toEqual([[undefined, 'Second'], fresh])
  })

  it.each(transforms)('keeps %s equal to a fresh handler run', async (_label, transform) => {
    const { db, tableName } = await createPosts(driver)
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => transform(db, tableName) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
    const expectFresh = async () => {
      expect(subscription.current.data).toEqual(await transform(db, tableName))
    }

    await expectFresh()
    await mutate(db => db.table(tableName).insert({ id: 3, title: 'Third' }))
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 1).update({ title: 'Renamed' }))
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 2).update({ title: 'Changed' }))
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 1).delete())
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 2).delete())
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 3).delete())
    await expectFresh()
    await mutate(db => db.table(tableName).insert({ id: 4, title: 'Fourth' }))
    await expectFresh()
  })

  it('keeps value() ?? null on a nullable column equal to a fresh handler run', async () => {
    const { adapter, db, tableName } = await createPosts(driver)
    await adapter.execute(`ALTER TABLE ${tableName} ADD COLUMN subtitle VARCHAR(64)`)
    const transform = async (database: Database) => (await database.table(tableName).where('id', 1).value('subtitle')) ?? null
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => transform(db) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))

    expect(subscription.current.data).toBeNull()
    await mutate(db => db.table(tableName).where('id', 1).update({ title: 'Renamed' }))
    expect(subscription.current.data).toEqual(await transform(db))
    await mutate(db => db.table(tableName).where('id', 1).delete())
    expect(subscription.current.data).toEqual(await transform(db))
    await mutate(db => db.table(tableName).insert({ id: 1, title: 'Again', subtitle: 'Sub' }))
    expect(subscription.current.data).toEqual(await transform(db))
  })

  it('skips the handler re-run for writes whose rows contradict every predicate of an unbound count', async () => {
    const { db, tableName } = await createPosts(driver)
    let handlerRuns = 0
    const handler = async () => {
      handlerRuns += 1
      return (await db.table(tableName).where('id', '>', 2).count()) * 2
    }
    const subscription = await subscribeRealtimeQuery(defineRealtimeQuery({ access: 'public', handler }), {}, {
      onData: () => {},
      onError: (error) => { throw error },
    })
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))

    await mutate(db => db.table(tableName).insert({ id: 3, title: 'Third' }))
    expect(handlerRuns).toBe(2)
    expect(subscription.current.data).toBe(2)

    await mutate(db => db.table(tableName).where('id', 1).delete())
    await mutate(db => db.table(tableName).insert({ id: 0, title: 'Zero' }))
    expect(handlerRuns).toBe(2)
    expect(subscription.current.data).toBe(2)
    expect(subscription.current.data).toEqual(await handler())
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('an eager-loaded hasManyThrough relation on %s', (driver) => {
  it('follows writes to its related table to a fresh read instead of patching them into the root rows', async () => {
    const { adapter, db, extraTables, tableName: postsTable } = await createPosts(driver)
    const suffix = postsTable.slice('posts_'.length)
    const countriesTable = `countries_${suffix}`
    const usersTable = `users_${suffix}`
    extraTables.push(countriesTable, usersTable)
    await adapter.execute(`CREATE TABLE ${countriesTable} (id INTEGER PRIMARY KEY, title VARCHAR(64) NOT NULL)`)
    await adapter.execute(`CREATE TABLE ${usersTable} (id INTEGER PRIMARY KEY, country_id INTEGER NOT NULL)`)
    await adapter.execute(`ALTER TABLE ${postsTable} ADD COLUMN user_id INTEGER`)
    await adapter.execute(`INSERT INTO ${countriesTable} (id, title) VALUES (1, 'Country'), (2, 'Other')`)
    await adapter.execute(`INSERT INTO ${usersTable} (id, country_id) VALUES (1, 1), (2, 2)`)
    await adapter.execute(`UPDATE ${postsTable} SET user_id = id`)
    const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), title: column.string(), user_id: column.integer().nullable() }), { timestamps: false })
    const User = defineModel(defineGeneratedTable(usersTable, { id: column.integer().primaryKey(), country_id: column.integer() }), { timestamps: false })
    const Country = defineModel(defineGeneratedTable(countriesTable, { id: column.integer().primaryKey(), title: column.string() }), {
      timestamps: false,
      relations: { posts: hasManyThrough(() => Post, () => User, 'country_id', 'user_id') },
    })
    const read = async () => JSON.parse(JSON.stringify(await db.model(Country).query().with('posts').orderBy('id').get())) as unknown
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => db.model(Country).query().with('posts').orderBy('id').get() }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
    const expectFresh = async () => {
      expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(await read())
    }

    await expectFresh()
    await mutate(db => db.table(postsTable).where('id', 1).update({ title: 'Renamed' }))
    await expectFresh()
    await mutate(db => db.table(postsTable).insert({ id: 3, title: 'Third', user_id: 1 }))
    await expectFresh()
    await mutate(db => db.table(postsTable).where('id', 2).delete())
    await expectFresh()
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a handler that changes a model collection on %s', (driver) => {
  const createPostModel = (tableName: string) => defineModel(defineGeneratedTable(tableName, { id: column.integer().primaryKey(), title: column.string() }), { timestamps: false, fillable: ['title'] })
  const readers: ReadonlyArray<readonly [string, (database: Database, Post: ReturnType<typeof createPostModel>) => Promise<unknown>]> = [
    ['assigns a custom toJSON redaction', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      for (const post of posts) Object.defineProperty(post, 'toJSON', { value: () => ({ id: post.id }), configurable: true })
      return posts
    }],
    ['deletes a column from toJSON() rows', async (database, Post) => {
      const posts = (await database.model(Post).query().orderBy('id').get()).toJSON() as Array<Partial<Post>>
      for (const post of posts) delete post.title
      return posts
    }],
    ['reverses the collection before toJSON()', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      posts.reverse()
      return posts.toJSON()
    }],
    ['serializes the collection twice', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      return { first: posts.toJSON(), second: posts.toJSON() }
    }],
    ['returns toJSON() rows next to their collection', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      return { rows: posts.toJSON(), models: posts }
    }],
    ['returns toJSON() rows next to one of their models', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      return { rows: posts.toJSON(), first: posts[0] }
    }],
    ['returns toJSON() rows next to a model it then removes', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      const rows = posts.toJSON()
      return { rows, last: posts.pop() ?? null }
    }],
    ['sets an attribute on each model', async (database, Post) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      for (const post of posts) post.set('title', String(post.title).toUpperCase())
      return posts
    }],
  ]

  it.each(readers)('keeps a handler that %s equal to a fresh handler run', async (_label, reader) => {
    const { db, tableName } = await createPosts(driver)
    const Post = createPostModel(tableName)
    const read = (database: Database) => reader(database, Post)
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => read(db) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
    const expectFresh = async () => {
      expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(JSON.parse(JSON.stringify(await read(db))))
    }

    await mutate(db => db.table(tableName).where('id', 1).update({ title: 'Secret' }))
    await expectFresh()
    await mutate(db => db.table(tableName).insert({ id: 3, title: 'Also secret' }))
    await expectFresh()
    await mutate(db => db.table(tableName).where('id', 2).delete())
    await expectFresh()
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a lazily loaded relation on %s', (driver) => {
  it('follows root inserts and related writes to a fresh read on loaded collections and records', async () => {
    const { adapter, db, extraTables, tableName: postsTable } = await createPosts(driver)
    const commentsTable = `comments_${postsTable.slice('posts_'.length)}`
    extraTables.push(commentsTable)
    await adapter.execute(`CREATE TABLE ${commentsTable} (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, body VARCHAR(64) NOT NULL)`)
    await adapter.execute(`INSERT INTO ${commentsTable} (id, post_id, body) VALUES (1, 1, 'On first'), (2, 2, 'On second')`)
    const Comment = defineModel(defineGeneratedTable(commentsTable, { id: column.integer().primaryKey(), post_id: column.integer(), body: column.string() }), { timestamps: false })
    const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), title: column.string() }), {
      timestamps: false,
      relations: { comments: hasMany(() => Comment, 'post_id') },
    })
    const read = async (database: Database) => {
      const posts = await database.model(Post).query().orderBy('id').get()
      return await posts.load('comments')
    }
    const readFirst = async (database: Database) => {
      const post = await database.model(Post).query().orderBy('id', 'desc').first()
      return post ? await post.load('comments') : null
    }
    const firstSubscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => readFirst(db) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => read(db) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
    const expectFresh = async () => {
      expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(JSON.parse(JSON.stringify(await read(db))))
      expect(JSON.parse(JSON.stringify(firstSubscription.current.data))).toEqual(JSON.parse(JSON.stringify(await readFirst(db))))
    }

    await expectFresh()
    await mutate(db => db.table(postsTable).insert({ id: 3, title: 'Third' }))
    await expectFresh()
    await mutate(db => db.table(commentsTable).insert({ id: 3, post_id: 3, body: 'On third' }))
    await expectFresh()
    await mutate(db => db.table(commentsTable).where('id', 1).update({ body: 'Edited' }))
    await expectFresh()
    await mutate(db => db.table(postsTable).where('id', 2).delete())
    await expectFresh()
  })
})

async function createRelatedPosts(driver: TestDriver) {
  const { adapter, db, extraTables, tableName: postsTable, queryReads } = await createPosts(driver)
  const commentsTable = `comments_${postsTable.slice('posts_'.length)}`
  extraTables.push(commentsTable)
  await adapter.execute(`CREATE TABLE ${commentsTable} (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, body VARCHAR(64) NOT NULL)`)
  await adapter.execute(`INSERT INTO ${commentsTable} (id, post_id, body) VALUES (1, 1, 'On first'), (2, 2, 'On second')`)
  const commentTable = defineGeneratedTable(commentsTable, { id: column.integer().primaryKey(), post_id: column.integer(), body: column.string() })
  const Comment = defineModel(commentTable, { timestamps: false })
  const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), title: column.string() }), {
    timestamps: false,
    relations: { comments: hasMany(() => Comment, 'post_id') },
  })
  return { adapter, db, extraTables, Post, postsTable, commentsTable, commentTable, queryReads }
}

const relationTransforms: ReadonlyArray<readonly [string, (posts: Array<Record<string, unknown>>) => unknown]> = [
  ['wrapped', posts => ({ posts, total: posts.length })],
  ['filtered', posts => posts.filter(post => post.id !== 2)],
  ['reversed', posts => posts.reverse()],
]

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a handler that transforms related root results on %s', (driver) => {
  it.each(relationTransforms)('keeps %s results equal to a fresh handler run after root and relation writes', async (_label, transform) => {
    const { db, Post, postsTable, commentsTable, queryReads } = await createRelatedPosts(driver)
    let handlerRuns = 0
    const read = async (database: Database) => {
      const before = queryReads()
      const posts = await database.model(Post).query().with('comments').orderBy('id').get()
      expect(queryReads() - before).toBe(2)
      return transform(posts)
    }
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => { handlerRuns += 1; return read(db) } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = async (mutation: (db: Database) => Promise<unknown>) => {
      const before = handlerRuns
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
      expect(handlerRuns).toBe(before + 1)
    }
    const expectFresh = async () => expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(JSON.parse(JSON.stringify(await read(db))))
    await expectFresh()
    await mutate(db => db.table(commentsTable).where('id', 1).update({ body: 'Edited' }))
    await expectFresh()
    await mutate(db => db.table(commentsTable).insert({ id: 3, post_id: 1, body: 'New' }))
    await expectFresh()
    await mutate(db => db.table(commentsTable).where('id', 2).delete())
    await expectFresh()
    await mutate(db => db.table(postsTable).insert({ id: 3, title: 'Secret' }))
    await expectFresh()
    await mutate(db => db.table(postsTable).where('id', 1).update({ title: 'Changed' }))
    await expectFresh()
    await mutate(db => db.table(postsTable).where('id', 2).delete())
    await expectFresh()
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('an unbound count with an update outside its predicates on %s', (driver) => {
  it('skips the handler re-run for an update of other columns on rows outside every predicate', async () => {
    const { db, tableName } = await createPosts(driver)
    let handlerRuns = 0
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({
        access: 'public',
        handler: async () => {
          handlerRuns += 1
          return (await db.table(tableName).where('id', '>', 2).count()) * 2
        },
      }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))

    await mutate(db => db.table(tableName).insert({ id: 3, title: 'Third' }))
    expect(handlerRuns).toBe(2)

    await mutate(db => db.table(tableName).where('id', 1).update({ title: 'Renamed' }))
    expect(handlerRuns).toBe(2)
    expect(subscription.current.data).toBe(2)
  })
})
