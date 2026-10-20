import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  CapabilityError, CompilerError, ConfigurationError, DB, DatabaseError,
  HydrationError, ModelNotFoundException, RelationError, SchemaError, SecurityError,
  SerializationError, TransactionError, configureDB, createConnectionManager,
  createDatabase, createDialect, createSecurityPolicy, redactBindings, redactSql,
  resetDB, unsafeSql, type DatabaseLogger,
} from '../src'
import { defineModelFromTable } from './support/internal'
import { openDatabase } from './support/database'

type QueryErrorLog = Parameters<NonNullable<DatabaseLogger['onQueryError']>>[0]
type QuerySuccessLog = Parameters<NonNullable<DatabaseLogger['onQuerySuccess']>>[0]

beforeEach(() => resetDB())

const drivers = ['sqlite', 'postgres', 'mysql'] as const

describe('native database contexts', () => {
  it.each(drivers)('commits writes and rolls back failed callbacks on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await db.transaction(async tx => {
      await tx.table(table).insert({ id: 1, name: 'Committed' })
      expect(await tx.table(table).where('id', 1).value('name')).toBe('Committed')
    })
    await expect(db.transaction(async tx => {
      await tx.table(table).insert({ id: 2, name: 'Rolled back' })
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Committed'])
  })

  it.each(drivers)('isolates nested savepoints and transaction callbacks on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const callbacks: string[] = []
    await db.transaction(async tx => {
      tx.afterCommit(() => { callbacks.push('outer commit') })
      tx.afterRollback(() => { callbacks.push('outer rollback') })
      await tx.table(table).insert({ id: 1, name: 'Outer' })
      await tx.transaction(async nested => {
        nested.afterCommit(() => { callbacks.push('nested commit') })
        await nested.table(table).insert({ id: 2, name: 'Nested' })
      })
      await expect(tx.transaction(async nested => {
        nested.afterCommit(() => { callbacks.push('discarded commit') })
        nested.afterRollback(() => { callbacks.push('nested rollback') })
        await nested.table(table).insert({ id: 3, name: 'Discarded' })
        throw new Error('savepoint abort')
      })).rejects.toThrow('savepoint abort')
      expect(callbacks).toEqual(['nested rollback'])
      expect(await tx.table(table).orderBy('id').pluck('name')).toEqual(['Outer', 'Nested'])
    })
    expect(callbacks).toEqual(['nested rollback', 'outer commit', 'nested commit'])
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Outer', 'Nested'])
    await db.transaction(tx => tx.table(table).insert({ id: 4, name: 'Next' }))
    expect(callbacks).toEqual(['nested rollback', 'outer commit', 'nested commit'])
    expect(() => db.afterCommit(() => {})).toThrow(TransactionError)
  })

  it.each(drivers)('preserves committed rows when an afterCommit callback fails on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const callbacks: string[] = []
    await expect(db.transaction(async tx => {
      tx.afterCommit(() => { throw new Error('notification failed') })
      tx.afterRollback(() => { callbacks.push('rollback') })
      await tx.table(table).insert({ id: 1, name: 'Durable' })
    })).rejects.toThrow('notification failed')
    expect(callbacks).toEqual([])
    expect(await db.table(table).pluck('name')).toEqual(['Durable'])
  })

  it.each(drivers)('preserves committed rows when the transaction logger fails on %s', async driver => {
    const committed: string[] = []
    const { db, table } = await openDatabase(driver, { logger: {
      onTransactionCommit() { throw new Error('logger failed') },
    } })
    await expect(db.transaction(async tx => {
      tx.afterCommit(() => { committed.push('committed') })
      await tx.table(table).insert({ id: 1, name: 'Durable' })
    })).rejects.toThrow('logger failed')
    expect(committed).toEqual(['committed'])
    expect(await db.table(table).pluck('name')).toEqual(['Durable'])
  })

  it.each(drivers)('keeps concurrent transaction writes separate on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    await Promise.all([1, 2, 3, 4].map(id => db.transaction(async tx => {
      await tx.table(table).insert({ id, name: `Record ${id}` })
      expect(await tx.table(table).where('id', id).value('name')).toBe(`Record ${id}`)
    })))
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Record 1', 'Record 2', 'Record 3', 'Record 4'])
  })

  it.each(drivers)('binds facade and model operations to ambient transactions on %s', async driver => {
    const { db, table } = await openDatabase(driver)
    const User = defineModelFromTable(table, { fillable: ['id', 'name'] })
    await expect(DB.transaction(async () => {
      await User.create({ id: 1, name: 'Discarded' })
      await DB.transaction(async () => {
        await User.where('id', 1).update({ name: 'Nested' })
      })
      expect(await User.where('id', 1).value('name')).toBe('Nested')
      throw new Error('abort ambient')
    })).rejects.toThrow('abort ambient')
    expect(await User.count()).toBe(0)
    await User.create({ id: 2, name: 'Outside' })
    expect(await db.table(table).pluck('name')).toEqual(['Outside'])
    await db.transaction(async tx => {
      await expect(tx.disconnect()).rejects.toThrow(TransactionError)
    })
  })

  it('routes simultaneous named connections without leaking ambient scopes', async () => {
    const first = await openDatabase('sqlite', { connectionName: 'first' })
    const second = await openDatabase('postgres', { connectionName: 'second' })
    configureDB(createConnectionManager({ defaultConnection: 'first', connections: { first: first.db, second: second.db } }))
    let secondSettled = () => {}
    const settled = new Promise<void>(resolve => { secondSettled = resolve })
    await Promise.all([
      DB.connection('first').transaction(async () => {
        await settled
        await DB.table(first.table).insert({ id: 1, name: 'First' })
      }),
      DB.connection('second').transaction(async () => {
        await DB.table(second.table).insert({ id: 1, name: 'Second' })
      }).finally(() => secondSettled()),
    ])
    expect(await first.db.table(first.table).pluck('name')).toEqual(['First'])
    expect(await second.db.table(second.table).pluck('name')).toEqual(['Second'])
    expect(DB.connection().getConnectionName()).toBe('first')
    expect(() => DB.connection('missing')).toThrow(ConfigurationError)
  })

  it('rejects unsafe SQL and malformed operations without changing stored rows', async () => {
    const { db, table } = await openDatabase()
    await db.table(table).insert({ id: 1, name: 'Preserved' })
    const sql = `DELETE FROM "${table.tableName}"`
    await expect(db.unsafeExecute(unsafeSql(sql))).rejects.toThrow(SecurityError)
    await expect(db.executeCompiled({ sql, bindings: [], unsafe: true })).rejects.toThrow(SecurityError)
    const controller = new AbortController()
    controller.abort('cancel')
    await expect(db.executeCompiled({ sql, bindings: [] }, { signal: controller.signal })).rejects.toMatchObject({ code: 'DRIVER_OPERATION_ABORTED' })
    await expect(db.executeCompiled({ sql, bindings: [] }, { timeoutMs: 0 })).rejects.toThrow('positive integers')
    expect(await db.table(table).pluck('name')).toEqual(['Preserved'])
  })

  it('executes opted-in SQL and redacts actual query logs', async () => {
    const queries: QuerySuccessLog[] = []
    const { db, table } = await openDatabase('sqlite', { security: { allowUnsafeRawSql: true }, logger: {
      onQuerySuccess(entry) { queries.push(entry) },
    } })
    await db.table(table).insert({ id: 1, name: 'secret@example.test' })
    queries.length = 0
    const result = await db.unsafeQuery<{ name: string }>(unsafeSql(`SELECT name FROM "${table.tableName}" WHERE id = ?`, [1]))
    expect(result.rows).toEqual([{ name: 'secret@example.test' }])
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toBe('[SQL REDACTED]')
    expect(queries[0]?.bindings).toEqual(['[REDACTED]'])
    expect(queries[0]?.rowCount).toBe(1)
    expect((await db.unsafeExecute(unsafeSql(`DELETE FROM "${table.tableName}" WHERE id = ?`, [1]))).affectedRows).toBe(1)
    expect(await db.table(table).count()).toBe(0)
  })

  it('reports real driver failures through typed errors and logger entries', async () => {
    const errors: QueryErrorLog[] = []
    const { db } = await openDatabase('sqlite', { logger: { onQueryError(entry) { errors.push(entry) } } })
    await expect(db.queryCompiled({ sql: 'SELECT * FROM missing_table', bindings: [] })).rejects.toMatchObject({ code: 'DRIVER_QUERY_ERROR', cause: expect.any(Error) })
    await expect(db.executeCompiled({ sql: 'DELETE FROM missing_table', bindings: [] })).rejects.toMatchObject({ code: 'DRIVER_EXECUTE_ERROR', cause: expect.any(Error) })
    expect(errors.map(entry => entry.kind)).toEqual(['query', 'execute'])
  })

  it('times out and aborts native PostgreSQL work without poisoning later reads', async () => {
    const starts: string[] = []
    const { db, table } = await openDatabase('postgres', { logger: { onQueryStart() { starts.push('start') } } })
    const sql = 'SELECT pg_sleep(0.1)'
    await expect(db.queryCompiled({ sql, bindings: [] }, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'DRIVER_OPERATION_TIMEOUT' })
    starts.length = 0
    const controller = new AbortController()
    const pending = db.queryCompiled({ sql, bindings: [] }, { signal: controller.signal })
    const rejection = expect(pending).rejects.toMatchObject({ code: 'DRIVER_OPERATION_ABORTED' })
    await vi.waitFor(() => expect(starts).toHaveLength(1))
    controller.abort('cancel active')
    await rejection
    await db.table(table).insert({ id: 1, name: 'Healthy' })
    expect(await db.table(table).pluck('name')).toEqual(['Healthy'])
  })

  it('rolls back a native deferred constraint failure at commit', async () => {
    const { db, adapter } = await openDatabase()
    await adapter.execute('PRAGMA foreign_keys = ON')
    await adapter.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
    await adapter.execute('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)')
    await expect(db.transaction(tx => tx.table('child').insert({ id: 1, parent_id: 42 }))).rejects.toThrow(TransactionError)
    expect(await db.table('child').count()).toBe(0)
    await db.transaction(async tx => {
      await tx.table('parent').insert({ id: 42 })
      await tx.table('child').insert({ id: 2, parent_id: 42 })
    })
    expect(await db.table('child').pluck('id')).toEqual([2])
  })

  it('initializes and disconnects native contexts idempotently', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
    await Promise.all([db.initialize(), db.initialize()])
    await db.executeCompiled({ sql: 'CREATE TABLE records (id INTEGER PRIMARY KEY)', bindings: [] })
    await db.table('records').insert({ id: 1 })
    expect(await db.table('records').count()).toBe(1)
    await db.disconnect()
    await db.disconnect()
    expect(db.isConnected()).toBe(false)
  })
  it('enforces native PostgreSQL scheduler backpressure and accepts later work', async () => {
    let notifyStarted = () => {}
    const { db, table } = await openDatabase('postgres', {
      concurrency: { maxConcurrentQueries: 1, queueLimit: 0 },
      logger: { onQueryStart() { notifyStarted() } },
    })
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const running = db.queryCompiled({ sql: 'SELECT pg_sleep(0.05)', bindings: [] })
    await started
    await expect(db.table(table).count()).rejects.toThrow('Query scheduler queue limit exceeded')
    await running
    expect(await db.table(table).count()).toBe(0)
  })

  it('rejects invalid concurrency settings before opening a native connection', () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => adapter.disconnect())
    expect(() => createDatabase({ adapter, dialect: createDialect('sqlite'), concurrency: { maxConcurrentQueries: 0 } })).toThrow(ConfigurationError)
    expect(() => createDatabase({ adapter, dialect: createDialect('sqlite'), concurrency: { queueLimit: -1 } })).toThrow(ConfigurationError)
  })

  it('fails facade access after reset without disturbing a standalone native context', async () => {
    const { db, table } = await openDatabase()
    await db.table(table).insert({ id: 1, name: 'Independent' })
    resetDB()
    expect(() => DB.connection()).toThrow(ConfigurationError)
    expect(await db.table(table).pluck('name')).toEqual(['Independent'])
  })

  it('exposes typed database errors with codes and causes', () => {
    const cause = new Error('root cause')

    const errors = [
      new DatabaseError('base', 'BASE', cause),
      new ConfigurationError('config', cause),
      new CompilerError('compiler', cause),
      new CapabilityError('capability', cause),
      new SecurityError('security', cause),
      new SchemaError('schema', cause),
      new RelationError('relation', cause),
      new TransactionError('transaction', cause),
      new HydrationError('hydrate', cause),
      new ModelNotFoundException('User', 'User not found', cause),
      new SerializationError('serialize', cause),
    ]

    expect(errors.map(error => error.name)).toEqual([
      'DatabaseError',
      'ConfigurationError',
      'CompilerError',
      'CapabilityError',
      'SecurityError',
      'SchemaError',
      'RelationError',
      'TransactionError',
      'HydrationError',
      'ModelNotFoundException',
      'SerializationError',
    ])
    expect(errors.map(error => error.code)).toEqual([
      'BASE',
      'CONFIGURATION_ERROR',
      'COMPILER_ERROR',
      'CAPABILITY_ERROR',
      'SECURITY_ERROR',
      'SCHEMA_ERROR',
      'RELATION_ERROR',
      'TRANSACTION_ERROR',
      'HYDRATION_ERROR',
      'MODEL_NOT_FOUND',
      'SERIALIZATION_ERROR',
    ])
    expect(errors.every(error => error.cause === cause)).toBe(true)

    const mnf = new ModelNotFoundException('Post')
    expect(mnf.model).toBe('Post')
    expect(mnf.statusCode).toBe(404)
    expect(mnf.message).toBe('Post not found.')
    expect(mnf.code).toBe('MODEL_NOT_FOUND')

    const mnfCustom = new ModelNotFoundException('User', 'User record not found for key "42".')
    expect(mnfCustom.model).toBe('User')
    expect(mnfCustom.message).toBe('User record not found for key "42".')
  })
})

