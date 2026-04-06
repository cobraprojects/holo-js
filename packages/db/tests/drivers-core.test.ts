import { describe, expect, it } from 'vitest'
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

type PostgresAdapterHarness = {
  releaseScopedTransaction(state: { client: { release?(): void }, leased: boolean, released: boolean }): void
}

type MySQLAdapterHarness = {
  releaseScopedTransaction(state: { client: { release?(): void }, leased: boolean, released: boolean }): void
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

  it('falls back to array-based SQLite bindings when spread bindings trigger an arity error', async () => {
    const calls: Array<{ method: 'all' | 'run', bindings: readonly unknown[] }> = []
    let shouldThrowTooFew = true
    const adapter = createSQLiteAdapter({
      database: {
        prepare() {
          return {
            all(...bindings: readonly unknown[]) {
              calls.push({ method: 'all', bindings })
              if (bindings.length > 1) {
                throw new RangeError('Too many parameter values were provided')
              }

              return [{ ok: true }]
            },
            run(...bindings: readonly unknown[]) {
              calls.push({ method: 'run', bindings })
              if (shouldThrowTooFew) {
                shouldThrowTooFew = false
                throw new RangeError('Too few parameter values were provided')
              }

              if (bindings.length > 1) {
                throw new RangeError('Too many parameter values were provided')
              }

              return {
                changes: 1,
                lastInsertRowid: 11 }
            } }
        },
        exec() {},
        close() {} } })

    await expect(adapter.query('SELECT * FROM users WHERE id = ? AND role = ?', [1, 'admin'])).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1 })
    await expect(adapter.execute('UPDATE users SET meta = ?, role = ? WHERE id = ?', [{ active: true }, 'admin', 1])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 11 })

    expect(calls).toEqual([
      { method: 'all', bindings: [1, 'admin'] },
      { method: 'all', bindings: [[1, 'admin']] },
      { method: 'run', bindings: [{ active: true }, 'admin', 1] },
      { method: 'run', bindings: [[{ active: true }, 'admin', 1]] },
    ])
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

    const defaultAdapter = createPostgresAdapter({
      connectionString: 'postgres://localhost/test' })
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

  it('no-ops Postgres scoped transaction release when the state is already released', () => {
    let releaseCalls = 0
    const adapter = new PostgresAdapter({
      client: {
        async query() {
          return { rows: [], rowCount: 0 }
        } } })

    ;(adapter as unknown as PostgresAdapterHarness).releaseScopedTransaction({
      client: {
        release() {
          releaseCalls += 1
        } },
      leased: true,
      released: true })

    expect(releaseCalls).toBe(0)
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

  it('no-ops MySQL scoped transaction release when the state is already released', () => {
    let releaseCalls = 0
    const adapter = new MySQLAdapter({
      client: {
        async query() {
          return [[], []] as const
        } } })

    ;(adapter as unknown as MySQLAdapterHarness).releaseScopedTransaction({
      client: {
        release() {
          releaseCalls += 1
        } },
      leased: true,
      released: true })

    expect(releaseCalls).toBe(0)
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

    const defaultAdapter = createMySQLAdapter({
      uri: 'mysql://localhost/test' })
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
