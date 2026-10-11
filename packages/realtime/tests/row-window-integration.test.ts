import { belongsTo, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const adapter = createSQLiteAdapter({ filename: ':memory:' })
const rowCounts: Array<number | undefined> = []

beforeEach(async () => {
  await adapter.initialize()
  await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL)')
  await adapter.execute("INSERT INTO posts VALUES (1, 'First', 'Hidden'), (2, 'Second', 'Hidden'), (3, 'Third', 'Hidden'), (4, 'Fourth', 'Hidden'), (5, 'Fifth', 'Hidden')")
  rowCounts.length = 0
  const db = createDatabase({
    adapter,
    dialect: createDialect('sqlite'),
    connectionName: 'main',
    logger: { onQuerySuccess: entry => { if (entry.kind === 'query') rowCounts.push(entry.rowCount) } },
  })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
})

afterEach(async () => {
  resetRealtimeRuntime()
  resetDB()
  resetDatabaseDependencyInvalidationListeners()
  await adapter.disconnect()
})

it.each(['!=', 'not in'] as const)('removes null values from live rows filtered by %s and restores later matches', async (operator) => {
  await adapter.execute('CREATE TABLE scores (id INTEGER PRIMARY KEY, score INTEGER)')
  await adapter.execute('INSERT INTO scores VALUES (1, 10), (2, 20)')
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
    return db.table('scores').where('score', operator, operator === '!=' ? 5 : [5]).orderBy('id').get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  let score: number | null = null
  const mutation = defineRealtimeMutation({ access: 'public', handler: ({ db }) => {
    return db.table('scores').where('id', 1).update({ score })
  } })
  await executeRealtimeMutation(mutation)
  expect(snapshots.at(-1)).toEqual([{ id: 2, score: 20 }])
  score = 30
  await executeRealtimeMutation(mutation)
  expect(snapshots.at(-1)).toEqual([{ id: 1, score: 30 }, { id: 2, score: 20 }])
})

it('keeps null-containing exclusions empty when live rows change', async () => {
  await adapter.execute('CREATE TABLE scores (id INTEGER PRIMARY KEY, score INTEGER)')
  await adapter.execute('INSERT INTO scores VALUES (1, 5)')
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
    return db.table('scores').whereNotIn('score', [5, null]).get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => {
    return db.table('scores').where('id', 1).update({ score: 10 })
  } }))
  expect(snapshots.at(-1)).toEqual([])
})

it('preserves native string ordering in bounded live windows after updates and inserts', async () => {
  await adapter.execute('CREATE TABLE scores (id INTEGER PRIMARY KEY, score TEXT NOT NULL)')
  await adapter.execute("INSERT INTO scores VALUES (1, 'b'), (2, 'c'), (3, 'd')")
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
    return db.table('scores').orderBy('score').limit(2).get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => {
    return db.table('scores').where('id', 1).update({ score: 'Z' })
  } }))
  expect(snapshots.at(-1)).toEqual([{ id: 1, score: 'Z' }, { id: 2, score: 'c' }])
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => {
    return db.table('scores').insert({ id: 4, score: 'A' })
  } }))
  expect(snapshots.at(-1)).toEqual([{ id: 4, score: 'A' }, { id: 1, score: 'Z' }])
  expect(rowCounts.every(count => count !== undefined && count <= 2)).toBe(true)
})

it('keeps projected limited rows shared when hidden values change and patches visible values without a refill', async () => {
  let reads = 0
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return db.table('posts').select('id', 'title').orderBy('id').limit(2).get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 1).update({ body: 'Still hidden' })
  } }))
  expect(snapshots).toHaveLength(1)
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 2).update({ title: 'Updated' })
  } }))
  expect(snapshots).toEqual([
    [{ id: 1, title: 'First' }, { id: 2, title: 'Second' }],
    [{ id: 1, title: 'First' }, { id: 2, title: 'Updated' }],
  ])
  expect(snapshots[1]?.[0]).toBe(snapshots[0]?.[0])
  expect(reads).toBe(1)
  expect(rowCounts).toEqual([2, 1, 1])
})

