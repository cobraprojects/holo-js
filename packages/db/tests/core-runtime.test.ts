import { describe, expect, it } from 'vitest'
import {
  CapabilityError,
  CompilerError,
  ConnectionManager,
  ConfigurationError,
  DB,
  DatabaseContext,
  DatabaseError,
  HydrationError,
  ModelNotFoundException,
  RelationError,
  SchemaError,
  SecurityError,
  SerializationError,
  TransactionError,
  column,
  connectionAsyncContext,
  configureDB,
  createQueryScheduler,
  createCapabilities,
  createConnectionManager,
  createDatabase,
  defineFactory,
  defineMigration,
  defineModel,
  createModelRegistry,
  createSchemaRegistry,
  createSecurityPolicy,
  redactBindings,
  redactSql,
  resetDB,
  resolveMorphModel,
  unsafeSql,
  type DatabaseLogger,
  type Dialect,
  type DriverAdapter,
  type UnsafeStatement,
  type DriverQueryResult } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

class FakeAdapter implements DriverAdapter {
  connected = false
  readonly calls: string[] = []
  failQuery = false
  failExecute = false
  failBegin = false
  failCommit = false
  failRollback = false
  failCreateSavepoint = false
  failRollbackToSavepoint = false
  failReleaseSavepoint = false

  async initialize(): Promise<void> {
    this.calls.push('initialize')
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.calls.push('disconnect')
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ) {
    this.calls.push(`query:${sql}:${bindings.length}`)
    if (this.failQuery) throw new Error('query failed')
    return {
      rows: [{ ok: true, sql, bindingsCount: bindings.length }] as unknown as TRow[],
      rowCount: 1 }
  }

  async execute(sql: string, bindings: readonly unknown[] = []) {
    this.calls.push(`execute:${sql}:${bindings.length}`)
    if (this.failExecute) throw new Error('execute failed')
    return { affectedRows: bindings.length, lastInsertId: 7 }
  }

  async beginTransaction(): Promise<void> {
    this.calls.push('begin')
    if (this.failBegin) throw new Error('begin failed')
  }

  async commit(): Promise<void> {
    this.calls.push('commit')
    if (this.failCommit) throw new Error('commit failed')
  }

  async rollback(): Promise<void> {
    this.calls.push('rollback')
    if (this.failRollback) throw new Error('rollback failed')
  }

  async createSavepoint(name: string): Promise<void> {
    this.calls.push(`savepoint:${name}`)
    if (this.failCreateSavepoint) throw new Error('savepoint failed')
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    this.calls.push(`rollback-to:${name}`)
    if (this.failRollbackToSavepoint) throw new Error('rollback to savepoint failed')
  }

  async releaseSavepoint(name: string): Promise<void> {
    this.calls.push(`release:${name}`)
    if (this.failReleaseSavepoint) throw new Error('release savepoint failed')
  }
}

class DelayedAdapter extends FakeAdapter {
  activeQueries = 0
  maxConcurrentQueries = 0
  private readonly blockedQueries: Promise<void>[] = []
  private readonly releaseBlockedQueries: Array<() => void> = []

  blockNextQuery(): void {
    const blocked = new Promise<void>((resolve) => {
      this.releaseBlockedQueries.push(resolve)
    })
    this.blockedQueries.push(blocked)
  }

  unblockNextQuery(): void {
    this.releaseBlockedQueries.shift()?.()
  }

  override async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ) {
    this.calls.push(`query:${sql}:${bindings.length}`)
    this.activeQueries += 1
    this.maxConcurrentQueries = Math.max(this.maxConcurrentQueries, this.activeQueries)

    try {
      const blocked = this.blockedQueries.shift()
      if (blocked) {
        await blocked
      }

      if (this.failQuery) throw new Error('query failed')
      return {
        rows: [{ ok: true, sql, bindingsCount: bindings.length }] as unknown as TRow[],
        rowCount: 1 }
    } finally {
      this.activeQueries -= 1
    }
  }
}

class SlowAdapter extends FakeAdapter {
  constructor(
    private readonly queryDelayMs = 0,
    private readonly executeDelayMs = 0,
    private readonly beginDelayMs = 0,
  ) {
    super()
  }

  override async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    await this.wait(this.queryDelayMs)
    return super.query(sql, bindings)
  }

  override async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ) {
    await this.wait(this.executeDelayMs)
    return super.execute(sql, bindings)
  }

  override async beginTransaction(): Promise<void> {
    await this.wait(this.beginDelayMs)
    await super.beginTransaction()
  }

  private async wait(delayMs: number): Promise<void> {
    if (delayMs < 1) {
      return
    }

    await new Promise<void>(resolve => setTimeout(resolve, delayMs))
  }
}

class PrewrappedQueryAdapter extends FakeAdapter {
  override async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    _sql: string,
    _bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    throw new DatabaseError('already wrapped query', 'PREWRAPPED_QUERY')
  }
}

class PrewrappedBeginAdapter extends FakeAdapter {
  override async beginTransaction(): Promise<void> {
    throw new TransactionError('already wrapped begin')
  }
}

class StringThrowingQueryAdapter extends FakeAdapter {
  override async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    _sql: string,
    _bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    throw 'string query failure'
  }
}

class StringThrowingBeginAdapter extends FakeAdapter {
  override async beginTransaction(): Promise<void> {
    throw 'string begin failure'
  }
}

