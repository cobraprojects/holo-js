import { column, createDatabase, createDialect, defineGeneratedTable, defineModel, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

afterEach(() => {
  resetRealtimeRuntime()
  resetDatabaseDependencyInvalidationListeners()
})

it.each(['table', 'model', 'json'] as const)('updates bounded %s page windows and their totals after deletions', async family => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  try {
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await adapter.execute("INSERT INTO posts VALUES (1, 'First'), (2, 'Second'), (3, 'Third'), (4, 'Fourth'), (5, 'Fifth'), (6, 'Sixth')")
    const rowCounts: Array<number | undefined> = []
    const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main', logger: { onQuerySuccess: entry => { if (entry.kind === 'query') rowCounts.push(entry.rowCount) } } })
    const Post = defineModel(defineGeneratedTable('posts', { id: column.id(), title: column.string() }), { timestamps: false })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let reads = 0
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db: context }) => {
      reads += 1
      if (family === 'table') return context.table('posts').orderBy('id', 'desc').paginate(2, 2)
      const builder = context.model(Post).query().orderBy('id', 'desc')
      return family === 'json' ? builder.paginateJson(2, 2) : builder.paginate(2, 2)
    } })
    const mutation = defineRealtimeMutation({ access: 'public', handler: async ({ db: context }) => {
      await context.table('posts').where('id', 6).delete()
    } })
    const snapshots: Array<{ ids: readonly unknown[], total: number }> = []
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push({ ids: snapshot.data.data.map(row => row.id), total: snapshot.data.meta.total }) }, onError: error => { throw error } })
    expect(rowCounts).toEqual([1, 2])
    await executeRealtimeMutation(mutation)
    expect(snapshots).toEqual([{ ids: [4, 3], total: 6 }, { ids: [3, 2], total: 5 }])
    expect(reads).toBe(1)
    expect(rowCounts.every(count => count !== undefined && count <= 2)).toBe(true)
  } finally {
    await adapter.disconnect()
  }
})

it.each(['table', 'model', 'json'] as const)('refreshes bounded %s simple windows when deletions change the lookahead', async family => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  try {
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await adapter.execute("INSERT INTO posts VALUES (1, 'First'), (2, 'Second'), (3, 'Third'), (4, 'Fourth'), (5, 'Fifth'), (6, 'Sixth')")
    const rowCounts: Array<number | undefined> = []
    const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main', logger: { onQuerySuccess: entry => { if (entry.kind === 'query') rowCounts.push(entry.rowCount) } } })
    const Post = defineModel(defineGeneratedTable('posts', { id: column.id(), title: column.string() }), { timestamps: false })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let reads = 0
    const query = defineRealtimeQuery({ access: 'public', handler: async ({ db: context }) => {
      reads += 1
      if (family === 'table') return context.table('posts').orderBy('id', 'desc').simplePaginate(2, 2)
      const builder = context.model(Post).query().orderBy('id', 'desc')
      return family === 'json' ? builder.simplePaginateJson(2, 2) : builder.simplePaginate(2, 2)
    } })
    let id = 6
    const mutation = defineRealtimeMutation({ access: 'public', handler: async ({ db: context }) => {
      await context.table('posts').where('id', id--).delete()
    } })
    const snapshots: Array<{ ids: readonly unknown[], more: boolean }> = []
    await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push({ ids: snapshot.data.data.map(row => row.id), more: snapshot.data.meta.hasMorePages }) }, onError: error => { throw error } })
    expect(rowCounts).toEqual([3])
    await executeRealtimeMutation(mutation)
    await executeRealtimeMutation(mutation)
    await executeRealtimeMutation(mutation)
    expect(snapshots).toEqual([{ ids: [4, 3], more: true }, { ids: [3, 2], more: true }, { ids: [2, 1], more: false }, { ids: [1], more: false }])
    expect(reads).toBe(1)
    expect(rowCounts.every(count => count !== undefined && count <= 3)).toBe(true)
  } finally {
    await adapter.disconnect()
  }
})
