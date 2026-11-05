import { describe, expect, it } from 'vitest'
import { mysqlDatabaseDriverFactory } from '@holo-js/db-mysql'
import { postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { createDialect } from '../src'
import { integrationDrivers, mysqlTestConnection, postgresTestConnection, testConnectionUrl } from './support/database'

const factories = {
  sqlite: sqliteDatabaseDriverFactory,
  postgres: postgresDatabaseDriverFactory,
  mysql: mysqlDatabaseDriverFactory,
}

function connectionConfig(driver: 'sqlite' | 'postgres' | 'mysql', mode: 'url' | 'database' | 'structured') {
  if (driver === 'sqlite') {
    return mode === 'url' ? { url: ':memory:' } : { database: ':memory:' }
  }
  const connection = driver === 'postgres' ? postgresTestConnection() : mysqlTestConnection()
  if (mode === 'structured') {
    const { user, ...structured } = connection
    return { ...structured, username: user }
  }
  return { url: testConnectionUrl(driver === 'postgres' ? 'postgresql' : 'mysql', connection).toString() }
}

const connections = integrationDrivers(['sqlite', 'postgres', 'mysql'])
  .flatMap(driver => (driver === 'sqlite' ? ['url', 'database'] as const : ['url', 'structured'] as const).map(mode => ({ driver, mode })))

describe('native database driver factories', () => {
  it.each(connections)('connects and binds values through $driver $mode configuration', async ({ driver, mode }) => {
    const adapter = factories[driver].create(connectionConfig(driver, mode))
    const sql = `SELECT ${createDialect(driver).createPlaceholder(1)} AS value`
    const value = "bound'; DROP TABLE users; --"
    try {
      expect((await adapter.query(sql, [value])).rows).toEqual([{ value }])
      await adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      expect((await adapter.query(sql, [value])).rows).toEqual([{ value }])
    } finally {
      await adapter.disconnect()
    }
  })
})
