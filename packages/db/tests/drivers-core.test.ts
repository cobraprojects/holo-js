import { describe, expect, it, vi } from 'vitest'
import {
  SQLiteAdapter as ConcreteSQLiteAdapter,
  createSQLiteAdapter as createConcreteSQLiteAdapter,
} from '@holo-js/db-sqlite'
import {
  MySQLAdapter as ConcreteMySQLAdapter,
  createMySQLAdapter as createConcreteMySQLAdapter,
} from '@holo-js/db-mysql'
import {
  PostgresAdapter as ConcretePostgresAdapter,
  createPostgresAdapter as createConcretePostgresAdapter,
} from '@holo-js/db-postgres'
import {
  MySQLAdapter,
  PostgresAdapter,
  SQLiteAdapter,
  TransactionError,
  createCapabilities,
  createDatabase,
  createMySQLAdapter,
  createPostgresAdapter,
  createSQLiteAdapter,
  unsafeSql } from '../src'
import { driverModuleInternals } from '../src/drivers/index'
import { runDriverAdapterContractSuite } from './contracts/driverAdapterContract'

function createSqliteDatabase() {
  const executed: string[] = []
  const prepared: Array<{ sql: string, bindings: readonly unknown[] }> = []
  let closed = false

  return {
    db: {
      prepare(sql: string) {
        return {
          all(...bindings: readonly unknown[]) {
            prepared.push({ sql, bindings })
            return [{ sql, bindingsCount: bindings.length }]
          },
          run(...bindings: readonly unknown[]) {
            prepared.push({ sql, bindings })
            return {
              changes: bindings.length || 1,
              lastInsertRowid: 9 }
          } }
      },
      exec(sql: string) {
        executed.push(sql)
      },
      close() {
        closed = true
      } },
    executed,
    prepared,
    get closed() {
      return closed
    } }
}

type PgLog = Array<{ sql: string, bindings: readonly unknown[] }>

function createPostgresClient(log: PgLog) {
  let released = false
  let ended = false

  return {
    client: {
      async query(sql: string, bindings: readonly unknown[] = []) {
        log.push({ sql, bindings })
        return {
          rows: sql.startsWith('SELECT') ? [{ id: 1 }] : [],
          rowCount: sql.startsWith('SELECT') ? 1 : 2 }
      },
      release() {
        released = true
      },
      async end() {
        ended = true
      } },
    get released() {
      return released
    },
    get ended() {
      return ended
    } }
}

function createPostgresPool() {
  const rootLog: PgLog = []
  const txLog: PgLog = []
  const txClientState = createPostgresClient(txLog)
  let ended = false

  return {
    pool: {
      async query(sql: string, bindings: readonly unknown[] = []) {
        rootLog.push({ sql, bindings })
        if (!sql.startsWith('SELECT')) {
          return {
            rows: [],
            rowCount: 2 }
        }

        return {
          rows: [{ id: 1 }],
          rowCount: 1 }
      },
      async connect() {
        return txClientState.client
      },
      async end() {
        ended = true
      } },
    rootLog,
    txLog,
    txClientState,
    get ended() {
      return ended
    } }
}

type MySqlLog = Array<{ sql: string, bindings: readonly unknown[] }>

function createMySqlClient(log: MySqlLog) {
  let released = false
  let ended = false

  return {
    client: {
      async query(sql: string, bindings: readonly unknown[] = []) {
        log.push({ sql, bindings })
        if (sql.startsWith('SELECT')) {
          return [[{ id: 1 }], []] as const
        }

        return [{ affectedRows: 2, insertId: 5 }, []] as const
      },
      release() {
        released = true
      },
      async end() {
        ended = true
      } },
    get released() {
      return released
    },
    get ended() {
      return ended
    } }
}

function createMySqlPool() {
  const rootLog: MySqlLog = []
  const txLog: MySqlLog = []
  const txClientState = createMySqlClient(txLog)
  let ended = false

  return {
    pool: {
      async query(sql: string, bindings: readonly unknown[] = []) {
        rootLog.push({ sql, bindings })
        if (!sql.startsWith('SELECT')) {
          return [{ affectedRows: 2, insertId: 5 }, []] as const
        }

        return [[{ id: 1 }], []] as const
      },
      async getConnection() {
        return txClientState.client
      },
      async end() {
        ended = true
      } },
    rootLog,
    txLog,
    txClientState,
    get ended() {
      return ended
    } }
}

function createTransactionDialect(name: 'postgres' | 'mysql') {
  return {
    name,
    capabilities: createCapabilities({
      returning: name === 'postgres',
      savepoints: true,
      concurrentQueries: true,
      lockForUpdate: true,
      sharedLock: true,
      jsonContains: true,
      schemaQualifiedIdentifiers: true }),
    quoteIdentifier(identifier: string) {
      return name === 'postgres'
        ? identifier.split('.').map(part => `"${part}"`).join('.')
        : identifier.split('.').map(part => `\`${part}\``).join('.')
    },
    createPlaceholder(index: number) {
      return name === 'postgres' ? `$${index}` : '?'
    } } as const
}

