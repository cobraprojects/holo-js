import { randomUUID } from 'node:crypto'
import { column, defineGeneratedTable, defineModel, hasOne } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres'] as const)

type Driver = typeof drivers[number]

async function openQualifiedDatabase(driver: Driver) {
  const statements: string[] = []
  const { db, schema } = await openDatabase(driver, {
    security: { debugSqlInLogs: true },
    logger: { onQuerySuccess: (entry) => { if (entry.sql) statements.push(entry.sql) } },
  })
  const namespace = driver === 'sqlite' ? 'archive' : `holo_live_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  if (driver === 'sqlite') {
    await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
  } else {
    await db.executeCompiled({ sql: `CREATE SCHEMA "${namespace}"`, source: 'schema' })
    onTestFinished(async () => {
      await db.executeCompiled({ sql: `DROP SCHEMA "${namespace}" CASCADE`, source: 'schema' })
    })
  }
  onTestFinished(() => resetRealtimeRuntime())
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  return { db, schema, namespace, statements }
}

describe.each(drivers)('realtime on schema-qualified tables on %s', (driver) => {
  it.each([
    ['unqualified', (_table: string, column: string) => column],
    ['table-qualified', (table: string, column: string) => `${table.slice(table.indexOf('.') + 1)}.${column}`],
    ['schema-qualified', (table: string, column: string) => `${table}.${column}`],
  ] as const)('backfills offset windows of grouped subscriptions from a schema-qualified table with %s columns', async (_label, qualify) => {
    const { db, schema, namespace, statements } = await openQualifiedDatabase(driver)
    const tableName = `${namespace}.records`
    await schema.createTable(tableName, (table) => {
      table.integer('id').primaryKey()
      table.integer('group_id')
      table.integer('score')
    })
    const records = defineGeneratedTable(tableName, { id: column.integer().primaryKey(), group_id: column.integer(), score: column.integer() })
    await db.table(records).insert([
      { id: 1, group_id: 1, score: 10 },
      { id: 2, group_id: 2, score: 20 },
      { id: 3, group_id: 1, score: 30 },
      { id: 4, group_id: 2, score: 40 },
      { id: 5, group_id: 1, score: 50 },
      { id: 6, group_id: 2, score: 60 },
      { id: 7, group_id: 1, score: 70 },
      { id: 8, group_id: 2, score: 80 },
    ])
    const read = (group: number) => db.table(tableName).where(qualify(tableName, 'group_id'), group).select(qualify(tableName, 'id'), qualify(tableName, 'score')).orderBy(qualify(tableName, 'id')).offset(1).limit(2).get()
    let reads = 0
    const subscriptions = await Promise.all([1, 2].map(group => subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => {
        reads += 1
        return read(group)
      } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )))

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(records).whereIn('id', [3, 4]).delete() }))

    expect(subscriptions.map(subscription => subscription.current.data)).toEqual([
      [{ id: 5, score: 50 }, { id: 7, score: 70 }],
      [{ id: 6, score: 60 }, { id: 8, score: 80 }],
    ])
    expect(subscriptions.map(subscription => subscription.current.data)).toEqual(await Promise.all([read(1), read(2)]))
    expect(reads).toBe(2)
    expect(statements.some(sql => sql.includes('ROW_NUMBER() OVER') && sql.includes(`FROM "${namespace}"."records"`))).toBe(true)
  })

  it.each([
    ['unqualified', (_table: string, column: string) => column],
    ['table-qualified', (table: string, column: string) => `${table.slice(table.indexOf('.') + 1)}.${column}`],
    ['schema-qualified', (table: string, column: string) => `${table}.${column}`],
  ] as const)('hydrates the ordered has-one relation of inserted rows from a schema-qualified table with %s columns', async (_label, qualify) => {
    const { db, schema, namespace, statements } = await openQualifiedDatabase(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const postsName = `holo_live_posts_${suffix}`
    const postsTable = `${namespace}.${postsName}`
    const authorsTable = `holo_live_authors_${suffix}`
    await schema.createTable(authorsTable, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    onTestFinished(() => schema.dropTable(authorsTable))
    await schema.createTable(postsTable, (table) => {
      table.integer('id').primaryKey()
      table.integer('author_id')
      table.integer('score')
    })
    const Post = defineModel(defineGeneratedTable(postsTable, { id: column.integer().primaryKey(), author_id: column.integer(), score: column.integer() }), { timestamps: false })
    const Author = defineModel(defineGeneratedTable(authorsTable, { id: column.integer().primaryKey(), name: column.string() }), {
      timestamps: false,
      relations: { topPost: hasOne(() => Post, 'author_id') },
    })
    await db.table(postsTable).insert([
      { id: 1, author_id: 1, score: 10 },
      { id: 2, author_id: 1, score: 30 },
      { id: 3, author_id: 2, score: 50 },
      { id: 4, author_id: 2, score: 20 },
    ])
    const read = () => db.model(Author).query().with('topPost', query => query.where(qualify(postsTable, 'score'), '>', 0).orderBy(qualify(postsTable, 'score'), 'desc')).orderBy('id').get()
    let reads = 0
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler: () => {
        reads += 1
        return read()
      } }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )

    await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: () => db.table(authorsTable).insert([
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ]) }))

    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual([
      { id: 1, name: 'Ada', topPost: { id: 2, author_id: 1, score: 30 } },
      { id: 2, name: 'Grace', topPost: { id: 3, author_id: 2, score: 50 } },
    ])
    expect(JSON.parse(JSON.stringify(subscription.current.data))).toEqual(JSON.parse(JSON.stringify(await read())))
    expect(reads).toBe(1)
    expect(statements.some(sql => sql.includes('ROW_NUMBER() OVER') && sql.includes(`FROM "${namespace}"."${postsName}"`))).toBe(true)
  })
})