describe('security policy helpers', () => {
  it('creates policy defaults and supports explicit overrides', () => {
    expect(createSecurityPolicy()).toEqual({
      allowUnsafeRawSql: false,
      debugSqlInLogs: false,
      maxQueryComplexity: undefined,
      redactBindingsInLogs: true,
      maxLoggedBindings: 25 })

    expect(createSecurityPolicy({
      allowUnsafeRawSql: true,
      debugSqlInLogs: true,
      maxQueryComplexity: 5,
      redactBindingsInLogs: false,
      maxLoggedBindings: 2 })).toEqual({
      allowUnsafeRawSql: true,
      debugSqlInLogs: true,
      maxQueryComplexity: 5,
      redactBindingsInLogs: false,
      maxLoggedBindings: 2 })
  })

  it('redacts or exposes bindings based on policy and respects log limits', () => {
    expect(redactBindings([1, 2, 3], createSecurityPolicy())).toEqual([
      '[REDACTED]',
      '[REDACTED]',
      '[REDACTED]',
    ])

    expect(redactBindings([1, 2, 3], createSecurityPolicy({
      redactBindingsInLogs: false,
      maxLoggedBindings: 2 }))).toEqual([1, 2])
  })

  it('redacts or exposes SQL text based on policy', () => {
    expect(redactSql('select 1', createSecurityPolicy())).toBe('[SQL REDACTED]')
    expect(redactSql('select 1', createSecurityPolicy({
      debugSqlInLogs: true }))).toBe('select 1')
  })
})
