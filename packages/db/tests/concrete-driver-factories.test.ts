import { describe, expect, it } from 'vitest'
import { mysqlDatabaseDriverFactory } from '@holo-js/db-mysql'
import { postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import { sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'
import { createDialect } from '../src'

const postgresHost = process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1'
const postgresPort = Number(process.env.HOLO_POSTGRES_PORT ?? 5432)
const postgresDatabase = process.env.HOLO_POSTGRES_DATABASE ?? 'postgres'
const mysqlHost = process.env.HOLO_MYSQL_HOST ?? '127.0.0.1'
const mysqlPort = Number(process.env.HOLO_MYSQL_PORT ?? 3306)
const mysqlDatabase = process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
const connections = [
  { driver: 'sqlite', mode: 'url', factory: sqliteDatabaseDriverFactory, config: { url: ':memory:' } },
  { driver: 'sqlite', mode: 'database', factory: sqliteDatabaseDriverFactory, config: { database: ':memory:' } },
  { driver: 'postgres', mode: 'url', factory: postgresDatabaseDriverFactory, config: { url: `postgresql://postgres@${postgresHost}:${postgresPort}/${postgresDatabase}` } },
  { driver: 'postgres', mode: 'structured', factory: postgresDatabaseDriverFactory, config: { host: postgresHost, port: postgresPort, username: 'postgres', database: postgresDatabase } },
  { driver: 'mysql', mode: 'url', factory: mysqlDatabaseDriverFactory, config: { url: `mysql://root@${mysqlHost}:${mysqlPort}/${mysqlDatabase}` } },
  { driver: 'mysql', mode: 'structured', factory: mysqlDatabaseDriverFactory, config: { host: mysqlHost, port: mysqlPort, username: 'root', database: mysqlDatabase } },
] as const

describe('native database driver factories', () => {
  it.each(connections)('connects and binds values through $driver $mode configuration', async ({ driver, factory, config }) => {
    const adapter = factory.create(config)
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