describe('driver adapters', () => {
  let sqliteContractState: {
    sqlite: ReturnType<typeof createSqliteDatabase>
    created: string[]
  }

  runDriverAdapterContractSuite({
    name: 'sqlite',
    createAdapter() {
      const sqlite = createSqliteDatabase()
      const created: string[] = []
      const adapter = new SQLiteAdapter({
        filename: '/tmp/test.sqlite',
        createDatabase(filename) {
          created.push(filename)
          return sqlite.db
        } })
      sqliteContractState = { sqlite, created }
      return adapter
    },
    query: {
      sql: 'SELECT 1',
      bindings: [1],
      expected: {
        rows: [{ sql: 'SELECT 1', bindingsCount: 1 }],
        rowCount: 1 },
      getLog() {
        return sqliteContractState.sqlite.prepared
      } },
    introspection: {
      sql: 'SELECT name FROM sqlite_master',
      expected: {
        rows: [{ sql: 'SELECT name FROM sqlite_master', bindingsCount: 0 }],
        rowCount: 1 },
      getLog() {
        return sqliteContractState.sqlite.prepared
      } },
    execute: {
      sql: 'INSERT INTO users VALUES (?)',
      bindings: ['a'],
      expected: {
        affectedRows: 1,
        lastInsertId: 9 } },
    transaction: {
      supportsSavepoints: true,
      validSavepointName: 'sp_1',
      invalidSavepointName: 'bad-name',
      expectedLog: [
        { sql: 'BEGIN', bindings: [] },
        { sql: 'SAVEPOINT sp_1', bindings: [] },
        { sql: 'ROLLBACK TO SAVEPOINT sp_1', bindings: [] },
        { sql: 'RELEASE SAVEPOINT sp_1', bindings: [] },
        { sql: 'COMMIT', bindings: [] },
      ],
      getLog() {
        return sqliteContractState.sqlite.executed.map(sql => ({ sql, bindings: [] }))
      } },
    assertDisconnected() {
      expect(sqliteContractState.sqlite.closed).toBe(true)
      expect(sqliteContractState.created).toEqual(['/tmp/test.sqlite'])
    } })

  it('supports an injected SQLite database and rejects invalid savepoint names', async () => {
    const sqlite = createSqliteDatabase()
    const adapter = new SQLiteAdapter({
      database: sqlite.db })

    expect(adapter.isConnected()).toBe(true)
    await adapter.initialize()
    await expect(adapter.createSavepoint('bad-name')).rejects.toThrow(TransactionError)
  })

  it('supports explicit SQLite initialization, bigint insert ids, and factory creation', async () => {
    const executed: string[] = []
    const adapter = createSQLiteAdapter({
      createDatabase() {
        return {
          prepare() {
            return {
              all() {
                return []
              },
              run() {
                return {
                  changes: 2,
                  lastInsertRowid: 12n }
              } }
          },
          exec(sql: string) {
            executed.push(sql)
          },
          close() {} }
      } })

    await adapter.initialize()
    expect(adapter.isConnected()).toBe(true)
    expect(await adapter.execute('INSERT INTO users DEFAULT VALUES')).toEqual({
      affectedRows: 2,
      lastInsertId: 12 })
    expect(executed).toEqual([])
  })

  it('loads split driver packages through the dynamic driver loader', async () => {
    const concreteAdapter = {
      async initialize() {},
      async disconnect() {},
      isConnected() {
        return true
      },
      async query() {
        return {
          rows: [],
          rowCount: 0,
        }
      },
      async execute() {
        return {}
      },
      async beginTransaction() {},
      async commit() {},
      async rollback() {},
    }
    vi.spyOn(driverModuleInternals, 'importDriverModule').mockResolvedValueOnce({
      createSQLiteAdapter() {
        return concreteAdapter
      },
    })

    const adapter = new SQLiteAdapter()
    await adapter.initialize()

    expect(adapter.isConnected()).toBe(true)
  })

  it('wraps missing split driver packages with installation guidance', async () => {
    vi.spyOn(driverModuleInternals, 'importDriverModule').mockRejectedValueOnce(
      new Error('[@holo-js/db] SQLite support requires @holo-js/db-sqlite to be installed.'),
    )

    const adapter = new SQLiteAdapter()
    await expect(adapter.initialize()).rejects.toThrow('[@holo-js/db] SQLite support requires @holo-js/db-sqlite to be installed.')
  })

  it('rethrows non-arity SQLite statement errors', async () => {
    const adapter = createSQLiteAdapter({
      database: {
        prepare() {
          return {
            all() {
              throw new Error('unexpected sqlite failure')
            },
            run() {
              throw new Error('unexpected sqlite failure')
            } }
        },
        exec() {},
        close() {} } })

    await expect(adapter.query('SELECT 1', [1])).rejects.toThrow('unexpected sqlite failure')
    await expect(adapter.execute('UPDATE users SET name = ?', ['Amina'])).rejects.toThrow('unexpected sqlite failure')
  })

  it('covers the default SQLite factory path', async () => {
    const adapter = createSQLiteAdapter()
    await adapter.initialize()
    expect(adapter.isConnected()).toBe(true)
    await adapter.disconnect()
  })

  it('covers concrete SQLite open failures and transaction scope sequencing', async () => {
    const missingAdapter = new ConcreteSQLiteAdapter({
      filename: '/tmp/missing.sqlite',
      createDatabase() {
        throw new Error('')
      },
    })

    await expect(missingAdapter.initialize()).rejects.toThrow(
      'Unable to open SQLite database "/tmp/missing.sqlite": Unknown SQLite driver error.',
    )

    const sqlite = createSqliteDatabase()
    const adapter = createConcreteSQLiteAdapter({
      database: sqlite.db,
    })
    const order: string[] = []
    const first = adapter.runWithTransactionScope(async () => {
      order.push('first:start')
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, 0)
      })
      order.push('first:end')
      return 'first'
    })
    const second = adapter.runWithTransactionScope(async () => {
      order.push('second')
      return 'second'
    })

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(order).toEqual(['first:start', 'first:end', 'second'])

    await adapter.beginTransaction({ mode: 'immediate' })
    await adapter.beginTransaction({ mode: 'exclusive' })
    await expect(adapter.beginTransaction({ mode: 'unsupported' as 'deferred' })).rejects.toThrow(
      'Unsupported SQLite transaction mode "unsupported".',
    )
    expect(sqlite.executed).toEqual([
      'BEGIN IMMEDIATE',
      'BEGIN EXCLUSIVE',
    ])
  })

  let postgresContractState: ReturnType<typeof createPostgresPool>

  runDriverAdapterContractSuite({
    name: 'postgres',
    startsConnected: true,
    createAdapter() {
      const state = createPostgresPool()
      const adapter = new PostgresAdapter({
        pool: state.pool })
      postgresContractState = state
      return adapter
    },
    query: {
      sql: 'SELECT * FROM users',
      bindings: [1],
      expected: {
        rows: [{ id: 1 }],
        rowCount: 1 },
      getLog() {
        return postgresContractState.rootLog
      } },
    introspection: {
      sql: 'SELECT column_name FROM information_schema.columns',
      expected: {
        rows: [{ id: 1 }],
        rowCount: 1 },
      getLog() {
        return postgresContractState.rootLog
      } },
    execute: {
      sql: 'UPDATE users SET name = $1',
      bindings: ['A'],
      expected: {
        affectedRows: 2 } },
    transaction: {
      supportsSavepoints: true,
      validSavepointName: 'sp_1',
      invalidSavepointName: 'bad-name',
      expectedLog: [
        { sql: 'BEGIN', bindings: [] },
        { sql: 'SELECT * FROM users', bindings: [1] },
        { sql: 'UPDATE users SET name = $1', bindings: ['A'] },
        { sql: 'SAVEPOINT sp_1', bindings: [] },
        { sql: 'ROLLBACK TO SAVEPOINT sp_1', bindings: [] },
        { sql: 'RELEASE SAVEPOINT sp_1', bindings: [] },
        { sql: 'COMMIT', bindings: [] },
      ],
      expectedNestedBeginLog: [
        { sql: 'BEGIN', bindings: [] },
        { sql: 'BEGIN', bindings: [] },
        { sql: 'ROLLBACK', bindings: [] },
      ],
      getLog() {
        return postgresContractState.txLog
      } },
    assertDisconnected() {
      expect(postgresContractState.ended).toBe(true)
    },
    assertTransactionDisconnected() {
      expect(postgresContractState.ended).toBe(true)
      expect(postgresContractState.txClientState.released).toBe(true)
    } })

  it('supports a direct Postgres client, lazy pool creation, rollback, and invalid transaction state handling', async () => {
    const directLog: PgLog = []
    const directState = createPostgresClient(directLog)
    const lazyPool = createPostgresPool()
    const lazyCreates: number[] = []

    const directAdapter = new PostgresAdapter({
      client: directState.client })
    await directAdapter.beginTransaction()
    await directAdapter.rollback()
    expect(directLog).toEqual([
      { sql: 'BEGIN', bindings: [] },
      { sql: 'ROLLBACK', bindings: [] },
    ])
    await directAdapter.disconnect()
    expect(directState.ended).toBe(true)

    const lazyAdapter = new PostgresAdapter({
      createPool() {
        lazyCreates.push(1)
        return lazyPool.pool
      } })
    await lazyAdapter.query('SELECT 1')
    expect(lazyCreates).toEqual([1])
    await lazyAdapter.disconnect()
    expect(lazyPool.ended).toBe(true)

    await expect(directAdapter.commit()).rejects.toThrow(
      'No active Postgres transaction client is available.',
    )
    await directAdapter.beginTransaction()
    await expect(directAdapter.createSavepoint('bad-name')).rejects.toThrow(
      'Invalid savepoint name "bad-name".',
    )
    await directAdapter.rollback()
  })

  it('covers active leased Postgres disconnects, invalid lazy pools, and the default pool factory path', async () => {
    const leasedState = createPostgresPool()
    const leasedAdapter = new PostgresAdapter({
      pool: leasedState.pool })
    await leasedAdapter.beginTransaction()
    await leasedAdapter.disconnect()
    expect(leasedState.txClientState.released).toBe(true)
    expect(leasedState.ended).toBe(true)

    const brokenAdapter = new PostgresAdapter({
      createPool() {
        return undefined as never
      } })
    await expect(brokenAdapter.query('SELECT 1')).rejects.toThrow(
      'Postgres adapter is not initialized with a pool or client.',
    )
    await expect(brokenAdapter.beginTransaction()).rejects.toThrow(
      'Postgres adapter is not initialized with a pool or client.',
    )
    await expect(brokenAdapter.runWithTransactionScope(async () => 'x')).rejects.toThrow(
      'Postgres adapter is not initialized with a pool or client.',
    )

    const defaultState = createPostgresPool()
    const defaultAdapter = createPostgresAdapter({
      connectionString: 'postgres://localhost/test',
      createPool() {
        return defaultState.pool
      } })
    await defaultAdapter.initialize()
    expect(defaultAdapter.isConnected()).toBe(true)
    await defaultAdapter.disconnect()
  })

  it('supports concurrent pooled Postgres queries and extracts returning ids from execution results', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const rootLog: PgLog = []
    const adapter = new PostgresAdapter({
      pool: {
        async query(sql: string, bindings: readonly unknown[] = []) {
          rootLog.push({ sql, bindings })
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await Promise.resolve()
          concurrent -= 1

          if (sql.startsWith('INSERT')) {
            return {
              rows: [{ id: 42 }],
              rowCount: 1 }
          }

          return {
            rows: [{ id: 1 }],
            rowCount: 1 }
        },
        async connect() {
          return createPostgresClient([]).client
        },
        async end() {} } })

    await Promise.all([
      adapter.query('SELECT * FROM users WHERE id = $1', [1]),
      adapter.query('SELECT * FROM users WHERE id = $1', [2]),
    ])

    expect(maxConcurrent).toBe(2)
    await expect(adapter.execute('INSERT INTO users DEFAULT VALUES RETURNING id')).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 42 })
    expect(rootLog).toEqual([
      { sql: 'SELECT * FROM users WHERE id = $1', bindings: [1] },
      { sql: 'SELECT * FROM users WHERE id = $1', bindings: [2] },
      { sql: 'INSERT INTO users DEFAULT VALUES RETURNING id', bindings: [] },
    ])
  })

  it('runs Postgres transaction scopes on direct clients and reuses the active scope for nested calls', async () => {
    const log: PgLog = []
    const state = createPostgresClient(log)
    const adapter = new PostgresAdapter({
      client: state.client })

    const result = await adapter.runWithTransactionScope(async () => {
      const outer = await adapter.query('SELECT outer')
      const inner = await adapter.runWithTransactionScope(async () => adapter.query('SELECT inner'))
      return { outer, inner }
    })

    expect(result).toEqual({
      outer: { rows: [{ id: 1 }], rowCount: 1 },
      inner: { rows: [{ id: 1 }], rowCount: 1 } })
    expect(log).toEqual([
      { sql: 'SELECT outer', bindings: [] },
      { sql: 'SELECT inner', bindings: [] },
    ])
  })

  it('keeps overlapping pooled Postgres transactions pinned to their own clients', async () => {
    let firstTransactionPaused!: () => void
    let releaseFirstTransaction!: () => void
    const firstTransactionReady = new Promise<void>((resolve) => {
      firstTransactionPaused = resolve
    })
    const firstTransactionReleased = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve
    })

    let connectCount = 0
    const adapter = new PostgresAdapter({
      pool: {
        async query() {
          return {
            rows: [],
            rowCount: 0 }
        },
        async connect() {
          connectCount += 1
          const clientId = connectCount

          return {
            async query(sql: string) {
              return {
                rows: [{ clientId, sql }],
                rowCount: 1 }
            },
            release() {} }
        },
        async end() {} } })

    const db = createDatabase({
      adapter,
      dialect: createTransactionDialect('postgres'),
      security: { allowUnsafeRawSql: true } })

    const first = db.transaction(async (tx) => {
      const result = await tx.unsafeQuery<{ clientId: number, sql: string }>(unsafeSql('SELECT first'))
      firstTransactionPaused()
      await firstTransactionReleased
      return result
    })

    await firstTransactionReady

    const second = db.transaction(async (tx) => {
      return tx.unsafeQuery<{ clientId: number, sql: string }>(unsafeSql('SELECT second'))
    })

    await expect(second).resolves.toEqual({
      rows: [{ clientId: 2, sql: 'SELECT second' }],
      rowCount: 1 })

    releaseFirstTransaction()

    await expect(first).resolves.toEqual({
      rows: [{ clientId: 1, sql: 'SELECT first' }],
      rowCount: 1 })
    expect(connectCount).toBe(2)
  })

  it('normalizes Postgres rowCount fallbacks for query and execute', async () => {
    const adapter = new PostgresAdapter({
      client: {
        async query(sql: string) {
          if (sql === 'SELECT * FROM users') {
            return {
              rows: [{ id: 1 }, { id: 2 }] }
          }

          return {
            rows: [],
            rowCount: null }
        } } })

    expect(await adapter.query('SELECT * FROM users')).toEqual({
      rows: [{ id: 1 }, { id: 2 }],
      rowCount: 2 })
    expect(await adapter.execute('DELETE FROM users')).toEqual({
      affectedRows: 0 })
  })

  it('supports Postgres factory creation, direct-client root queries, and idempotent disconnect', async () => {
    const directLog: PgLog = []
    const directState = createPostgresClient(directLog)
    const adapter = createPostgresAdapter({
      client: directState.client })

    expect(await adapter.query('SELECT * FROM users')).toEqual({
      rows: [{ id: 1 }],
      rowCount: 1 })
    expect(await adapter.execute('DELETE FROM users')).toEqual({
      affectedRows: 2 })
    expect(directLog).toEqual([
      { sql: 'SELECT * FROM users', bindings: [] },
      { sql: 'DELETE FROM users', bindings: [] },
    ])

    await adapter.disconnect()
    await adapter.disconnect()
    expect(directState.ended).toBe(true)
  })

  it('covers concrete Postgres connection-string bootstrap and missing database detection', async () => {
    const bootstrapQuery = vi.fn(async (sql: string, bindings: readonly unknown[] = []) => ({
      rows: sql.startsWith('select 1 from pg_database') ? [] : [{ sql, bindings }],
      rowCount: sql.startsWith('select 1 from pg_database') ? 0 : 1,
    }))
    const applicationQuery = vi.fn(async (sql: string, bindings: readonly unknown[] = []) => ({
      rows: [{ sql, bindings }],
      rowCount: 1,
    }))
    const bootstrapEnd = vi.fn(async () => {})
    const applicationEnd = vi.fn(async () => {})
    const createPool = vi.fn((config) => {
      if (config?.connectionString?.includes('/tenant%22app')) {
        return {
          query: applicationQuery,
          connect: vi.fn(async () => createPostgresClient([]).client),
          end: applicationEnd,
        }
      }

      return {
        query: bootstrapQuery,
        connect: vi.fn(async () => createPostgresClient([]).client),
        end: bootstrapEnd,
      }
    })
    const adapter = createConcretePostgresAdapter({
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/tenant%22app?sslmode=disable',
      createPool,
    })
    const missingDetector = new ConcretePostgresAdapter()

    await adapter.ensureDatabaseExists()
    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ sql: 'select 1', bindings: [] }],
      rowCount: 1,
    })

    expect(createPool).toHaveBeenNthCalledWith(1, {
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/postgres?sslmode=disable',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/tenant%22app?sslmode=disable',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(
      1,
      'select 1 from pg_database where datname = $1',
      ['tenant"app'],
    )
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'create database "tenant""app"')
    expect(bootstrapEnd).toHaveBeenCalledTimes(1)
    expect(applicationQuery).toHaveBeenCalledWith('select 1', [])
    expect(missingDetector.isDatabaseMissingError({ code: '3D000' })).toBe(true)
    expect(missingDetector.isDatabaseMissingError({ code: 'OTHER' })).toBe(false)

    await adapter.disconnect()
    expect(applicationEnd).toHaveBeenCalledTimes(1)

    const noTargetCreatePool = vi.fn(() => {
      throw new Error('should not create a pool')
    })
    await expect(createConcretePostgresAdapter({
      config: { database: 'postgres' },
      createPool: noTargetCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    await expect(createConcretePostgresAdapter({
      createPool: noTargetCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    expect(noTargetCreatePool).not.toHaveBeenCalled()

    const configBootstrapQuery = vi.fn(async () => ({
      rows: [{ exists: 1 }],
      rowCount: 1,
    }))
    const configBootstrapEnd = vi.fn(async () => {})
    const configCreatePool = vi.fn(() => ({
      query: configBootstrapQuery,
      connect: vi.fn(async () => createPostgresClient([]).client),
      end: configBootstrapEnd,
    }))
    await expect(createConcretePostgresAdapter({
      config: { database: 'tenant_config' },
      createPool: configCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    expect(configCreatePool).toHaveBeenCalledWith({ database: 'postgres' })
    expect(configBootstrapQuery).toHaveBeenCalledWith(
      'select 1 from pg_database where datname = $1',
      ['tenant_config'],
    )
    expect(configBootstrapEnd).toHaveBeenCalledTimes(1)

    const failingEnd = vi.fn(async () => {})
    const failingAdapter = createConcretePostgresAdapter({
      config: { database: 'private"app' },
      createPool() {
        return {
          async query() {
            throw new Error('permission denied')
          },
          connect: vi.fn(async () => createPostgresClient([]).client),
          end: failingEnd,
        }
      },
    })
    await expect(failingAdapter.ensureDatabaseExists()).rejects.toThrow(
      'Postgres database "private"app" could not be found or created. Please create the database and try again. Original error: permission denied',
    )
    expect(failingEnd).toHaveBeenCalledTimes(1)
  })

  it('disconnects a direct Postgres client even when it does not expose end()', async () => {
    const log: PgLog = []
    let released = false
    const adapter = createPostgresAdapter({
      client: {
        async query(sql: string, bindings: readonly unknown[] = []) {
          log.push({ sql, bindings })
          return { rows: [], rowCount: 0 }
        },
        release() {
          released = true
        } } })

    await adapter.disconnect()

    expect(released).toBe(false)
    expect(adapter.isConnected()).toBe(false)
  })

  let mySqlContractState: ReturnType<typeof createMySqlPool>

  runDriverAdapterContractSuite({
    name: 'mysql',
    startsConnected: true,
    createAdapter() {
      const state = createMySqlPool()
      const adapter = new MySQLAdapter({
        pool: state.pool })
      mySqlContractState = state
      return adapter
    },
    query: {
      sql: 'SELECT * FROM users',
      bindings: [1],
      expected: {
        rows: [{ id: 1 }],
        rowCount: 1 },
      getLog() {
        return mySqlContractState.rootLog
      } },
    introspection: {
      sql: 'SELECT column_name FROM information_schema.columns',
      expected: {
        rows: [{ id: 1 }],
        rowCount: 1 },
      getLog() {
        return mySqlContractState.rootLog
      } },
    execute: {
      sql: 'UPDATE users SET name = ?',
      bindings: ['A'],
      expected: {
        affectedRows: 2,
        lastInsertId: 5 } },
    transaction: {
      supportsSavepoints: true,
      validSavepointName: 'sp_1',
      invalidSavepointName: 'bad-name',
      expectedLog: [
        { sql: 'START TRANSACTION', bindings: [] },
        { sql: 'SELECT * FROM users', bindings: [1] },
        { sql: 'UPDATE users SET name = ?', bindings: ['A'] },
        { sql: 'SAVEPOINT sp_1', bindings: [] },
        { sql: 'ROLLBACK TO SAVEPOINT sp_1', bindings: [] },
        { sql: 'RELEASE SAVEPOINT sp_1', bindings: [] },
        { sql: 'COMMIT', bindings: [] },
      ],
      expectedNestedBeginLog: [
        { sql: 'START TRANSACTION', bindings: [] },
        { sql: 'START TRANSACTION', bindings: [] },
        { sql: 'ROLLBACK', bindings: [] },
      ],
      getLog() {
        return mySqlContractState.txLog
      } },
    assertDisconnected() {
      expect(mySqlContractState.ended).toBe(true)
    },
    assertTransactionDisconnected() {
      expect(mySqlContractState.ended).toBe(true)
      expect(mySqlContractState.txClientState.released).toBe(true)
    } })

  it('supports a direct MySQL client, lazy pool creation, rollback, and invalid transaction state handling', async () => {
    const directLog: MySqlLog = []
    const directState = createMySqlClient(directLog)
    const lazyPool = createMySqlPool()
    const lazyCreates: number[] = []

    const directAdapter = new MySQLAdapter({
      client: directState.client })
    await directAdapter.beginTransaction()
    await directAdapter.rollback()
    expect(directLog).toEqual([
      { sql: 'START TRANSACTION', bindings: [] },
      { sql: 'ROLLBACK', bindings: [] },
    ])
    await directAdapter.disconnect()
    expect(directState.ended).toBe(true)

    const lazyAdapter = new MySQLAdapter({
      createPool(config) {
        lazyCreates.push(Object.keys(config).length)
        return lazyPool.pool
      } })
    await lazyAdapter.query('SELECT 1')
    expect(lazyCreates).toEqual([0])
    await lazyAdapter.disconnect()
    expect(lazyPool.ended).toBe(true)

    await expect(directAdapter.commit()).rejects.toThrow(
      'No active MySQL transaction client is available.',
    )
    await directAdapter.beginTransaction()
    await expect(directAdapter.createSavepoint('bad-name')).rejects.toThrow(
      'Invalid savepoint name "bad-name".',
    )
    await directAdapter.rollback()
  })

  it('supports MySQL factory creation, direct-client root execution, and idempotent disconnect', async () => {
    const directLog: MySqlLog = []
    const directState = createMySqlClient(directLog)
    const adapter = createMySQLAdapter({
      client: directState.client })

    expect(await adapter.query('SELECT * FROM users')).toEqual({
      rows: [{ id: 1 }],
      rowCount: 1 })
    expect(await adapter.execute('DELETE FROM users')).toEqual({
      affectedRows: 2,
      lastInsertId: 5 })
    expect(directLog).toEqual([
      { sql: 'SELECT * FROM users', bindings: [] },
      { sql: 'DELETE FROM users', bindings: [] },
    ])

    await adapter.disconnect()
    await adapter.disconnect()
    expect(directState.ended).toBe(true)
  })

  it('covers concrete MySQL URI bootstrap and missing database detection', async () => {
    const bootstrapQuery = vi.fn(async (sql: string, bindings: readonly unknown[] = []) => {
      if (sql.startsWith('SELECT SCHEMA_NAME')) {
        return [[], []] as const
      }

      return [{ affectedRows: 1, insertId: 0 }, []] as const
    })
    const applicationQuery = vi.fn(async (sql: string, bindings: readonly unknown[] = []) => [[{ sql, bindings }], []] as const)
    const bootstrapEnd = vi.fn(async () => {})
    const applicationEnd = vi.fn(async () => {})
    const createPool = vi.fn((config) => {
      if (String(config.uri).includes('/tenant%60app')) {
        return {
          query: applicationQuery,
          getConnection: vi.fn(async () => createMySqlClient([]).client),
          end: applicationEnd,
        }
      }

      return {
        query: bootstrapQuery,
        getConnection: vi.fn(async () => createMySqlClient([]).client),
        end: bootstrapEnd,
      }
    })
    const adapter = createConcreteMySQLAdapter({
      uri: 'mysql://root:secret@127.0.0.1:3306/tenant%60app?timezone=Z',
      createPool,
    })
    const missingDetector = new ConcreteMySQLAdapter()

    await adapter.ensureDatabaseExists()
    await expect(adapter.query('SELECT 1')).resolves.toEqual({
      rows: [{ sql: 'SELECT 1', bindings: [] }],
      rowCount: 1,
    })

    expect(createPool).toHaveBeenNthCalledWith(1, {
      uri: 'mysql://root:secret@127.0.0.1:3306?timezone=Z',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      uri: 'mysql://root:secret@127.0.0.1:3306/tenant%60app?timezone=Z',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      ['tenant`app'],
    )
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'CREATE DATABASE `tenant``app`', [])
    expect(bootstrapEnd).toHaveBeenCalledTimes(1)
    expect(applicationQuery).toHaveBeenCalledWith('SELECT 1', [])
    expect(missingDetector.isDatabaseMissingError({ code: 'ER_BAD_DB_ERROR' })).toBe(true)
    expect(missingDetector.isDatabaseMissingError({ errno: 1049 })).toBe(true)
    expect(missingDetector.isDatabaseMissingError({ code: 'OTHER' })).toBe(false)

    await adapter.disconnect()
    expect(applicationEnd).toHaveBeenCalledTimes(1)

    const noTargetCreatePool = vi.fn(() => {
      throw new Error('should not create a pool')
    })
    await expect(createConcreteMySQLAdapter({
      uri: 'mysql://root:secret@127.0.0.1:3306',
      createPool: noTargetCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    await expect(createConcreteMySQLAdapter({
      config: {},
      createPool: noTargetCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    expect(noTargetCreatePool).not.toHaveBeenCalled()

    const configBootstrapQuery = vi.fn(async () => [[{ SCHEMA_NAME: 'tenant_config' }], []] as const)
    const configBootstrapEnd = vi.fn(async () => {})
    const configCreatePool = vi.fn(() => ({
      query: configBootstrapQuery,
      getConnection: vi.fn(async () => createMySqlClient([]).client),
      end: configBootstrapEnd,
    }))
    await expect(createConcreteMySQLAdapter({
      config: { database: 'tenant_config' },
      createPool: configCreatePool,
    }).ensureDatabaseExists()).resolves.toBeUndefined()
    expect(configCreatePool).toHaveBeenCalledWith({})
    expect(configBootstrapQuery).toHaveBeenCalledWith(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      ['tenant_config'],
    )
    expect(configBootstrapEnd).toHaveBeenCalledTimes(1)

    const failingEnd = vi.fn(async () => {})
    const failingAdapter = createConcreteMySQLAdapter({
      config: { database: 'private`app' },
      createPool() {
        return {
          async query() {
            throw new Error('access denied')
          },
          getConnection: vi.fn(async () => createMySqlClient([]).client),
          end: failingEnd,
        }
      },
    })
    await expect(failingAdapter.ensureDatabaseExists()).rejects.toThrow(
      'MySQL database "private`app" could not be found or created. Please create the database and try again. Original error: access denied',
    )
    expect(failingEnd).toHaveBeenCalledTimes(1)
  })

  it('disconnects a direct MySQL client even when it does not expose end()', async () => {
    const log: MySqlLog = []
    let released = false
    const adapter = createMySQLAdapter({
      client: {
        async query(sql: string, bindings: readonly unknown[] = []) {
          log.push({ sql, bindings })
          return [[{ id: 1 }], []] as const
        },
        release() {
          released = true
        } } })

    await adapter.disconnect()

    expect(released).toBe(false)
    expect(adapter.isConnected()).toBe(false)
  })

  it('covers active leased MySQL disconnects, invalid lazy pools, and the default pool factory path', async () => {
    const leasedState = createMySqlPool()
    const leasedAdapter = new MySQLAdapter({
      pool: leasedState.pool })
    await leasedAdapter.beginTransaction()
    await leasedAdapter.disconnect()
    expect(leasedState.txClientState.released).toBe(true)
    expect(leasedState.ended).toBe(true)

    const brokenAdapter = new MySQLAdapter({
      createPool() {
        return undefined as never
      } })
    await expect(brokenAdapter.query('SELECT 1')).rejects.toThrow(
      'MySQL adapter is not initialized with a pool or client.',
    )
    await expect(brokenAdapter.beginTransaction()).rejects.toThrow(
      'MySQL adapter is not initialized with a pool or client.',
    )
    await expect(brokenAdapter.runWithTransactionScope(async () => 'x')).rejects.toThrow(
      'MySQL adapter is not initialized with a pool or client.',
    )

    const defaultState = createMySqlPool()
    const defaultAdapter = createMySQLAdapter({
      uri: 'mysql://localhost/test',
      createPool() {
        return defaultState.pool
      } })
    await defaultAdapter.initialize()
    expect(defaultAdapter.isConnected()).toBe(true)
    await defaultAdapter.disconnect()
  })

  it('normalizes MySQL row and execution fallbacks', async () => {
    const adapter = new MySQLAdapter({
      client: {
        async query(sql: string) {
          if (sql === 'SELECT * FROM users') {
            return [{ affectedRows: 9 }, []] as const
          }

          return [{ insertId: 7 }, []] as const
        } } })

    expect(await adapter.query('SELECT * FROM users')).toEqual({
      rows: [],
      rowCount: 0 })
    expect(await adapter.execute('DELETE FROM users')).toEqual({
      affectedRows: 0,
      lastInsertId: 7 })
  })

  it('supports concurrent pooled MySQL queries and keeps transaction-scoped work pinned to the leased client', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const rootLog: MySqlLog = []
    const txLog: MySqlLog = []
    const txClientState = createMySqlClient(txLog)
    const adapter = new MySQLAdapter({
      pool: {
        async query(sql: string, bindings: readonly unknown[] = []) {
          rootLog.push({ sql, bindings })
          concurrent += 1
          maxConcurrent = Math.max(maxConcurrent, concurrent)
          await Promise.resolve()
          concurrent -= 1

          if (sql.startsWith('INSERT')) {
            return [{ affectedRows: 1, insertId: 42 }, []] as const
          }

          return [[{ id: 1 }], []] as const
        },
        async getConnection() {
          return txClientState.client
        },
        async end() {} } })

    await Promise.all([
      adapter.query('SELECT * FROM users WHERE id = ?', [1]),
      adapter.query('SELECT * FROM users WHERE id = ?', [2]),
    ])

    expect(maxConcurrent).toBe(2)
    await expect(adapter.execute('INSERT INTO users DEFAULT VALUES')).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 42 })

    await adapter.beginTransaction()
    await adapter.query('SELECT * FROM users WHERE id = ?', [3])
    await adapter.execute('UPDATE users SET name = ?', ['Pinned'])
    await adapter.commit()

    expect(rootLog).toEqual([
      { sql: 'SELECT * FROM users WHERE id = ?', bindings: [1] },
      { sql: 'SELECT * FROM users WHERE id = ?', bindings: [2] },
      { sql: 'INSERT INTO users DEFAULT VALUES', bindings: [] },
    ])
    expect(txLog).toEqual([
      { sql: 'START TRANSACTION', bindings: [] },
      { sql: 'SELECT * FROM users WHERE id = ?', bindings: [3] },
      { sql: 'UPDATE users SET name = ?', bindings: ['Pinned'] },
      { sql: 'COMMIT', bindings: [] },
    ])
    expect(txClientState.released).toBe(true)
  })

  it('runs MySQL transaction scopes on direct clients and reuses the active scope for nested calls', async () => {
    const log: MySqlLog = []
    const state = createMySqlClient(log)
    const adapter = new MySQLAdapter({
      client: state.client })

    const result = await adapter.runWithTransactionScope(async () => {
      const outer = await adapter.query('SELECT outer')
      const inner = await adapter.runWithTransactionScope(async () => adapter.query('SELECT inner'))
      return { outer, inner }
    })

    expect(result).toEqual({
      outer: { rows: [{ id: 1 }], rowCount: 1 },
      inner: { rows: [{ id: 1 }], rowCount: 1 } })
    expect(log).toEqual([
      { sql: 'SELECT outer', bindings: [] },
      { sql: 'SELECT inner', bindings: [] },
    ])
  })

  it('keeps overlapping pooled MySQL transactions pinned to their own clients', async () => {
    let firstTransactionPaused!: () => void
    let releaseFirstTransaction!: () => void
    const firstTransactionReady = new Promise<void>((resolve) => {
      firstTransactionPaused = resolve
    })
    const firstTransactionReleased = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve
    })

    let connectionCount = 0
    const adapter = new MySQLAdapter({
      pool: {
        async query() {
          return [[], []] as const
        },
        async getConnection() {
          connectionCount += 1
          const clientId = connectionCount
          return {
            async query(sql: string) {
              return [[{ clientId, sql }], []] as const
            },
            release() {} }
        },
        async end() {} } })

    const db = createDatabase({
      adapter,
      dialect: createTransactionDialect('mysql'),
      security: { allowUnsafeRawSql: true } })

    const first = db.transaction(async (tx) => {
      const result = await tx.unsafeQuery<{ clientId: number, sql: string }>(unsafeSql('SELECT first'))
      firstTransactionPaused()
      await firstTransactionReleased
      return result
    })

    await firstTransactionReady

    const second = db.transaction(async (tx) => {
      return tx.unsafeQuery<{ clientId: number, sql: string }>(unsafeSql('SELECT second'))
    })

    await expect(second).resolves.toEqual({
      rows: [{ clientId: 2, sql: 'SELECT second' }],
      rowCount: 1 })

    releaseFirstTransaction()

    await expect(first).resolves.toEqual({
      rows: [{ clientId: 1, sql: 'SELECT first' }],
      rowCount: 1 })
    expect(connectionCount).toBe(2)
  })
})
