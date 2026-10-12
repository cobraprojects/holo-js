import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureDB, createConnectionManager, createDatabase, createDialect, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { onTestFinished } from 'vitest'
import { configureRealtimeRuntime, resetRealtimeRuntime } from '../../src/server'

export async function openRealtimeDatabase() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(async () => {
    resetRealtimeRuntime()
    resetDB()
    resetDatabaseDependencyInvalidationListeners()
    await adapter.disconnect()
  })
  await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, score INTEGER, active INTEGER NOT NULL)')
  await adapter.execute('INSERT INTO records VALUES (1, 1, 10, 1), (2, 1, 20, 1), (3, 2, 30, 1), (4, 2, NULL, 1), (5, 3, 5, 0)')
  const queries: Array<{ readonly sql: string, readonly rowCount: number | undefined }> = []
  const db = createDatabase({
    adapter,
    dialect: createDialect('sqlite'),
    connectionName: 'main',
    security: { debugSqlInLogs: true },
    logger: { onQuerySuccess: event => {
      if (event.kind === 'query') queries.push({ sql: event.sql ?? '', rowCount: event.rowCount })
    } },
  })
  configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
  configureRealtimeRuntime({ db: () => db })
  return { adapter, db, queries }
}
