import { createDatabase, createDialect, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

afterEach(() => {
  resetRealtimeRuntime()
  resetDatabaseDependencyInvalidationListeners()
})

it('refills partial cursor windows after deletes without losing the next-page boundary', async () => {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  try {
    await adapter.execute('CREATE TABLE posts (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await adapter.execute("INSERT INTO posts VALUES (1, 'First'), (2, 'Second'), (3, 'Third'), (4, 'Fourth'), (5, 'Fifth'), (6, 'Sixth')")
    const rowCounts: Array<number | undefined> = []
    const db = createDatabase({
      adapter,
      dialect: createDialect('sqlite'),
      connectionName: 'main',
      logger: { onQuerySuccess: entry => { if (entry.kind === 'query') rowCounts.push(entry.rowCount) } },
    })
    configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
    let reads = 0
    const query = defineRealtimeQuery({
      access: 'public',
      handler: async ({ db: context }) => {
        reads += 1
        return await context.table('posts').orderBy('id', 'desc').cursorPaginate(2)
      },
    })
    const mutation = defineRealtimeMutation({
      access: 'public',
      handler: async ({ db: context }) => {
        await context.table('posts').where('id', 6).delete()
      },
    })
    const snapshots: Array<{ ids: readonly unknown[], hasMore: boolean }> = []
    await subscribeRealtimeQuery(query, {}, {
      onData: snapshot => { snapshots.push({ ids: snapshot.data.data.map(row => row.id), hasMore: snapshot.data.nextCursor !== null }) },
      onError: error => { throw error },
    })
    await executeRealtimeMutation(mutation)
    expect(snapshots).toEqual([{ ids: [6, 5], hasMore: true }, { ids: [5, 4], hasMore: true }])
    expect(reads).toBe(1)
    expect(rowCounts).toEqual([3, 1, 3])
  } finally {
    await adapter.disconnect()
  }
})