function createDialect(savepoints = false): Dialect {
  return {
    name: savepoints ? 'sqlite-savepoint' : 'sqlite-basic',
    capabilities: createCapabilities({
      savepoints,
      returning: true,
      introspection: true }),
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

function createConcurrentDialect(savepoints = false): Dialect {
  return {
    name: savepoints ? 'postgres-savepoint' : 'postgres-basic',
    capabilities: createCapabilities({
      savepoints,
      returning: true,
      introspection: true,
      concurrentQueries: true }),
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `$${index}`
    } }
}

function createWorkerDialect(): Dialect {
  return {
    name: 'sqlite-worker',
    capabilities: createCapabilities({
      returning: true,
      workerThreadExecution: true }),
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

function createMySQLDialect(): Dialect {
  return {
    name: 'mysql-basic',
    capabilities: createCapabilities({
      returning: true,
      introspection: true,
      concurrentQueries: true }),
    quoteIdentifier(identifier: string) {
      return `\`${identifier}\``
    },
    createPlaceholder() {
      return '?'
    } }
}

function createLoggerSink() {
  const entries: string[] = []

  const logger: DatabaseLogger = {
    onQueryStart(entry) {
      entries.push(`start:${entry.kind}:${entry.scope}:${entry.bindings.join(',')}`)
    },
    onQuerySuccess(entry) {
      entries.push(`success:${entry.kind}:${entry.scope}:${entry.rowCount ?? entry.affectedRows ?? 0}`)
    },
    onQueryError(entry) {
      entries.push(`error:${entry.kind}:${entry.scope}:${String((entry.error as Error).message)}`)
    },
    onTransactionStart(entry) {
      entries.push(`tx-start:${entry.scope}:${entry.depth}:${entry.savepointName ?? '-'}`)
    },
    onTransactionCommit(entry) {
      entries.push(`tx-commit:${entry.scope}:${entry.depth}:${entry.savepointName ?? '-'}`)
    },
    onTransactionRollback(entry) {
      entries.push(`tx-rollback:${entry.scope}:${entry.depth}:${entry.savepointName ?? '-'}:${String((entry.error as Error | undefined)?.message ?? '-')}`)
    } }

  return { entries, logger }
}

describe('new core runtime slice', () => {
  it('exposes the expanded capability contract for concurrency-oriented features', () => {
    expect(createCapabilities()).toMatchObject({
      returning: false,
      savepoints: false,
      concurrentQueries: false,
      workerThreadExecution: false })
  })

  it('creates a context and exposes merged security policy and capabilities', () => {
    const adapter = new FakeAdapter()
    const schemaRegistry = createSchemaRegistry()
    const modelRegistry = createModelRegistry()
    const db = createDatabase({
      connectionName: 'main',
      adapter,
      dialect: createDialect(),
      schemaRegistry,
      modelRegistry,
      security: {
        allowUnsafeRawSql: true,
        maxLoggedBindings: 3 } })

    expect(db).toBeInstanceOf(DatabaseContext)
    expect(db.getDriver()).toBe('sqlite-basic')
    expect(db.getConnectionName()).toBe('main')
    expect(db.getAdapter()).toBe(adapter)
    expect(db.getDialect().name).toBe('sqlite-basic')
    expect(db.getLogger()).toBeUndefined()
    expect(db.getScope()).toMatchObject({ kind: 'root', depth: 0 })
    expect(db.getSchemaRegistry()).toBe(schemaRegistry)
    expect(db.getModelRegistry()).toBe(modelRegistry)
    expect(db.getCapabilities()).toMatchObject({
      returning: true,
      savepoints: false,
      concurrentQueries: false,
      workerThreadExecution: false,
      introspection: true })
    expect(db.getSecurityPolicy()).toMatchObject({
      allowUnsafeRawSql: true,
      debugSqlInLogs: false,
      redactBindingsInLogs: true,
      maxLoggedBindings: 3 })
    expect(db.getConcurrencyOptions()).toEqual({})
  })

  it('throws configuration errors when adapter or dialect are missing', () => {
    expect(() => new DatabaseContext({
      adapter: undefined as unknown as DriverAdapter,
      dialect: createDialect() })).toThrow('DatabaseContext requires an adapter.')

    expect(() => new DatabaseContext({
      adapter: new FakeAdapter(),
      dialect: undefined as unknown as Dialect })).toThrow('DatabaseContext requires a dialect.')
  })

  it('rejects invalid concurrency configuration', () => {
    expect(() => createDatabase({
      adapter: new FakeAdapter(),
      dialect: createConcurrentDialect(),
      concurrency: {
        maxConcurrentQueries: 0 } })).toThrow(ConfigurationError)

    expect(() => createDatabase({
      adapter: new FakeAdapter(),
      dialect: createConcurrentDialect(),
      concurrency: {
        queueLimit: -1 } })).toThrow(ConfigurationError)
  })

  it('initializes and disconnects idempotently on the root context', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect() })

    await db.initialize()
    await db.initialize()
    expect(db.isConnected()).toBe(true)
    expect(adapter.calls.filter(call => call === 'initialize')).toHaveLength(1)

    await db.disconnect()
    await db.disconnect()
    expect(db.isConnected()).toBe(false)
    expect(adapter.calls.filter(call => call === 'disconnect')).toHaveLength(1)
  })

  it('rejects disconnecting a transaction-scoped context directly', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect() })

    await db.transaction(async (tx) => {
      await expect(tx.disconnect()).rejects.toThrow(TransactionError)
    })
  })

  it('blocks unsafe raw SQL by default', async () => {
    const db = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect() })

    await expect(db.unsafeQuery(unsafeSql('select 1'))).rejects.toThrow(SecurityError)
    await expect(db.unsafeExecute(unsafeSql('delete from users'))).rejects.toThrow(SecurityError)
  })

  it('executes unsafe query and execute calls when the policy allows them and redacts logs', async () => {
    const adapter = new FakeAdapter()
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      logger,
      security: {
        allowUnsafeRawSql: true } })

    await db.initialize()
    const result = await db.unsafeQuery(unsafeSql(
      'select * from users where email = ?',
      ['a@example.com'],
      'unit-test',
    ))
    const execution = await db.unsafeExecute(unsafeSql(
      'delete from users where id = ?',
      [7],
    ))

    expect(result.rows).toHaveLength(1)
    expect(result.rowCount).toBe(1)
    expect(execution).toMatchObject({ affectedRows: 1, lastInsertId: 7 })
    expect(entries).toContain('start:query:root:[REDACTED]')
    expect(entries).toContain('success:query:root:1')
    expect(entries).toContain('start:execute:root:[REDACTED]')
    expect(entries).toContain('success:execute:root:1')
  })

  it('redacts SQL text in query logs by default and exposes it only in debug SQL mode', async () => {
    const hiddenEntries: string[] = []
    const visibleEntries: string[] = []

    const hiddenDb = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(),
      logger: {
        onQueryStart(entry) {
          hiddenEntries.push(entry.sql)
        } },
      security: {
        allowUnsafeRawSql: true } })

    const visibleDb = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(),
      logger: {
        onQueryStart(entry) {
          visibleEntries.push(entry.sql)
        } },
      security: {
        allowUnsafeRawSql: true,
        debugSqlInLogs: true } })

    await hiddenDb.unsafeQuery(unsafeSql('select * from users where id = ?', [1]))
    await visibleDb.unsafeQuery(unsafeSql('select * from users where id = ?', [1]))

    expect(hiddenEntries).toEqual(['[SQL REDACTED]'])
    expect(visibleEntries).toEqual(['select * from users where id = ?'])
  })

  it('executes compiled statements without requiring unsafe raw policy and shares schema registry through transactions', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true) })

    const query = await db.queryCompiled({
      sql: 'select compiled',
      bindings: [1, 2],
      source: 'compiled:test' })
    const execution = await db.executeCompiled({
      sql: 'delete compiled',
      bindings: [3],
      source: 'compiled:test' })

    expect(query.rowCount).toBe(1)
    expect(execution.affectedRows).toBe(1)
    expect(adapter.calls).toContain('query:select compiled:2')
    expect(adapter.calls).toContain('execute:delete compiled:1')

    const queryWithoutBindings = await db.queryCompiled({
      sql: 'select compiled no bindings',
      source: 'compiled:test' })
    expect(queryWithoutBindings.rowCount).toBe(1)
    expect(adapter.calls).toContain('query:select compiled no bindings:0')

    await db.transaction(async (tx) => {
      expect(tx.getSchemaRegistry()).toBe(db.getSchemaRegistry())
    })
  })

  it('enforces unsafe policy for compiled statements marked unsafe', async () => {
    const adapter = new FakeAdapter()
    const denied = createDatabase({
      adapter,
      dialect: createDialect(true) })

    await expect(denied.queryCompiled({
      unsafe: true,
      sql: 'select compiled unsafe',
      bindings: [],
      source: 'compiled:unsafe' })).rejects.toThrow(SecurityError)
    await expect(denied.executeCompiled({
      unsafe: true,
      sql: 'delete compiled unsafe',
      bindings: [],
      source: 'compiled:unsafe' })).rejects.toThrow(SecurityError)

    const allowed = createDatabase({
      adapter,
      dialect: createDialect(true),
      security: { allowUnsafeRawSql: true } })

    await expect(allowed.queryCompiled({
      unsafe: true,
      sql: 'select compiled unsafe',
      bindings: [],
      source: 'compiled:unsafe' })).resolves.toMatchObject({ rowCount: 1 })
    await expect(allowed.executeCompiled({
      unsafe: true,
      sql: 'delete compiled unsafe',
      bindings: [],
      source: 'compiled:unsafe' })).resolves.toMatchObject({ affectedRows: 0 })
  })

  it('logs query and execute failures before rethrowing', async () => {
    const adapter = new FakeAdapter()
    adapter.connected = true
    adapter.failQuery = true
    adapter.failExecute = true
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      logger,
      security: {
        allowUnsafeRawSql: true } })

    const queryError = await db.unsafeQuery(unsafeSql('select broken')).catch(error => error)
    const executeError = await db.unsafeExecute(unsafeSql('delete broken')).catch(error => error)

    expect(queryError).toBeInstanceOf(DatabaseError)
    expect((queryError as DatabaseError).code).toBe('DRIVER_QUERY_ERROR')
    expect((queryError as DatabaseError).cause).toBeInstanceOf(Error)
    expect((queryError as DatabaseError).message).toContain('query failed')

    expect(executeError).toBeInstanceOf(DatabaseError)
    expect((executeError as DatabaseError).code).toBe('DRIVER_EXECUTE_ERROR')
    expect((executeError as DatabaseError).cause).toBeInstanceOf(Error)
    expect((executeError as DatabaseError).message).toContain('execute failed')

    expect(entries.some(entry => entry.includes('error:query:root:Connection'))).toBe(true)
    expect(entries.some(entry => entry.includes('error:execute:root:Connection'))).toBe(true)
  })

  it('passes through existing framework database errors without rewrapping', async () => {
    const queryDb = createDatabase({
      adapter: new PrewrappedQueryAdapter(),
      dialect: createDialect(),
      security: {
        allowUnsafeRawSql: true } })

    const beginDb = createDatabase({
      adapter: new PrewrappedBeginAdapter(),
      dialect: createDialect() })

    const queryError = await queryDb.unsafeQuery(unsafeSql('select wrapped')).catch(error => error)
    expect(queryError).toBeInstanceOf(DatabaseError)
    expect(queryError).toMatchObject({
      message: 'already wrapped query',
      code: 'PREWRAPPED_QUERY' })

    const beginError = await beginDb.transaction(async () => 'x').catch(error => error)
    expect(beginError).toBeInstanceOf(TransactionError)
    expect(beginError).toMatchObject({
      message: 'already wrapped begin',
      code: 'TRANSACTION_ERROR' })
  })

  it('normalizes non-Error driver throws for query and transaction hooks', async () => {
    const queryDb = createDatabase({
      adapter: new StringThrowingQueryAdapter(),
      dialect: createDialect(),
      security: {
        allowUnsafeRawSql: true } })
    const beginDb = createDatabase({
      adapter: new StringThrowingBeginAdapter(),
      dialect: createDialect() })

    const queryError = await queryDb.unsafeQuery(unsafeSql('select string throw')).catch(error => error)
    expect(queryError).toBeInstanceOf(DatabaseError)
    expect((queryError as DatabaseError).message).toContain('string query failure')

    const beginError = await beginDb.transaction(async () => 'x').catch(error => error)
    expect(beginError).toBeInstanceOf(TransactionError)
    expect((beginError as TransactionError).message).toContain('string begin failure')
  })

  it('runs non-transactional queries concurrently when the dialect supports it', async () => {
    const adapter = new DelayedAdapter()
    const db = createDatabase({
      adapter,
      dialect: createConcurrentDialect(),
      security: { allowUnsafeRawSql: true },
      concurrency: { maxConcurrentQueries: 2 } })

    adapter.blockNextQuery()
    adapter.blockNextQuery()

    const first = db.unsafeQuery(unsafeSql('select one'))
    const second = db.unsafeQuery(unsafeSql('select two'))

    await Promise.resolve()
    expect(adapter.maxConcurrentQueries).toBe(2)

    adapter.unblockNextQuery()
    adapter.unblockNextQuery()
    await Promise.all([first, second])
  })

  it('serializes transactional queries even when root queries can run concurrently', async () => {
    const adapter = new DelayedAdapter()
    const db = createDatabase({
      adapter,
      dialect: createConcurrentDialect(true),
      security: { allowUnsafeRawSql: true },
      concurrency: { maxConcurrentQueries: 4 } })

    await db.transaction(async (tx) => {
      adapter.blockNextQuery()
      adapter.blockNextQuery()

      const first = tx.unsafeQuery(unsafeSql('select tx one'))
      const second = tx.unsafeQuery(unsafeSql('select tx two'))

      await Promise.resolve()
      expect(adapter.maxConcurrentQueries).toBe(1)

      adapter.unblockNextQuery()
      adapter.unblockNextQuery()
      await Promise.all([first, second])
    })
  })

  it('fails closed when the query scheduler queue limit is exceeded', async () => {
    const adapter = new DelayedAdapter()
    const db = createDatabase({
      adapter,
      dialect: createConcurrentDialect(),
      security: { allowUnsafeRawSql: true },
      concurrency: {
        maxConcurrentQueries: 1,
        queueLimit: 0 } })

    adapter.blockNextQuery()
    const running = db.unsafeQuery(unsafeSql('select blocked'))

    await Promise.resolve()
    await expect(db.unsafeQuery(unsafeSql('select overflow'))).rejects.toThrow(
      'Query scheduler queue limit exceeded for connection "default".',
    )

    adapter.unblockNextQuery()
    await running
  })

  it('uses worker scheduling mode when the dialect supports it and the connection prefers worker threads', async () => {
    const adapter = new FakeAdapter()
    let schedulingMode: string | undefined
    const db = createDatabase({
      adapter,
      dialect: createWorkerDialect(),
      security: { allowUnsafeRawSql: true },
      concurrency: { workerThreads: true },
      logger: {
        onQuerySuccess(entry) {
          schedulingMode = entry.schedulingMode
        } } })

    await db.unsafeQuery(unsafeSql('select worker mode'))

    expect(schedulingMode).toBe('worker')
  })

  it('rejects aborted and invalid runtime operation options before executing driver work', async () => {
    const adapter = new FakeAdapter()
    const controller = new AbortController()
    controller.abort('stop')

    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    const abortedQuery = await db.unsafeQuery(unsafeSql('select aborted'), {
      signal: controller.signal }).catch(error => error)
    const abortedExecute = await db.executeCompiled({
      sql: 'delete aborted',
      bindings: [] }, {
      signal: controller.signal }).catch(error => error)

    expect(abortedQuery).toBeInstanceOf(DatabaseError)
    expect((abortedQuery as DatabaseError).code).toBe('DRIVER_OPERATION_ABORTED')
    expect(abortedExecute).toBeInstanceOf(DatabaseError)
    expect((abortedExecute as DatabaseError).code).toBe('DRIVER_OPERATION_ABORTED')
    expect(adapter.calls).toEqual([])

    await expect(db.queryCompiled({
      sql: 'select invalid timeout',
      bindings: [] }, {
      timeoutMs: 0 })).rejects.toThrow('Database operation timeouts must be positive integers in milliseconds.')
  })

  it('rejects timed out query and execute operations with typed driver errors', async () => {
    const adapter = new SlowAdapter(25, 25)
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    const queryError = await db.unsafeQuery(unsafeSql('select timeout'), {
      timeoutMs: 5 }).catch(error => error)
    const executeError = await db.executeCompiled({
      sql: 'delete timeout',
      bindings: [] }, {
      timeoutMs: 5 }).catch(error => error)

    expect(queryError).toBeInstanceOf(DatabaseError)
    expect((queryError as DatabaseError).code).toBe('DRIVER_OPERATION_TIMEOUT')
    expect(executeError).toBeInstanceOf(DatabaseError)
    expect((executeError as DatabaseError).code).toBe('DRIVER_OPERATION_TIMEOUT')
  })

  it('supports successful and failing guarded operations when timeout hooks are present but not triggered', async () => {
    const successAdapter = new SlowAdapter(1, 1)
    const successDb = createDatabase({
      adapter: successAdapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    await expect(successDb.unsafeQuery(unsafeSql('select guarded success'), {
      timeoutMs: 50 })).resolves.toMatchObject({ rowCount: 1 })

    const failingAdapter = new SlowAdapter(1)
    failingAdapter.failQuery = true
    const failingDb = createDatabase({
      adapter: failingAdapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    const failingError = await failingDb.unsafeQuery(unsafeSql('select guarded failure'), {
      timeoutMs: 50 }).catch(error => error)

    expect(failingError).toBeInstanceOf(DatabaseError)
    expect((failingError as DatabaseError).code).toBe('DRIVER_QUERY_ERROR')
  })

  it('rejects in-flight query work when the operation signal aborts after execution starts', async () => {
    const adapter = new SlowAdapter(25)
    const controller = new AbortController()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    const pending = db.unsafeQuery(unsafeSql('select mid-flight abort'), {
      signal: controller.signal }).catch(error => error)

    await new Promise<void>(resolve => setTimeout(resolve, 5))
    controller.abort('abort while running')

    const error = await pending
    expect(error).toBeInstanceOf(DatabaseError)
    expect((error as DatabaseError).code).toBe('DRIVER_OPERATION_ABORTED')
  })

  it('ignores late abort and driver failure signals after a timeout already settled the operation', async () => {
    const adapter = new SlowAdapter(25)
    adapter.failQuery = true
    const controller = new AbortController()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      security: { allowUnsafeRawSql: true } })

    const pending = db.unsafeQuery(unsafeSql('select timeout then fail'), {
      signal: controller.signal,
      timeoutMs: 1 }).catch(error => error)

    await new Promise<void>(resolve => setTimeout(resolve, 20))
    controller.abort('late abort')

    const error = await pending
    expect(error).toBeInstanceOf(DatabaseError)
    expect((error as DatabaseError).code).toBe('DRIVER_OPERATION_TIMEOUT')

    await new Promise<void>(resolve => setTimeout(resolve, 30))
  })

  it('rejects aborted and timed out transaction hooks with typed transaction errors', async () => {
    const abortedAdapter = new FakeAdapter()
    const abortedController = new AbortController()
    abortedController.abort('cancel transaction')

    const abortedDb = createDatabase({
      adapter: abortedAdapter,
      dialect: createDialect() })

    const abortedError = await abortedDb.transaction(async () => 'x', {
      signal: abortedController.signal }).catch(error => error)

    expect(abortedError).toBeInstanceOf(TransactionError)
    expect((abortedError as TransactionError).message).toContain('aborted')
    expect(abortedAdapter.calls).toEqual(['initialize'])

    const timeoutAdapter = new SlowAdapter(0, 0, 25)
    const timeoutDb = createDatabase({
      adapter: timeoutAdapter,
      dialect: createDialect() })

    const timeoutError = await timeoutDb.transaction(async () => 'x', {
      timeoutMs: 5 }).catch(error => error)

    expect(timeoutError).toBeInstanceOf(TransactionError)
    expect((timeoutError as TransactionError).message).toContain('timed out')
  })

  it('rejects runtime raw statements that are not explicitly marked unsafe', async () => {
    const db = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(),
      security: {
        allowUnsafeRawSql: true } })

    await expect(db.unsafeQuery({ sql: 'select 1' } as unknown as UnsafeStatement)).rejects.toThrow(SecurityError)
    await expect(db.unsafeExecute({ sql: 'delete from users' } as unknown as UnsafeStatement)).rejects.toThrow(SecurityError)
  })

  it('executes explicitly unsafe raw SQL without bindings when the policy allows it', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      security: {
        allowUnsafeRawSql: true } })

    await expect(db.unsafeQuery({ unsafe: true, sql: 'select bare' })).resolves.toMatchObject({ rowCount: 1 })
    await expect(db.unsafeExecute({ unsafe: true, sql: 'delete bare' })).resolves.toMatchObject({ affectedRows: 0 })
    expect(adapter.calls).toContain('query:select bare:0')
    expect(adapter.calls).toContain('execute:delete bare:0')
  })

  it('runs a root transaction and commits on success', async () => {
    const adapter = new FakeAdapter()
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      logger })

    const result = await db.transaction(async (tx) => {
      expect(tx.getScope()).toMatchObject({ kind: 'transaction', depth: 1 })
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(adapter.calls).toContain('initialize')
    expect(adapter.calls).toContain('begin')
    expect(adapter.calls).toContain('commit')
    expect(entries).toContain('tx-start:transaction:1:-')
    expect(entries).toContain('tx-commit:transaction:1:-')
  })

  it('registers transaction callbacks, rejects registration outside transactions, and runs them on commit and rollback', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
    })
    const events: string[] = []

    expect(() => db.afterCommit(() => {})).toThrow(TransactionError)
    expect(() => db.afterRollback(() => {})).toThrow(TransactionError)

    await db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:direct')
      })
      tx.afterRollback(() => {
        events.push('rollback:direct')
      })
    })

    await expect(db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:skipped')
      })
      tx.afterRollback(() => {
        events.push('rollback:direct')
      })
      throw new Error('rollback now')
    })).rejects.toThrow('rollback now')

    expect(events).toEqual([
      'commit:direct',
      'rollback:direct',
    ])
  })

  it('merges nested callbacks on savepoint commit, discards nested commit callbacks on rollback, and cleans callback state between transactions', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
    })
    const events: string[] = []

    await db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:root-before')
      })
      tx.afterRollback(() => {
        events.push('rollback:root')
      })

      await tx.transaction(async (nested) => {
        nested.afterCommit(() => {
          events.push('commit:nested')
        })
        nested.afterRollback(() => {
          events.push('rollback:nested')
        })
      })

      tx.afterCommit(() => {
        events.push('commit:root-after')
      })
    })

    await db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:outer-skipped')
      })
      tx.afterRollback(() => {
        events.push('rollback:outer')
      })

      await expect(tx.transaction(async (nested) => {
        nested.afterCommit(() => {
          events.push('commit:nested-skipped')
        })
        nested.afterRollback(() => {
          events.push('rollback:nested-immediate')
        })
        throw new Error('nested rollback')
      })).rejects.toThrow('nested rollback')
    })

    await expect(db.transaction(async (tx) => {
      tx.afterRollback(() => {
        events.push('rollback:outer-final')
      })

      await tx.transaction(async (nested) => {
        nested.afterRollback(() => {
          events.push('rollback:nested-merged')
        })
      })

      throw new Error('outer rollback')
    })).rejects.toThrow('outer rollback')

    await db.transaction(async () => {})

    expect(events).toEqual([
      'commit:root-before',
      'commit:nested',
      'commit:root-after',
      'rollback:nested-immediate',
      'commit:outer-skipped',
      'rollback:outer-final',
      'rollback:nested-merged',
    ])
  })

  it('rolls back a root transaction on callback failure', async () => {
    const adapter = new FakeAdapter()
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      logger })

    await expect(db.transaction(async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')

    expect(adapter.calls).toContain('rollback')
    expect(entries).toContain('tx-rollback:transaction:1:-:boom')
  })

  it('wraps transaction callback execution failures with typed transaction errors', async () => {
    const commitDb = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(true),
    })

    const commitError = await commitDb.transaction(async (tx) => {
      tx.afterCommit(() => {
        throw new Error('commit callback failed')
      })
      return 'x'
    }).catch(error => error)

    expect(commitError).toBeInstanceOf(TransactionError)
    expect((commitError as TransactionError).cause).toBeInstanceOf(Error)
    expect((commitError as TransactionError).message).toContain('afterCommit')

    const rollbackDb = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(true),
    })

    const rollbackError = await rollbackDb.transaction(async (tx) => {
      tx.afterRollback(() => {
        throw new Error('rollback callback failed')
      })
      throw new Error('force rollback')
    }).catch(error => error)

    expect(rollbackError).toBeInstanceOf(TransactionError)
    expect((rollbackError as TransactionError).cause).toBeInstanceOf(Error)
    expect((rollbackError as TransactionError).message).toContain('afterRollback')

    const stringThrowDb = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(true),
    })

    const stringThrowError = await stringThrowDb.transaction(async (tx) => {
      tx.afterCommit(() => {
        throw 'string callback failed'
      })
      return 'x'
    }).catch(error => error)

    expect(stringThrowError).toBeInstanceOf(TransactionError)
    expect((stringThrowError as TransactionError).message).toContain('string callback failed')
  })

  it('does not rollback or run rollback callbacks after an afterCommit callback fails', async () => {
    const db = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(true),
    })
    const adapter = db.getAdapter() as FakeAdapter
    const events: string[] = []

    await expect(db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:first')
        throw new Error('commit callback failed')
      })
      tx.afterCommit(() => {
        events.push('commit:second')
      })
      tx.afterRollback(() => {
        events.push('rollback:first')
      })
      tx.afterRollback(() => {
        events.push('rollback:second')
      })
    })).rejects.toThrow('commit callback failed')

    expect(events).toEqual([
      'commit:first',
    ])
    expect(adapter.calls).not.toContain('rollback')
  })

  it('still runs afterCommit callbacks when the commit logger throws after the transaction commits', async () => {
    const adapter = new FakeAdapter()
    const events: string[] = []
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
      logger: {
        onTransactionCommit() {
          throw new Error('commit logger failed')
        },
      },
    })

    await expect(db.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push('commit:callback')
      })
    })).rejects.toThrow('commit logger failed')

    expect(events).toEqual(['commit:callback'])
    expect(adapter.calls).toContain('commit')
    expect(adapter.calls).not.toContain('rollback')
  })

  it('does not roll back to a savepoint after that savepoint has already been released', async () => {
    const adapter = new FakeAdapter()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
      logger: {
        onTransactionCommit(entry) {
          if (entry.scope === 'savepoint') {
            throw new Error('savepoint commit logger failed')
          }
        },
      },
    })

    await expect(db.transaction(async (tx) => {
      await tx.transaction(async () => {})
    })).rejects.toThrow('savepoint commit logger failed')

    expect(adapter.calls).toContain('release:sp_0')
    expect(adapter.calls).not.toContain('rollback-to:sp_0')
  })

  it('wraps root transaction lifecycle failures with typed transaction errors', async () => {
    const beginAdapter = new FakeAdapter()
    beginAdapter.failBegin = true
    const beginDb = createDatabase({
      adapter: beginAdapter,
      dialect: createDialect() })

    const beginError = await beginDb.transaction(async () => 'x').catch(error => error)
    expect(beginError).toBeInstanceOf(TransactionError)
    expect((beginError as TransactionError).cause).toBeInstanceOf(Error)
    expect((beginError as TransactionError).message).toContain('failed to begin')

    const commitAdapter = new FakeAdapter()
    commitAdapter.failCommit = true
    const commitDb = createDatabase({
      adapter: commitAdapter,
      dialect: createDialect() })

    const commitError = await commitDb.transaction(async () => 'x').catch(error => error)
    expect(commitError).toBeInstanceOf(TransactionError)
    expect((commitError as TransactionError).cause).toBeInstanceOf(Error)
    expect((commitError as TransactionError).message).toContain('failed to commit')

    const rollbackAdapter = new FakeAdapter()
    rollbackAdapter.failRollback = true
    const rollbackDb = createDatabase({
      adapter: rollbackAdapter,
      dialect: createDialect() })

    const rollbackError = await rollbackDb.transaction(async () => {
      throw new Error('boom')
    }).catch(error => error)
    expect(rollbackError).toBeInstanceOf(TransactionError)
    expect((rollbackError as TransactionError).cause).toBeInstanceOf(Error)
    expect((rollbackError as TransactionError).message).toContain('failed to rollback')
  })

  it('logs rollback failures when root rollback itself fails', async () => {
    const adapter = new FakeAdapter()
    adapter.failRollback = true
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(),
      logger })

    const error = await db.transaction(async () => {
      throw new Error('boom')
    }).catch(caught => caught)

    expect(error).toBeInstanceOf(TransactionError)
    expect(entries.some(entry => entry.includes('tx-rollback:transaction:1:-:Connection'))).toBe(true)
  })

  it('uses savepoints for nested transactions when supported', async () => {
    const adapter = new FakeAdapter()
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
      logger })

    await db.transaction(async (tx) => {
      await tx.transaction(async (nested) => {
        expect(nested.getScope()).toMatchObject({
          kind: 'savepoint',
          depth: 2,
          savepointName: 'sp_0' })
      })
    })

    expect(adapter.calls).toContain('savepoint:sp_0')
    expect(adapter.calls).toContain('release:sp_0')
    expect(entries).toContain('tx-start:savepoint:2:sp_0')
    expect(entries).toContain('tx-commit:savepoint:2:sp_0')
  })

  it('rolls back to a savepoint when a nested transaction fails', async () => {
    const adapter = new FakeAdapter()
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
      logger })

    await expect(db.transaction(async (tx) => {
      await tx.transaction(async () => {
        throw new Error('nested boom')
      })
    })).rejects.toThrow('nested boom')

    expect(adapter.calls).toContain('rollback-to:sp_0')
    expect(entries).toContain('tx-rollback:savepoint:2:sp_0:nested boom')
    expect(entries).toContain('tx-rollback:transaction:1:-:nested boom')
  })

  it('wraps savepoint lifecycle failures with typed transaction errors', async () => {
    const createSavepointAdapter = new FakeAdapter()
    createSavepointAdapter.failCreateSavepoint = true
    const createSavepointDb = createDatabase({
      adapter: createSavepointAdapter,
      dialect: createDialect(true) })

    const createSavepointError = await createSavepointDb.transaction(async (tx) => {
      await tx.transaction(async () => 'x')
    }).catch(error => error)
    expect(createSavepointError).toBeInstanceOf(TransactionError)
    expect((createSavepointError as TransactionError).message).toContain('failed to createSavepoint')

    const releaseAdapter = new FakeAdapter()
    releaseAdapter.failReleaseSavepoint = true
    const releaseDb = createDatabase({
      adapter: releaseAdapter,
      dialect: createDialect(true) })

    const releaseError = await releaseDb.transaction(async (tx) => {
      await tx.transaction(async () => 'x')
    }).catch(error => error)
    expect(releaseError).toBeInstanceOf(TransactionError)
    expect((releaseError as TransactionError).message).toContain('failed to releaseSavepoint')

    const rollbackToAdapter = new FakeAdapter()
    rollbackToAdapter.failRollbackToSavepoint = true
    const rollbackToDb = createDatabase({
      adapter: rollbackToAdapter,
      dialect: createDialect(true) })

    const rollbackToError = await rollbackToDb.transaction(async (tx) => {
      await tx.transaction(async () => {
        throw new Error('nested boom')
      })
    }).catch(error => error)
    expect(rollbackToError).toBeInstanceOf(TransactionError)
    expect((rollbackToError as TransactionError).message).toContain('failed to rollbackToSavepoint')
  })

  it('logs rollback failures when savepoint rollback itself fails', async () => {
    const adapter = new FakeAdapter()
    adapter.failRollbackToSavepoint = true
    const { entries, logger } = createLoggerSink()
    const db = createDatabase({
      adapter,
      dialect: createDialect(true),
      logger })

    const error = await db.transaction(async (tx) => {
      await tx.transaction(async () => {
        throw new Error('nested boom')
      })
    }).catch(caught => caught)

    expect(error).toBeInstanceOf(TransactionError)
    expect(entries.some(entry => entry.includes('tx-rollback:savepoint:2:sp_0:Connection'))).toBe(true)
  })

  it('fails closed when nested transactions are requested without savepoint support', async () => {
    const db = createDatabase({
      adapter: new FakeAdapter(),
      dialect: createDialect(false) })

    await expect(db.transaction(async (tx) => {
      await tx.transaction(async () => 'x')
    })).rejects.toThrow(CapabilityError)
  })

  it('fails closed when the dialect claims savepoint support but the adapter does not implement it', async () => {
    const adapter: DriverAdapter = Object.assign(new FakeAdapter(), {
      createSavepoint: undefined,
      rollbackToSavepoint: undefined,
      releaseSavepoint: undefined })

    const db = createDatabase({
      adapter,
      dialect: createDialect(true) })

    await expect(db.transaction(async (tx) => {
      await tx.transaction(async () => 'x')
    })).rejects.toThrow(CapabilityError)
  })
})

