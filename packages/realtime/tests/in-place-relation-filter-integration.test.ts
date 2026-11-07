import { randomUUID } from 'node:crypto'
import { belongsToMany, clearGeneratedTables, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, hasMany, resetDB, resetDatabaseDependencyInvalidationListeners, type DriverAdapter } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { createPostgresAdapter } from '../../db-postgres/src'
import { createSQLiteAdapter } from '../../db-sqlite/src'
import { integrationDrivers, mysqlTestConnection, postgresTestConnection, type TestDriver } from '../../../tests/support/real-database'
import { describe, expect, it, onTestFinished } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery, type RealtimeDatabaseContext } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

type Database = Pick<RealtimeDatabaseContext, 'model' | 'table'>
type Row = { secret: boolean | number }

function createAdapter(driver: TestDriver): DriverAdapter {
  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: ':memory:' })
  }

  if (driver === 'postgres') {
    return createPostgresAdapter({ config: postgresTestConnection() })
  }

  return createMySQLAdapter({ config: mysqlTestConnection() })
}

async function openPosts(driver: TestDriver) {
  const adapter = createAdapter(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const postsTable = `posts_${suffix}`
  const commentsTable = `comments_${suffix}`
  const tagsTable = `tags_${suffix}`
  const pivotTable = `post_tag_${suffix}`
  const db = createDatabase({ adapter, dialect: createDialect(driver), connectionName: 'main' })
  await adapter.initialize()
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDatabaseDependencyInvalidationListeners()
    resetDB()
    clearGeneratedTables()
    for (const table of [pivotTable, tagsTable, commentsTable, postsTable]) {
      await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
    }
    await adapter.disconnect()
  })
  await adapter.execute(`CREATE TABLE ${postsTable} (id INTEGER PRIMARY KEY, title VARCHAR(64) NOT NULL)`)
  await adapter.execute(`CREATE TABLE ${commentsTable} (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, body VARCHAR(64) NOT NULL, secret INTEGER NOT NULL)`)
  await adapter.execute(`CREATE TABLE ${tagsTable} (id INTEGER PRIMARY KEY, name VARCHAR(64) NOT NULL, secret INTEGER NOT NULL)`)
  await adapter.execute(`CREATE TABLE ${pivotTable} (post_id INTEGER NOT NULL, tag_id INTEGER NOT NULL)`)
  await adapter.execute(`INSERT INTO ${postsTable} (id, title) VALUES (1, 'First'), (2, 'Second')`)
  await adapter.execute(`INSERT INTO ${commentsTable} (id, post_id, body, secret) VALUES (1, 1, 'Public', 0), (2, 2, 'Also public', 0), (3, 3, 'Hidden elsewhere', 1)`)
  await adapter.execute(`INSERT INTO ${tagsTable} (id, name, secret) VALUES (1, 'public', 0), (2, 'Hidden tag', 1)`)
  await adapter.execute(`INSERT INTO ${pivotTable} (post_id, tag_id) VALUES (1, 1)`)
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Comment = defineModel(defineGeneratedTable(commentsTable, { id: column.integer().primaryKey(), post_id: column.integer(), body: column.string(), secret: column.integer() }), { timestamps: false })
  const Tag = defineModel(defineGeneratedTable(tagsTable, { id: column.integer().primaryKey(), name: column.string(), secret: column.integer() }), { timestamps: false })
  const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), title: column.string() }), {
    timestamps: false,
    relations: {
      comments: hasMany(() => Comment, 'post_id'),
      tags: belongsToMany(() => Tag, pivotTable, 'post_id', 'tag_id'),
    },
  })
  return { db, Post, commentsTable, tagsTable, pivotTable }
}

type Posts = Awaited<ReturnType<typeof openPosts>>['Post']

function withoutSecrets(rows: Row[]): void {
  rows.splice(0, rows.length, ...rows.filter(row => !row.secret))
}

const readers: ReadonlyArray<readonly [string, 'comments' | 'tags', (database: Database, Post: Posts) => Promise<unknown>]> = [
  ['model hasMany', 'comments', async (database, Post) => {
    const posts = await database.model(Post).query().with('comments').orderBy('id').get()
    for (const post of posts) withoutSecrets(post.comments as unknown as Row[])
    return posts
  }],
  ['JSON hasMany', 'comments', async (database, Post) => {
    const posts = await database.model(Post).query().with('comments').orderBy('id').getJson() as Array<{ comments: Row[] }>
    for (const post of posts) withoutSecrets(post.comments)
    return posts
  }],
  ['model belongsToMany', 'tags', async (database, Post) => {
    const posts = await database.model(Post).query().with('tags').orderBy('id').get()
    for (const post of posts) withoutSecrets(post.tags as unknown as Row[])
    return posts
  }],
  ['JSON belongsToMany', 'tags', async (database, Post) => {
    const posts = await database.model(Post).query().with('tags').orderBy('id').getJson() as Array<{ tags: Row[] }>
    for (const post of posts) withoutSecrets(post.tags)
    return posts
  }],
]

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('a handler that filters an eager-loaded relation in place on %s', (driver) => {
  it.each(readers)('keeps rows the %s filter hides out of the snapshot after later writes', async (_label, relation, reader) => {
    const { db, Post, commentsTable, tagsTable, pivotTable } = await openPosts(driver)
    const read = (database: Database) => reader(database, Post)
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: ({ db }) => read(db) }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    const mutate = (mutation: (db: Database) => Promise<unknown>) => executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => mutation(db) }))
    const expectFresh = async () => {
      const snapshot = JSON.parse(JSON.stringify(subscription.current.data)) as unknown
      expect(JSON.stringify(snapshot)).not.toContain('Hidden')
      expect(snapshot).toEqual(JSON.parse(JSON.stringify(await read(db))))
    }
    const writes: ReadonlyArray<(db: Database) => Promise<unknown>> = relation === 'comments'
      ? [
          db => db.table(commentsTable).where('id', 1).update({ body: 'Hidden', secret: 1 }),
          db => db.table(commentsTable).where('id', 3).update({ post_id: 2 }),
          db => db.table(commentsTable).insert({ id: 4, post_id: 1, body: 'Hidden too', secret: 1 }),
        ]
      : [
          db => db.table(tagsTable).where('id', 1).update({ name: 'Hidden', secret: 1 }),
          db => db.table(pivotTable).insert({ post_id: 2, tag_id: 2 }),
        ]

    await expectFresh()
    for (const write of writes) {
      await mutate(write)
      await expectFresh()
    }
  })
})