it('patches stable offset rows locally and refills only after an ordering mutation moves the page', async () => {
  let reads = 0
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return db.table('posts').select('id', 'title').orderBy('id').offset(2).limit(2).get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 3).update({ title: 'Updated' })
  } }))
  expect(snapshots[1]?.[1]).toBe(snapshots[0]?.[1])
  expect(rowCounts).toEqual([2, 1])
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 1).update({ id: 6 })
  } }))
  expect(snapshots).toEqual([
    [{ id: 3, title: 'Third' }, { id: 4, title: 'Fourth' }],
    [{ id: 3, title: 'Updated' }, { id: 4, title: 'Fourth' }],
    [{ id: 4, title: 'Fourth' }, { id: 5, title: 'Fifth' }],
  ])
  expect(reads).toBe(1)
  expect(rowCounts).toEqual([2, 1, 1, 2])
})

it('preserves distinct projection semantics by rerunning an unsafe patch shape', async () => {
  let reads = 0
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return db.table('posts').select('title').distinct().orderBy('title').get()
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 1).update({ title: 'Second' })
  } }))
  expect(snapshots).toEqual([
    [{ title: 'Fifth' }, { title: 'First' }, { title: 'Fourth' }, { title: 'Second' }, { title: 'Third' }],
    [{ title: 'Fifth' }, { title: 'Fourth' }, { title: 'Second' }, { title: 'Third' }],
  ])
  expect(reads).toBe(2)
  expect(rowCounts).toEqual([5, 1, 4])
})

it('keeps hidden cursor values out of snapshots and shares unaffected projected rows', async () => {
  let reads = 0
  const snapshots: Array<{ readonly rows: readonly Readonly<Record<string, unknown>>[], readonly cursor: string | null }> = []
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return db.table('posts').select('id', 'title').orderBy('id', 'desc').cursorPaginate(2)
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push({ rows: snapshot.data.data, cursor: snapshot.data.nextCursor }) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 5).update({ body: 'Still hidden' })
  } }))
  expect(snapshots).toHaveLength(1)
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').where('id', 4).update({ title: 'Updated' })
  } }))
  expect(snapshots.map(snapshot => snapshot.rows)).toEqual([
    [{ id: 5, title: 'Fifth' }, { id: 4, title: 'Fourth' }],
    [{ id: 5, title: 'Fifth' }, { id: 4, title: 'Updated' }],
  ])
  expect(snapshots[1]?.rows[0]).toBe(snapshots[0]?.rows[0])
  expect(snapshots[1]?.cursor).toBe(snapshots[0]?.cursor)
  expect(reads).toBe(1)
  expect(rowCounts).toEqual([3, 1, 1])
})

it('retains eager-loaded relations when cursor inserts project their visible fields', async () => {
  await adapter.execute('CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
  await adapter.execute("INSERT INTO authors VALUES (1, 'Ada')")
  await adapter.execute('ALTER TABLE posts ADD COLUMN author_id INTEGER DEFAULT 1')
  const Author = defineModel(defineGeneratedTable('authors', { id: column.id(), name: column.string() }), { timestamps: false })
  const Post = defineModel(defineGeneratedTable('posts', { id: column.id(), title: column.string(), body: column.string(), author_id: column.integer() }), {
    timestamps: false,
    relations: { author: belongsTo(() => Author, 'author_id') },
  })
  const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
  let reads = 0
  const query = defineRealtimeQuery({ access: 'public', handler: async ({ db }) => {
    reads += 1
    return db.model(Post).query().select('id', 'title', 'author_id').with('author').orderBy('id', 'desc').cursorPaginateJson(2)
  } })
  await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data.data) }, onError: error => { throw error } })
  await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: async ({ db }) => {
    await db.table('posts').insert({ id: 6, title: 'Sixth', body: 'Hidden', author_id: 1 })
  } }))
  expect(snapshots).toEqual([
    [{ id: 5, title: 'Fifth', author_id: 1, author: { id: 1, name: 'Ada' } }, { id: 4, title: 'Fourth', author_id: 1, author: { id: 1, name: 'Ada' } }],
    [{ id: 6, title: 'Sixth', author_id: 1, author: { id: 1, name: 'Ada' } }, { id: 5, title: 'Fifth', author_id: 1, author: { id: 1, name: 'Ada' } }],
  ])
  expect(reads).toBe(1)
  expect(rowCounts).toEqual([3, 1, 1])
})