describe('connection manager and facade', () => {
  it('resolves default and named connections', () => {
    const manager = createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new FakeAdapter(),
          dialect: createDialect() },
        analytics: {
          adapter: new FakeAdapter(),
          dialect: createDialect(true) } } })

    expect(manager).toBeInstanceOf(ConnectionManager)
    expect(manager.getDefaultConnectionName()).toBe('default')
    expect(manager.getConnectionNames()).toEqual(['default', 'analytics'])
    expect(manager.hasConnection('analytics')).toBe(true)
    expect(manager.connection().getConnectionName()).toBe('default')
    expect(manager.connection('analytics').getConnectionName()).toBe('analytics')
  })

  it('fails fast on invalid manager configuration or missing connection names', () => {
    expect(() => createConnectionManager({
      defaultConnection: '',
      connections: {} })).toThrow('ConnectionManager requires a defaultConnection.')

    expect(() => createConnectionManager({
      defaultConnection: 'missing-default',
      connections: {
        other: {
          adapter: new FakeAdapter(),
          dialect: createDialect() } } })).toThrow('ConnectionManager default connection "missing-default" is not defined.')

    const manager = createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new FakeAdapter(),
          dialect: createDialect() } } })

    expect(() => manager.connection('missing')).toThrow('Connection "missing" is not defined.')
  })

  it('fails fast when the DB facade is accessed without a configured manager', () => {
    resetDB()

    expect(() => DB.connection()).toThrow(
      'DB facade is not configured with a ConnectionManager.',
    )
    expect(() => DB.table('users')).toThrow(
      'DB facade is not configured with a ConnectionManager.',
    )
  })

  it('initializes and disconnects all resolved connections', async () => {
    const defaultAdapter = new FakeAdapter()
    const analyticsAdapter = new FakeAdapter()
    const manager = createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: defaultAdapter,
          dialect: createDialect() },
        analytics: {
          adapter: analyticsAdapter,
          dialect: createDialect() } } })

    manager.connection()
    manager.connection('analytics')
    await manager.initializeAll()
    expect(defaultAdapter.connected).toBe(true)
    expect(analyticsAdapter.connected).toBe(true)

    await manager.disconnectAll()
    expect(defaultAdapter.connected).toBe(false)
    expect(analyticsAdapter.connected).toBe(false)
  })

  it('reuses pre-built DatabaseContext instances and supports manager-level transactions', async () => {
    const adapter = new FakeAdapter()
    const existing = createDatabase({
      connectionName: 'existing',
      adapter,
      dialect: createDialect(true),
      security: { allowUnsafeRawSql: true },
      concurrency: { maxConcurrentQueries: 4, workerThreads: false } })

    const manager = createConnectionManager({
      defaultConnection: 'existing',
      connections: {
        existing } })

    expect(manager.connection()).toBe(existing)
    expect(manager.connection().getConcurrencyOptions()).toEqual({
      maxConcurrentQueries: 4,
      workerThreads: false })

    await manager.transaction(async (tx) => {
      expect(tx.getConnectionName()).toBe('existing')
      await tx.unsafeQuery(unsafeSql('select from manager tx'))
    })

    expect(adapter.calls).toContain('begin')
    expect(adapter.calls).toContain('query:select from manager tx:0')
    expect(adapter.calls).toContain('commit')
  })

  it('routes facade calls through the configured manager and tracks active transaction context', async () => {
    const defaultAdapter = new FakeAdapter()
    const analyticsAdapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: defaultAdapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true } },
        analytics: {
          adapter: analyticsAdapter,
          dialect: createDialect(),
          security: { allowUnsafeRawSql: true } } } }))

    expect(DB.connection().getConnectionName()).toBe('default')
    expect(DB.connection('analytics').getConnectionName()).toBe('analytics')
    expect(DB.table('users').getTableName()).toBe('users')
    expect(DB.table('users').getConnectionName()).toBe('default')

    await DB.unsafeQuery(unsafeSql('select 1', [1]))
    expect(defaultAdapter.calls).toContain('query:select 1:1')

    await DB.transaction(async (tx) => {
      expect(tx.getScope()).toMatchObject({ kind: 'transaction', depth: 1 })
      expect(DB.connection()).toBe(tx)
      expect(DB.table('posts').getConnection()).toBe(tx)
      await DB.unsafeExecute(unsafeSql('delete from posts where id = ?', [7]))
    })

    expect(defaultAdapter.calls).toContain('begin')
    expect(defaultAdapter.calls).toContain('execute:delete from posts where id = ?:1')

    const queryResult = await DB.table('users').unsafeQuery<{ ok: boolean }>({
      unsafe: true,
      sql: 'select * from users',
      bindings: [] })
    expect(queryResult.rowCount).toBe(1)

    const execution = await DB.table('users').unsafeExecute({
      unsafe: true,
      sql: 'delete from users where id = ?',
      bindings: [9] })
    expect(execution.affectedRows).toBe(1)

    resetDB()
  })

  it('rejects facade usage before configuration', () => {
    resetDB()
    expect(() => DB.getManager()).toThrow(ConfigurationError)
    expect(() => DB.connection()).toThrow(ConfigurationError)
  })

  it('clears facade configuration and morph registry state on reset so global process state does not leak', () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: new FakeAdapter(),
          dialect: createDialect() } } }))

    const users = defineTable('users', {
      id: column.id() })
    const User = defineModelFromTable(users, {
      name: 'User',
      morphClass: 'user-record' })

    expect(resolveMorphModel('user-record')).toBe(User)
    expect(DB.connection().getConnectionName()).toBe('default')

    resetDB()

    expect(() => DB.connection()).toThrow(ConfigurationError)
    expect(resolveMorphModel('user-record')).toBeUndefined()
  })

  it('isolates standalone contexts and schema registries in the same process', () => {
    const first = createDatabase({
      connectionName: 'first',
      adapter: new FakeAdapter(),
      dialect: createDialect() })
    const second = createDatabase({
      connectionName: 'second',
      adapter: new FakeAdapter(),
      dialect: createDialect() })

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    first.getSchemaRegistry().register(users)

    expect(first.getSchemaRegistry().has('users')).toBe(true)
    expect(second.getSchemaRegistry().has('users')).toBe(false)
    expect(first.getSchemaRegistry()).not.toBe(second.getSchemaRegistry())
  })

  it('tracks models in a per-context registry and shares that registry with transaction children', async () => {
    const db = createDatabase({
      connectionName: 'models',
      adapter: new FakeAdapter(),
      dialect: createDialect(true) })
    const users = defineTable('users', {
      id: column.id(),
      email: column.string() })
    const User = {
      definition: {
        kind: 'model' as const,
        name: 'User',
        table: users,
        primaryKey: 'id',
        morphClass: 'User',
        with: [],
        pendingAttributes: {},
        preventLazyLoading: false,
        preventAccessingMissingAttributes: false,
        automaticEagerLoading: false,
        timestamps: false,
        fillable: [],
        guarded: [],
        relations: {},
        casts: {},
        accessors: {},
        mutators: {},
        hidden: [],
        visible: [],
        appended: [],
        massPrunable: false,
        touches: [],
        replicationExcludes: [],
        softDeletes: false,
        events: {},
        observers: [] } }

    expect(db.getModelRegistry().has('User')).toBe(false)
    expect(db.registerModel(User)).toBe(User.definition)
    expect(db.getModelRegistry().get('User')).toBe(User.definition)
    expect(db.registerModel(User.definition)).toBe(User.definition)
    db.model(User)
    expect(db.getModelRegistry().list()).toEqual([User.definition])

    await db.transaction(async (tx) => {
      expect(tx.getModelRegistry()).toBe(db.getModelRegistry())
      expect(tx.getModelRegistry().get('User')).toBe(User.definition)
    })
  })

  it('isolates model registries across root contexts and rejects duplicate registrations by name', () => {
    const first = createDatabase({
      connectionName: 'first',
      adapter: new FakeAdapter(),
      dialect: createDialect() })
    const second = createDatabase({
      connectionName: 'second',
      adapter: new FakeAdapter(),
      dialect: createDialect() })
    const users = defineTable('users', {
      id: column.id() })
    const otherUsers = defineTable('other_users', {
      id: column.id() })
    const firstUser = {
      definition: {
        kind: 'model' as const,
        name: 'User',
        table: users,
        primaryKey: 'id',
        morphClass: 'User',
        with: [],
        pendingAttributes: {},
        preventLazyLoading: false,
        preventAccessingMissingAttributes: false,
        automaticEagerLoading: false,
        timestamps: false,
        fillable: [],
        guarded: [],
        relations: {},
        casts: {},
        accessors: {},
        mutators: {},
        hidden: [],
        visible: [],
        appended: [],
        massPrunable: false,
        touches: [],
        replicationExcludes: [],
        softDeletes: false,
        events: {},
        observers: [] } }
    const secondUser = {
      definition: {
        ...firstUser.definition,
        table: otherUsers } }

    first.registerModel(firstUser)
    second.registerModel(secondUser)

    expect(first.getModelRegistry()).not.toBe(second.getModelRegistry())
    expect(first.getModelRegistry().get('User')).toBe(firstUser.definition)
    expect(second.getModelRegistry().get('User')).toBe(secondUser.definition)
    expect(() => first.registerModel(secondUser)).toThrow('Model "User" is already registered.')
    first.getModelRegistry().clear()
    expect(first.getModelRegistry().list()).toEqual([])
  })

  it('exposes per-context migration, factory, and event services', async () => {
    const db = createDatabase({
      connectionName: 'services',
      adapter: new FakeAdapter(),
      dialect: createDialect(true) })
    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })
    const User = defineModelFromTable(users, {
      name: 'User',
      fillable: ['name'] })
    const migration = defineMigration({
      name: '2026_01_01_000001_create_users',
      async up() {} })
    const factory = defineFactory(User, () => ({ name: 'Amina' }))

    const migrations = db.getMigrationService()
    expect(db.getMigrationService()).toBe(migrations)
    migrations.register(migration)
    expect(migrations.getMigration(migration.name)).toBe(migration)

    const factories = db.getFactoryService()
    expect(db.getFactoryService()).toBe(factories)
    expect(factories.has('users')).toBe(false)
    expect(factories.get('users')).toBeUndefined()
    factories.register('users', factory)
    expect(factories.has('users')).toBe(true)
    expect(factories.register('users', factory)).toBe(factories)
    expect(factories.get('users')).toBe(factory)
    expect(factories.list()).toEqual([factory])
    expect(() => factories.register('users', defineFactory(User, () => ({ name: 'Other' })))).toThrow(
      'Factory "users" is already registered.',
    )
    factories.clear()
    expect(factories.list()).toEqual([])
    expect(factories.has('users')).toBe(false)

    const events = db.getEventService()
    expect(db.getEventService()).toBe(events)
    expect(events.areEventsMuted()).toBe(false)
    expect(events.areGuardsDisabled()).toBe(false)
    await events.withoutEvents(async () => {
      expect(events.areEventsMuted()).toBe(true)
    })
    await events.withoutGuards(async () => {
      expect(events.areGuardsDisabled()).toBe(true)
    })

    await db.transaction(async (tx) => {
      expect(tx.getMigrationService()).not.toBe(migrations)
      expect(tx.getFactoryService()).not.toBe(factories)
      expect(tx.getEventService()).not.toBe(events)
    })
  })

  it('supports different drivers in one process without leaking facade routing', async () => {
    const sqliteAdapter = new FakeAdapter()
    const postgresAdapter = new FakeAdapter()
    const mysqlAdapter = new FakeAdapter()

    configureDB(createConnectionManager({
      defaultConnection: 'sqlite',
      connections: {
        sqlite: createDatabase({
          connectionName: 'sqlite',
          driver: 'sqlite',
          adapter: sqliteAdapter,
          dialect: createDialect(),
          security: { allowUnsafeRawSql: true } }),
        postgres: createDatabase({
          connectionName: 'postgres',
          driver: 'postgres',
          adapter: postgresAdapter,
          dialect: createConcurrentDialect(),
          security: { allowUnsafeRawSql: true } }),
        mysql: createDatabase({
          connectionName: 'mysql',
          driver: 'mysql',
          adapter: mysqlAdapter,
          dialect: createMySQLDialect(),
          security: { allowUnsafeRawSql: true } }) } }))

    expect(DB.connection().getDriver()).toBe('sqlite')
    expect(DB.connection('postgres').getDriver()).toBe('postgres')
    expect(DB.connection('mysql').getDriver()).toBe('mysql')

    expect(DB.table('users').where('id', 1).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = ?1',
      bindings: [1],
      source: 'query:select:users' })
    expect(DB.table('users', 'postgres').where('id', 1).toSQL()).toEqual({
      sql: 'SELECT * FROM "users" WHERE "id" = $1',
      bindings: [1],
      source: 'query:select:users' })
    expect(DB.table('users', 'mysql').where('id', 1).toSQL()).toEqual({
      sql: 'SELECT * FROM `users` WHERE `id` = ?',
      bindings: [1],
      source: 'query:select:users' })

    await DB.unsafeQuery(unsafeSql('select sqlite'), 'sqlite')
    await DB.unsafeQuery(unsafeSql('select postgres'), 'postgres')
    await DB.unsafeQuery(unsafeSql('select mysql'), 'mysql')

    expect(sqliteAdapter.calls).toContain('query:select sqlite:0')
    expect(postgresAdapter.calls).toContain('query:select postgres:0')
    expect(mysqlAdapter.calls).toContain('query:select mysql:0')
  })

  it('does not leak async transaction context after a transaction completes', async () => {
    const adapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true } } } }))

    const defaultConnection = DB.connection()

    await DB.transaction(async (tx) => {
      expect(DB.connection()).toBe(tx)
      await Promise.resolve()
      expect(DB.connection()).toBe(tx)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(DB.connection()).toBe(tx)
      await DB.unsafeQuery(unsafeSql('select 1'))
    })

    expect(DB.connection()).toBe(defaultConnection)
    expect(DB.table('users').getConnection()).toBe(defaultConnection)
    resetDB()
  })

  it('nests DB.transaction calls onto the ambient transaction', async () => {
    const adapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true } } } }))

    await DB.transaction(async (tx) => {
      expect(tx.getScope()).toEqual({ kind: 'transaction', depth: 1 })

      await DB.transaction(async (nested) => {
        expect(DB.connection()).toBe(nested)
        expect(nested.getScope()).toEqual({
          kind: 'savepoint',
          depth: 2,
          savepointName: 'sp_0' })
      })
    })

    expect(adapter.calls).toEqual([
      'initialize',
      'begin',
      'savepoint:sp_0',
      'release:sp_0',
      'commit',
    ])
    resetDB()
  })

  it('exposes transaction callbacks through the DB facade', async () => {
    const adapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true },
        },
      },
    }))
    const events: string[] = []

    await DB.transaction(async () => {
      DB.afterCommit(() => {
        events.push('commit')
      })
    })

    await expect(DB.transaction(async () => {
      DB.afterRollback(() => {
        events.push('rollback')
      })
      throw new Error('facade rollback')
    })).rejects.toThrow('facade rollback')

    expect(events).toEqual(['commit', 'rollback'])
    expect(() => DB.afterCommit(() => {})).toThrow(TransactionError)
    resetDB()
  })

  it('runs transaction callbacks inside the active connection scope', async () => {
    const defaultAdapter = new FakeAdapter()
    const analyticsAdapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: defaultAdapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true },
        },
        analytics: {
          adapter: analyticsAdapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true },
        },
      },
    }))

    const events: string[] = []

    await DB.transaction(async (tx) => {
      tx.afterCommit(() => {
        events.push(`commit:${DB.connection().getConnectionName()}:${DB.connection().getScope().kind}`)
      })
    }, 'analytics')

    await expect(DB.transaction(async (tx) => {
      tx.afterRollback(() => {
        events.push(`rollback:${DB.connection().getConnectionName()}:${DB.connection().getScope().kind}`)
      })
      throw new Error('rollback analytics')
    }, 'analytics')).rejects.toThrow('rollback analytics')

    expect(events).toEqual([
      'commit:analytics:root',
      'rollback:analytics:root',
    ])
    resetDB()
  })

  it('flushes injected root-scope transaction callbacks against the root connection context', async () => {
    const adapter = new FakeAdapter()
    const db = new DatabaseContext({
      connectionName: 'analytics',
      adapter,
      dialect: createDialect(true),
      runtime: {
        savepointCounter: 0,
        scheduler: createQueryScheduler({
          connectionName: 'analytics',
          supportsConcurrentQueries: false,
          supportsWorkerThreads: false,
        }),
      },
      scope: { kind: 'root', depth: 0 },
      transactionCallbacks: {
        afterCommit: [() => {
          const active = connectionAsyncContext.getActive()
          expect(active?.connectionName).toBe('analytics')
          expect(active?.connection.getScope()).toEqual({ kind: 'root', depth: 0 })
        }],
        afterRollback: [],
      },
    } as never)

    await (db as unknown as {
      _flushTransactionCallbacks(type: 'afterCommit' | 'afterRollback'): Promise<void>
    })._flushTransactionCallbacks('afterCommit')
  })

  it('keeps overlapping async transaction scopes isolated per connection', async () => {
    const defaultAdapter = new FakeAdapter()
    const analyticsAdapter = new FakeAdapter()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: {
          adapter: defaultAdapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true } },
        analytics: {
          adapter: analyticsAdapter,
          dialect: createDialect(true),
          security: { allowUnsafeRawSql: true } } } }))

    const seen: string[] = []

    await Promise.all([
      DB.transaction(async (tx) => {
        await Promise.resolve()
        seen.push(`${tx.getConnectionName()}:${DB.connection().getConnectionName()}`)
        expect(DB.connection()).toBe(tx)
        expect(DB.table('users').getConnection()).toBe(tx)
        await DB.unsafeQuery(unsafeSql('select default'))
      }, 'default'),
      DB.transaction(async (tx) => {
        await Promise.resolve()
        seen.push(`${tx.getConnectionName()}:${DB.connection().getConnectionName()}`)
        expect(DB.connection()).toBe(tx)
        expect(DB.table('reports').getConnection()).toBe(tx)
        await DB.unsafeQuery(unsafeSql('select analytics'), 'analytics')
      }, 'analytics'),
    ])

    expect(seen.sort()).toEqual([
      'analytics:analytics',
      'default:default',
    ])
    expect(defaultAdapter.calls).toContain('query:select default:0')
    expect(analyticsAdapter.calls).toContain('query:select analytics:0')
    resetDB()
  })
})

describe('error classes', () => {
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
