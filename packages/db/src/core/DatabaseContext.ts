import { createFactoryService, type FactoryService } from '../factories/FactoryService'
import { createMigrationService, type MigrationService } from '../migrations/MigrationService'
import { createModelEventService, type ModelEventService } from '../model/ModelEventService'
import { ModelRepository } from '../model/ModelRepository'
import { createModelRegistry, type ModelRegistry } from '../model/ModelRegistry'
import { connectionAsyncContext } from '../concurrency/AsyncConnectionContext'
import { createSecurityPolicy, redactBindings, redactSql, type SecurityPolicy } from '../security/policy'
import { createSchemaRegistry, type SchemaRegistry } from '../schema/SchemaRegistry'
import { createQueryScheduler, type QueryScheduler } from './QueryScheduler'
import { CapabilityError, ConfigurationError, DatabaseError, SecurityError, TransactionError } from './errors'
import { createCapabilities } from './capabilities'
import type { ModelDefinitionLike } from '../model/types'
import type {
  CompiledStatement,
  ConcurrencyOptions,
  DatabaseContextOptions,
  DatabaseDriverName,
  DatabaseLogger,
  DatabaseOperationOptions,
  Dialect,
  DriverAdapter,
  DriverExecutionResult,
  DriverQueryResult,
  QueryErrorLog,
  QueryStartLog,
  QuerySuccessLog,
  TransactionCallback,
  TransactionLog,
  TransactionScopeKind,
  UnsafeStatement,
} from './types'

type RuntimeState = {
  savepointCounter: number
  scheduler: QueryScheduler
}

type ScopeState = {
  kind: TransactionScopeKind
  depth: number
  savepointName?: string
}

type TransactionCallbackState = {
  afterCommit: TransactionCallback[]
  afterRollback: TransactionCallback[]
}

type ContextInternals = {
  connectionName: string
  schemaName?: string
  adapter: DriverAdapter
  dialect: Dialect
  driver: DatabaseDriverName
  logger?: DatabaseLogger
  security: SecurityPolicy
  concurrency: ConcurrencyOptions
  schemaRegistry: SchemaRegistry
  modelRegistry: ModelRegistry
  runtime: RuntimeState
  scope: ScopeState
  transactionCallbacks?: TransactionCallbackState
}

export class DatabaseContext {
  private readonly _connectionName: string
  private readonly _schemaName?: string
  private readonly _adapter: DriverAdapter
  private readonly _dialect: Dialect
  private readonly _driver: DatabaseDriverName
  private readonly _logger?: DatabaseLogger
  private readonly _security: SecurityPolicy
  private readonly _concurrency: ConcurrencyOptions
  private readonly _schemaRegistry: SchemaRegistry
  private readonly _modelRegistry: ModelRegistry
  private readonly _runtime: RuntimeState
  private readonly _scope: ScopeState
  private readonly _transactionCallbacks?: TransactionCallbackState
  private _migrationService?: MigrationService
  private _factoryService?: FactoryService
  private _eventService?: ModelEventService

  constructor(options: DatabaseContextOptions | ContextInternals) {
    if (!options.adapter) throw new ConfigurationError('DatabaseContext requires an adapter.')
    if (!options.dialect) throw new ConfigurationError('DatabaseContext requires a dialect.')

    this._connectionName = options.connectionName || 'default'
    this._schemaName = 'schemaName' in options ? options.schemaName : undefined
    this._adapter = options.adapter
    this._dialect = {
      ...options.dialect,
      capabilities: createCapabilities(options.dialect.capabilities),
    }
    this._driver = options.driver || options.dialect.name
    this._logger = options.logger
    this._security = createSecurityPolicy(options.security)
    this._concurrency = 'concurrency' in options ? { ...options.concurrency } : {}
    this._schemaRegistry = ('schemaRegistry' in options ? options.schemaRegistry : undefined) ?? createSchemaRegistry()
    this._modelRegistry = ('modelRegistry' in options ? options.modelRegistry : undefined) ?? createModelRegistry()
    this._runtime = 'runtime' in options
      ? options.runtime
      : {
          savepointCounter: 0,
          scheduler: createQueryScheduler({
            connectionName: this._connectionName,
            supportsConcurrentQueries: this._dialect.capabilities.concurrentQueries,
            supportsWorkerThreads: this._dialect.capabilities.workerThreadExecution,
            concurrency: this._concurrency,
          }),
        }
    this._scope = 'scope' in options ? options.scope : { kind: 'root', depth: 0 }
    this._transactionCallbacks = 'transactionCallbacks' in options ? options.transactionCallbacks : undefined
  }

