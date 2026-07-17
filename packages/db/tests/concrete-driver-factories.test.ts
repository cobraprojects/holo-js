import { describe, expect, it, vi } from 'vitest'
import { MySQLAdapter, createMySQLAdapter, mysqlDatabaseDriverFactory } from '@holo-js/db-mysql'
import { PostgresAdapter, createPostgresAdapter, postgresDatabaseDriverFactory } from '@holo-js/db-postgres'
import { SQLiteAdapter, sqliteDatabaseDriverFactory } from '@holo-js/db-sqlite'

describe('concrete database driver factories', () => {
  it('creates MySQL adapters from URLs and structured connection options', () => {
    expect(mysqlDatabaseDriverFactory.create({ url: 'mysql://localhost/app' })).toBeInstanceOf(MySQLAdapter)
    expect(mysqlDatabaseDriverFactory.create({
      host: 'localhost', port: 3306, username: 'app', password: 'secret', database: 'app', ssl: true,
    })).toBeInstanceOf(MySQLAdapter)
    expect(mysqlDatabaseDriverFactory.create({ ssl: false })).toBeInstanceOf(MySQLAdapter)
  })

  it('creates Postgres adapters from URLs and structured connection options', () => {
    expect(postgresDatabaseDriverFactory.create({ url: 'postgres://localhost/app' })).toBeInstanceOf(PostgresAdapter)
    expect(postgresDatabaseDriverFactory.create({
      host: 'localhost', port: 5432, username: 'app', password: 'secret', database: 'app', ssl: true,
    })).toBeInstanceOf(PostgresAdapter)
  })

  it('creates SQLite adapters from URL, database, and default filenames', () => {
    expect(sqliteDatabaseDriverFactory.create({ url: ':memory:' })).toBeInstanceOf(SQLiteAdapter)
    expect(sqliteDatabaseDriverFactory.create({ database: ':memory:' })).toBeInstanceOf(SQLiteAdapter)
    expect(sqliteDatabaseDriverFactory.create({})).toBeInstanceOf(SQLiteAdapter)
  })

  it('uses direct MySQL clients for nested transaction scopes without leasing', async () => {
    const query = vi.fn(async () => [[], {}] as const)
    const end = vi.fn(async () => {})
    const adapter = createMySQLAdapter({ client: { query, end } })
    await adapter.ensureDatabaseExists()
    await adapter.runWithTransactionScope(async () => {
      await adapter.runWithTransactionScope(async () => {
        await adapter.query('select 1')
      })
    })
    await adapter.disconnect()
    expect(query).toHaveBeenCalledWith('select 1', [])
    expect(end).toHaveBeenCalledOnce()
  })

  it('uses direct Postgres clients for nested transaction scopes without leasing', async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const end = vi.fn(async () => {})
    const adapter = createPostgresAdapter({ client: { query, end } })
    await adapter.ensureDatabaseExists()
    await adapter.runWithTransactionScope(async () => {
      await adapter.runWithTransactionScope(async () => {
        await adapter.query('select 1')
      })
    })
    await adapter.disconnect()
    expect(query).toHaveBeenCalledWith('select 1', [])
    expect(end).toHaveBeenCalledOnce()
  })

  it('initializes default concrete pools without opening a connection', async () => {
    const mysqlAdapter = createMySQLAdapter()
    await mysqlAdapter.initialize()
    expect(mysqlAdapter.isConnected()).toBe(true)
    await mysqlAdapter.disconnect()

    const postgresAdapter = createPostgresAdapter()
    await postgresAdapter.initialize()
    expect(postgresAdapter.isConnected()).toBe(true)
    await postgresAdapter.disconnect()
  })
})
