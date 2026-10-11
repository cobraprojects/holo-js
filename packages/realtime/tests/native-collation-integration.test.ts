import { randomUUID } from 'node:crypto'
import { configureDB, createConnectionManager, createDatabase, createDialect, resetDB, resetDatabaseDependencyInvalidationListeners } from '@holo-js/db'
import { createMySQLAdapter } from '../../db-mysql/src'
import { expect, it } from 'vitest'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

for (const operator of ['=', '!=', 'in', 'not in'] as const) {
  it.runIf(process.env.HOLO_MYSQL_INTEGRATION === '1')(`preserves native case-insensitive ${operator} filtering after text changes`, async () => {
    const tableName = `holo_realtime_${randomUUID().replaceAll('-', '')}`
    const adapter = createMySQLAdapter({ config: {
      host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
      user: 'root',
      database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
    } })
    const db = createDatabase({ adapter, dialect: createDialect('mysql'), connectionName: 'main' })
    const excluded = operator === '!=' || operator === 'not in'
    const value = excluded ? 'xyz' : 'abc'
    const updated = excluded ? 'XYZ' : 'AbC'
    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, name VARCHAR(255) COLLATE utf8mb4_general_ci NOT NULL)`)
      await adapter.execute(`INSERT INTO ${tableName} VALUES (1, 'ABC')`)
      configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
      configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
      const snapshots: Array<readonly Readonly<Record<string, unknown>>[]> = []
      const query = defineRealtimeQuery({ access: 'public', handler: ({ db }) => {
        return db.table(tableName).where('name', operator, operator === 'in' || operator === 'not in' ? [value] : value).get()
      } })
      await subscribeRealtimeQuery(query, {}, { onData: snapshot => { snapshots.push(snapshot.data) }, onError: error => { throw error } })
      await executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler: ({ db }) => {
        return db.table(tableName).where('id', 1).update({ name: updated })
      } }))
      expect(snapshots.at(-1)).toEqual(excluded ? [] : [{ id: 1, name: updated }])
    } finally {
      resetRealtimeRuntime()
      resetDatabaseDependencyInvalidationListeners()
      resetDB()
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
    }
  })
}