  async initialize(): Promise<void> {
    if (this._adapter.isConnected()) return
    await this._adapter.initialize()
  }

  async disconnect(): Promise<void> {
    if (this._scope.kind !== 'root') {
      throw new TransactionError('Cannot disconnect a transaction-scoped DatabaseContext directly.')
    }

    if (!this._adapter.isConnected()) return
    await this._adapter.disconnect()
  }

  isConnected(): boolean {
    return this._adapter.isConnected()
  }

  getDriver(): DatabaseDriverName {
    return this._driver
  }

  getConnectionName(): string {
    return this._connectionName
  }

  getSchemaName(): string | undefined {
    return this._schemaName
  }

  getAdapter(): DriverAdapter {
    return this._adapter
  }

  getDialect(): Dialect {
    return this._dialect
  }

  getCapabilities() {
    return this._dialect.capabilities
  }

  getSecurityPolicy(): SecurityPolicy {
    return { ...this._security }
  }

  getConcurrencyOptions(): ConcurrencyOptions {
    return { ...this._concurrency }
  }

  getSchemaRegistry(): SchemaRegistry {
    return this._schemaRegistry
  }

  getModelRegistry(): ModelRegistry {
    return this._modelRegistry
  }

  getMigrationService(): MigrationService {
    this._migrationService ??= createMigrationService(this)
    return this._migrationService
  }

  getFactoryService(): FactoryService {
    this._factoryService ??= createFactoryService()
    return this._factoryService
  }

  getEventService(): ModelEventService {
    this._eventService ??= createModelEventService()
    return this._eventService
  }

  registerModel(reference: ModelDefinitionLike) {
    return this._modelRegistry.register(reference)
  }

  model(reference: ModelDefinitionLike): ModelRepository {
    this._modelRegistry.register(reference)
    return ModelRepository.from(reference, this)
  }

  getLogger(): DatabaseLogger | undefined {
    return this._logger
  }

  getScope(): Readonly<ScopeState> {
    return { ...this._scope }
  }

  afterCommit(callback: TransactionCallback): void {
    this._registerTransactionCallback('afterCommit', callback)
  }

  afterRollback(callback: TransactionCallback): void {
    this._registerTransactionCallback('afterRollback', callback)
  }

  getSchedulingModeHint(): 'concurrent' | 'serialized' | 'worker' {
    return this._runtime.scheduler.preview({
      transactional: this._scope.kind !== 'root',
      preferWorkerThreads: this._concurrency.workerThreads,
    })
  }

  async unsafeQuery<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: UnsafeStatement,
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    this._assertUnsafeRawAllowed()
    this._assertUnsafeStatement(statement)
    return this._runLogged('query', statement, async () => this._adapter.query<TRow>(
      statement.sql,
      statement.bindings ?? [],
      options,
    ), options)
  }

  async unsafeExecute(
    statement: UnsafeStatement,
    options?: DatabaseOperationOptions,
  ): Promise<DriverExecutionResult> {
    this._assertUnsafeRawAllowed()
    this._assertUnsafeStatement(statement)
    return this._runLogged('execute', statement, async () => this._adapter.execute(
      statement.sql,
      statement.bindings ?? [],
      options,
    ), options)
  }

  async queryCompiled<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: CompiledStatement,
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    if (statement.unsafe) {
      this._assertUnsafeRawAllowed()
    }
    this._assertCompiledStatementAllowed(statement)
    return this._runLogged('query', statement, async () => this._adapter.query<TRow>(
      statement.sql,
      statement.bindings ?? [],
      options,
    ), options)
  }

  async introspectCompiled<TRow extends Record<string, unknown> = Record<string, unknown>>(
    statement: CompiledStatement,
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    this._assertCompiledStatementAllowed(statement)
    return this._runLogged('query', statement, async () => {
      const bindings = statement.bindings ?? []
      if (this._adapter.introspect) {
        return this._adapter.introspect<TRow>(statement.sql, bindings, options)
      }

      return this._adapter.query<TRow>(statement.sql, bindings, options)
    }, options)
  }

  async executeCompiled(
    statement: CompiledStatement,
    options?: DatabaseOperationOptions,
  ): Promise<DriverExecutionResult> {
    if (statement.unsafe) {
      this._assertUnsafeRawAllowed()
    }
    this._assertCompiledStatementAllowed(statement)
    return this._runLogged('execute', statement, async () => this._adapter.execute(
      statement.sql,
      statement.bindings ?? [],
      options,
    ), options)
  }

  async transaction<T>(
    callback: (tx: DatabaseContext) => Promise<T>,
    options?: DatabaseOperationOptions,
  ): Promise<T> {
    await this.initialize()
    this._assertValidOperationOptions(options)
    this._throwIfAborted(options?.signal, 'transaction')

    if (this._scope.kind === 'root') {
      return this._runRootTransaction(callback, options)
    }

    return this._runNestedTransaction(callback, options)
  }

  private async _runRootTransaction<T>(
    callback: (tx: DatabaseContext) => Promise<T>,
    options?: DatabaseOperationOptions,
  ): Promise<T> {
    const runWithinScope = this._adapter.runWithTransactionScope?.bind(this._adapter)
      ?? (async <TResult>(runner: () => Promise<TResult>) => runner())

    return runWithinScope(async () => {
      const entry: TransactionLog = {
        scope: 'transaction',
        depth: 1,
      }

      await this._logger?.onTransactionStart?.(entry)
      await this._callTransactionHook('begin', () => this._adapter.beginTransaction(options), options)
      const tx = this._createChildContext(
        { kind: 'transaction', depth: 1 },
        this._createTransactionCallbackState(),
      )
      let committed = false

      try {
        const result = await this._runTransactionCallback(tx, callback)
        await this._callTransactionHook('commit', () => this._adapter.commit(options), options)
        committed = true
        await tx._flushTransactionCallbacks('afterCommit')
        await this._logger?.onTransactionCommit?.(entry)
        return result
      } catch (error) {
        if (committed) {
          throw error
        }

        try {
          await this._callTransactionHook('rollback', () => this._adapter.rollback(options), options)
        } catch (rollbackError) {
          await this._logger?.onTransactionRollback?.({ ...entry, error: rollbackError })
          throw rollbackError
        }
        await tx._flushTransactionCallbacks('afterRollback')
        await this._logger?.onTransactionRollback?.({ ...entry, error })
        throw error
      }
    })
  }

  private async _runNestedTransaction<T>(
    callback: (tx: DatabaseContext) => Promise<T>,
    options?: DatabaseOperationOptions,
  ): Promise<T> {
    if (!this._dialect.capabilities.savepoints) {
      throw new CapabilityError(
        `Nested transactions require savepoint support; dialect "${this._dialect.name}" does not support savepoints.`,
      )
    }

    if (!this._adapter.createSavepoint || !this._adapter.rollbackToSavepoint || !this._adapter.releaseSavepoint) {
      throw new CapabilityError(
        `Dialect "${this._dialect.name}" declares savepoint support, but the active adapter does not implement savepoint methods.`,
      )
    }

    const savepointName = `sp_${this._runtime.savepointCounter}`
    this._runtime.savepointCounter += 1

    const entry: TransactionLog = {
      scope: 'savepoint',
      depth: this._scope.depth + 1,
      savepointName,
    }

    await this._logger?.onTransactionStart?.(entry)
    await this._callTransactionHook(
      'createSavepoint',
      () => this._adapter.createSavepoint!(savepointName, options),
      options,
      savepointName,
    )
    const tx = this._createChildContext({
      kind: 'savepoint',
      depth: this._scope.depth + 1,
      savepointName,
    }, this._createTransactionCallbackState())
    let released = false

    try {
      const result = await this._runTransactionCallback(tx, callback)
      await this._callTransactionHook(
        'releaseSavepoint',
        () => this._adapter.releaseSavepoint!(savepointName, options),
        options,
        savepointName,
      )
      released = true
      this._mergeCommittedTransactionCallbacks(tx)
      await this._logger?.onTransactionCommit?.(entry)
      return result
    } catch (error) {
      if (released) {
        throw error
      }

      try {
        await this._callTransactionHook(
          'rollbackToSavepoint',
          () => this._adapter.rollbackToSavepoint!(savepointName, options),
          options,
          savepointName,
        )
      } catch (rollbackError) {
        await this._logger?.onTransactionRollback?.({ ...entry, error: rollbackError })
        throw rollbackError
      }
      await tx._flushTransactionCallbacks('afterRollback')
      await this._logger?.onTransactionRollback?.({ ...entry, error })
      throw error
    }
  }

  private _createChildContext(
    scope: ScopeState,
    transactionCallbacks?: TransactionCallbackState,
  ): DatabaseContext {
    return new DatabaseContext({
      adapter: this._adapter,
      dialect: this._dialect,
      driver: this._driver,
      connectionName: this._connectionName,
      schemaName: this._schemaName,
      logger: this._logger,
      security: this._security,
      concurrency: this._concurrency,
      schemaRegistry: this._schemaRegistry,
      modelRegistry: this._modelRegistry,
      runtime: this._runtime,
      scope,
      transactionCallbacks,
    })
  }

  private _runTransactionCallback<T>(
    tx: DatabaseContext,
    callback: (tx: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    return connectionAsyncContext.run({
      connectionName: tx.getConnectionName(),
      connection: tx,
    }, () => callback(tx))
  }

  private _createTransactionCallbackState(): TransactionCallbackState {
    return {
      afterCommit: [],
      afterRollback: [],
    }
  }

  private _registerTransactionCallback(
    type: keyof TransactionCallbackState,
    callback: TransactionCallback,
  ): void {
    if (this._scope.kind === 'root' || !this._transactionCallbacks) {
      throw new TransactionError(
        `Cannot register ${type} callbacks outside an active transaction.`,
      )
    }

    this._transactionCallbacks[type].push(callback)
  }

  private _mergeCommittedTransactionCallbacks(child: DatabaseContext): void {
    this._transactionCallbacks!.afterCommit.push(...child._transactionCallbacks!.afterCommit)
    this._transactionCallbacks!.afterRollback.push(...child._transactionCallbacks!.afterRollback)
  }

  private async _flushTransactionCallbacks(
    type: keyof TransactionCallbackState,
  ): Promise<void> {
    if (!this._transactionCallbacks || this._transactionCallbacks[type].length === 0) {
      return
    }

    const callbacks = this._transactionCallbacks[type]
    const callbackConnection = this._scope.kind === 'root'
      ? this
      : this._createChildContext({ kind: 'root', depth: 0 })
    let firstError: unknown

    while (callbacks.length > 0) {
      const callback = callbacks.shift()!
      try {
        await connectionAsyncContext.run({
          connectionName: callbackConnection.getConnectionName(),
          connection: callbackConnection,
        }, () => callback())
      } catch (error) {
        firstError ??= error
        if (type === 'afterCommit') {
          break
        }
      }
    }

    if (!firstError) {
      return
    }

    const message = firstError instanceof Error ? firstError.message : String(firstError)
    throw new TransactionError(
      `Connection "${this._connectionName}" failed while running ${type} callbacks via driver "${this._driver}": ${message}`,
      firstError,
    )
  }

  private _assertUnsafeRawAllowed(): void {
    if (!this._security.allowUnsafeRawSql) {
      throw new SecurityError(
        'Unsafe raw SQL is disabled by the active security policy. Enable allowUnsafeRawSql to use unsafeQuery()/unsafeExecute().',
      )
    }
  }

  private _assertUnsafeStatement(statement: UnsafeStatement): void {
    if (statement.unsafe !== true) {
      throw new SecurityError('Unsafe raw SQL statements must be explicitly marked with unsafe: true.')
    }
  }

  private _assertCompiledStatementAllowed(statement: CompiledStatement): void {
    const maxQueryComplexity = this._security.maxQueryComplexity
    const complexity = statement.metadata?.debug.complexity

    if (typeof maxQueryComplexity === 'number' && typeof complexity === 'number' && complexity > maxQueryComplexity) {
      throw new SecurityError(
        `Compiled statement complexity ${complexity} exceeds the configured maximum of ${maxQueryComplexity}.`,
      )
    }
  }

  private async _runLogged<TResult extends DriverQueryResult | DriverExecutionResult>(
    kind: 'query' | 'execute',
    statement: CompiledStatement | UnsafeStatement,
    runner: () => Promise<TResult>,
    options?: DatabaseOperationOptions,
  ): Promise<TResult> {
    this._assertValidOperationOptions(options)
    const start = Date.now()
    const scheduled = await this._runtime.scheduler.schedule({
      transactional: this._scope.kind !== 'root',
      preferWorkerThreads: this._concurrency.workerThreads,
    }, async (schedulingMode) => {
      const baseLog: QueryStartLog = {
        kind,
        connectionName: this._connectionName,
        sql: redactSql(statement.sql, this._security),
        bindings: redactBindings(statement.bindings ?? [], this._security),
        source: statement.source,
        scope: this._scope.kind,
        schedulingMode,
      }

      await this._logger?.onQueryStart?.(baseLog)

      try {
        const result = await this._guardOperation(
          runner,
          options,
          kind === 'query' ? 'query' : 'execute',
        )
        return { result, baseLog }
      } catch (error) {
        const wrappedError = this._wrapDriverError(kind, error)
        const errorLog: QueryErrorLog = {
          ...baseLog,
          durationMs: Date.now() - start,
          error: wrappedError,
        }
        await this._logger?.onQueryError?.(errorLog)
        throw wrappedError
      }
    })

    const successLog: QuerySuccessLog = {
      ...scheduled.result.baseLog,
      schedulingMode: scheduled.schedulingMode,
      durationMs: Date.now() - start,
      rowCount: 'rows' in scheduled.result.result ? scheduled.result.result.rowCount : undefined,
      affectedRows: 'affectedRows' in scheduled.result.result ? scheduled.result.result.affectedRows : undefined,
    }
    await this._logger?.onQuerySuccess?.(successLog)
    return scheduled.result.result
  }

  private _wrapDriverError(kind: 'query' | 'execute', error: unknown): DatabaseError {
    if (error instanceof DatabaseError) {
      return error
    }

    const action = kind === 'query' ? 'query' : 'execute'
    const message = error instanceof Error ? error.message : String(error)
    return new DatabaseError(
      `Connection "${this._connectionName}" failed to ${action} via driver "${this._driver}": ${message}`,
      kind === 'query' ? 'DRIVER_QUERY_ERROR' : 'DRIVER_EXECUTE_ERROR',
      error,
    )
  }

  private async _callTransactionHook(
    action: 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint',
    callback: () => Promise<void>,
    options?: DatabaseOperationOptions,
    savepointName?: string,
  ): Promise<void> {
    try {
      await this._guardOperation(callback, options, action)
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error
      }

      const suffix = savepointName ? ` (${savepointName})` : ''
      const message = error instanceof Error ? error.message : String(error)
      throw new TransactionError(
        `Connection "${this._connectionName}" failed to ${action}${suffix} via driver "${this._driver}": ${message}`,
        error,
      )
    }
  }

  private async _guardOperation<TResult>(
    runner: () => Promise<TResult>,
    options: DatabaseOperationOptions | undefined,
    action: 'query' | 'execute' | 'transaction' | 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint',
  ): Promise<TResult> {
    const signal = options?.signal
    const timeoutMs = options?.timeoutMs

    this._throwIfAborted(signal, action)

    if (!signal && typeof timeoutMs === 'undefined') {
      return runner()
    }

    return await new Promise<TResult>((resolve, reject) => {
      let settled = false
      let timeoutId: ReturnType<typeof setTimeout> | undefined

      const finalize = () => {
        settled = true
        if (typeof timeoutId !== 'undefined') {
          clearTimeout(timeoutId)
        }
        signal?.removeEventListener('abort', onAbort)
      }

      const rejectWith = (error: DatabaseError) => {
        finalize()
        reject(error)
      }

      const onAbort = () => {
        rejectWith(this._createGuardError('aborted', action, signal?.reason))
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (typeof timeoutMs === 'number') {
        timeoutId = setTimeout(() => {
          rejectWith(this._createGuardError('timeout', action, timeoutMs))
        }, timeoutMs)
      }

      void runner()
        .then((result) => {
          if (settled) return
          finalize()
          resolve(result)
        })
        .catch((error: unknown) => {
          if (settled) return
          finalize()
          reject(error)
        })
    })
  }

  private _assertValidOperationOptions(options?: DatabaseOperationOptions): void {
    if (typeof options?.timeoutMs === 'undefined') {
      return
    }

    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new ConfigurationError('Database operation timeouts must be positive integers in milliseconds.')
    }
  }

  private _throwIfAborted(
    signal: AbortSignal | undefined,
    action: 'query' | 'execute' | 'transaction' | 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint',
  ): void {
    if (!signal?.aborted) {
      return
    }

    throw this._createGuardError('aborted', action, signal.reason)
  }

  private _createGuardError(
    reason: 'aborted' | 'timeout',
    action: 'query' | 'execute' | 'transaction' | 'begin' | 'commit' | 'rollback' | 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint',
    cause: unknown,
  ): DatabaseError {
    if (action === 'query' || action === 'execute') {
      return new DatabaseError(
        `Connection "${this._connectionName}" ${reason === 'aborted' ? 'aborted' : 'timed out during'} ${action} via driver "${this._driver}".`,
        reason === 'aborted' ? 'DRIVER_OPERATION_ABORTED' : 'DRIVER_OPERATION_TIMEOUT',
        cause,
      )
    }

    return new TransactionError(
      `Connection "${this._connectionName}" ${reason === 'aborted' ? 'aborted' : 'timed out during'} ${action} via driver "${this._driver}".`,
      cause,
    )
  }
}

export function createDatabase(options: DatabaseContextOptions): DatabaseContext {
  return new DatabaseContext(options)
}
