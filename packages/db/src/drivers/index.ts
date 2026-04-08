import { TransactionError } from '../core/errors'
import type { DriverAdapter, DriverExecutionResult, DriverQueryResult, DatabaseOperationOptions } from '../core/types'

function isModuleNotFoundError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
}

async function importDriverModule<TModule>(specifier: string, errorMessage: string): Promise<TModule> {
  try {
    return await import(specifier) as TModule
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error(errorMessage, { cause: error })
    }

    throw error
  }
}

function unsupportedDriverMethod(name: string, method: string): Error {
  return new Error(`[@holo-js/db] ${name} does not support ${method}().`)
}

abstract class LazyDriverAdapter implements DriverAdapter {
  private adapter?: DriverAdapter
  private pending?: Promise<DriverAdapter>
  protected connected = false

  protected abstract readonly driverLabel: string
  protected abstract createConcreteAdapter(): Promise<DriverAdapter>

  protected async resolveAdapter(): Promise<DriverAdapter> {
    if (this.adapter) {
      return this.adapter
    }

    this.pending ??= this.createConcreteAdapter().then((adapter) => {
      this.adapter = adapter
      return adapter
    }).finally(() => {
      this.pending = undefined
    })

    return this.pending
  }

  async initialize(): Promise<void> {
    await (await this.resolveAdapter()).initialize()
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.adapter && !this.pending) {
      this.connected = false
      return
    }

    await (await this.resolveAdapter()).disconnect()
    this.connected = false
  }

  isConnected(): boolean {
    return this.adapter?.isConnected() ?? this.connected
  }

  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    const adapter = await this.resolveAdapter()
    if (typeof adapter.runWithTransactionScope !== 'function') {
      return callback()
    }

    return adapter.runWithTransactionScope(callback)
  }

  async introspect<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    const adapter = await this.resolveAdapter()
    if (typeof adapter.introspect !== 'function') {
      return adapter.query<TRow>(sql, bindings, options)
    }

    return adapter.introspect<TRow>(sql, bindings, options)
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverQueryResult<TRow>> {
    return (await this.resolveAdapter()).query<TRow>(sql, bindings, options)
  }

  async execute(
    sql: string,
    bindings?: readonly unknown[],
    options?: DatabaseOperationOptions,
  ): Promise<DriverExecutionResult> {
    return (await this.resolveAdapter()).execute(sql, bindings, options)
  }

  async beginTransaction(options?: DatabaseOperationOptions): Promise<void> {
    await (await this.resolveAdapter()).beginTransaction(options)
  }

  async commit(options?: DatabaseOperationOptions): Promise<void> {
    await (await this.resolveAdapter()).commit(options)
  }

  async rollback(options?: DatabaseOperationOptions): Promise<void> {
    await (await this.resolveAdapter()).rollback(options)
  }

  async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolveAdapter()
    if (typeof adapter.createSavepoint !== 'function') {
      throw unsupportedDriverMethod(this.driverLabel, 'createSavepoint')
    }

    await adapter.createSavepoint(name, options)
  }

  async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolveAdapter()
    if (typeof adapter.rollbackToSavepoint !== 'function') {
      throw unsupportedDriverMethod(this.driverLabel, 'rollbackToSavepoint')
    }

    await adapter.rollbackToSavepoint(name, options)
  }

  async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    const adapter = await this.resolveAdapter()
    if (typeof adapter.releaseSavepoint !== 'function') {
      throw unsupportedDriverMethod(this.driverLabel, 'releaseSavepoint')
    }

    await adapter.releaseSavepoint(name, options)
  }
}

export interface SQLiteStatementLike {
  all(...params: readonly unknown[]): Record<string, unknown>[]
  run(...params: readonly unknown[]): { changes?: number, lastInsertRowid?: unknown }
}

export interface SQLiteDatabaseLike {
  prepare(sql: string): SQLiteStatementLike
  exec(sql: string): unknown
  close(): unknown
}

export interface SQLiteAdapterOptions {
  filename?: string
  database?: SQLiteDatabaseLike
  createDatabase?: (filename: string) => SQLiteDatabaseLike
}

type SQLiteDriverModule = {
  createSQLiteAdapter(options?: SQLiteAdapterOptions): DriverAdapter
}

export class SQLiteAdapter extends LazyDriverAdapter {
  protected readonly driverLabel = 'SQLiteAdapter'
  readonly filename: string

  constructor(private readonly options: SQLiteAdapterOptions = {}) {
    super()
    this.filename = options.filename ?? ':memory:'
    this.connected = !!options.database
  }

  protected async createConcreteAdapter(): Promise<DriverAdapter> {
    const module = await importDriverModule<SQLiteDriverModule>(
      '@holo-js/db-sqlite',
      '[@holo-js/db] SQLite support requires @holo-js/db-sqlite to be installed.',
    )

    return module.createSQLiteAdapter(this.options)
  }

  override async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.createSavepoint(name, options)
  }

  override async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.rollbackToSavepoint(name, options)
  }

  override async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.releaseSavepoint(name, options)
  }
}

export function createSQLiteAdapter(options: SQLiteAdapterOptions = {}): SQLiteAdapter {
  return new SQLiteAdapter(options)
}

export interface PostgresQueryableLike {
  query(sql: string, bindings?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[]
    rowCount?: number | null
  }>
}

export interface PostgresClientLike extends PostgresQueryableLike {
  release?(): void
  end?(): Promise<void>
}

export interface PostgresPoolLike extends PostgresQueryableLike {
  connect(): Promise<PostgresClientLike>
  end(): Promise<void>
}

export interface PostgresConnectionConfig {
  connectionString?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  ssl?: boolean | Record<string, unknown>
}

export interface PostgresAdapterOptions<TConfig extends PostgresConnectionConfig = PostgresConnectionConfig> {
  connectionString?: string
  config?: TConfig
  client?: PostgresClientLike
  pool?: PostgresPoolLike
  createPool?: (config?: TConfig) => PostgresPoolLike
}

type PostgresDriverModule<TConfig extends PostgresConnectionConfig = PostgresConnectionConfig> = {
  createPostgresAdapter(options?: PostgresAdapterOptions<TConfig>): DriverAdapter
}

export class PostgresAdapter<TConfig extends PostgresConnectionConfig = PostgresConnectionConfig> extends LazyDriverAdapter {
  protected readonly driverLabel = 'PostgresAdapter'
  readonly config?: TConfig

  constructor(private readonly options: PostgresAdapterOptions<TConfig> = {}) {
    super()
    this.config = options.config ?? (options.connectionString ? { connectionString: options.connectionString } as TConfig : undefined)
    this.connected = !!(options.client || options.pool)
  }

  protected async createConcreteAdapter(): Promise<DriverAdapter> {
    const module = await importDriverModule<PostgresDriverModule<TConfig>>(
      '@holo-js/db-postgres',
      '[@holo-js/db] Postgres support requires @holo-js/db-postgres to be installed.',
    )
    const createPostgresAdapter = module.createPostgresAdapter as unknown as (
      options?: PostgresAdapterOptions,
    ) => DriverAdapter

    return createPostgresAdapter(this.options as unknown as PostgresAdapterOptions)
  }

  releaseScopedTransaction(state: { client: { release?(): void }, leased: boolean, released: boolean }): void {
    if (state.released) {
      return
    }

    if (state.leased) {
      state.client.release?.()
    }

    state.released = true
  }

  override async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.createSavepoint(name, options)
  }

  override async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.rollbackToSavepoint(name, options)
  }

  override async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.releaseSavepoint(name, options)
  }
}

export function createPostgresAdapter<TConfig extends PostgresConnectionConfig = PostgresConnectionConfig>(
  options: PostgresAdapterOptions<TConfig> = {},
): PostgresAdapter<TConfig> {
  return new PostgresAdapter(options)
}

export interface MySQLQueryableLike {
  query(sql: string, bindings?: readonly unknown[]): Promise<readonly [unknown, unknown]>
}

export interface MySQLClientLike extends MySQLQueryableLike {
  release?(): void
  end?(): Promise<void>
}

export interface MySQLPoolLike extends MySQLQueryableLike {
  getConnection(): Promise<MySQLClientLike>
  end(): Promise<void>
}

export interface MySQLConnectionConfig {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  ssl?: unknown
  uri?: string
}

export interface MySQLAdapterOptions<TConfig extends MySQLConnectionConfig = MySQLConnectionConfig> {
  uri?: string
  config?: TConfig
  client?: MySQLClientLike
  pool?: MySQLPoolLike
  createPool?: (config: TConfig) => MySQLPoolLike
}

type MySQLDriverModule<TConfig extends MySQLConnectionConfig = MySQLConnectionConfig> = {
  createMySQLAdapter(options?: MySQLAdapterOptions<TConfig>): DriverAdapter
}

export class MySQLAdapter<TConfig extends MySQLConnectionConfig = MySQLConnectionConfig> extends LazyDriverAdapter {
  protected readonly driverLabel = 'MySQLAdapter'
  readonly config: TConfig

  constructor(private readonly options: MySQLAdapterOptions<TConfig> = {}) {
    super()
    this.config = options.config ?? (options.uri ? { uri: options.uri } as TConfig : {} as TConfig)
    this.connected = !!(options.client || options.pool)
  }

  protected async createConcreteAdapter(): Promise<DriverAdapter> {
    const module = await importDriverModule<MySQLDriverModule<TConfig>>(
      '@holo-js/db-mysql',
      '[@holo-js/db] MySQL support requires @holo-js/db-mysql to be installed.',
    )
    const createMySQLAdapter = module.createMySQLAdapter as unknown as (
      options?: MySQLAdapterOptions,
    ) => DriverAdapter

    return createMySQLAdapter(this.options as unknown as MySQLAdapterOptions)
  }

  releaseScopedTransaction(state: { client: { release?(): void }, leased: boolean, released: boolean }): void {
    if (state.released) {
      return
    }

    if (state.leased) {
      state.client.release?.()
    }

    state.released = true
  }

  override async createSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.createSavepoint(name, options)
  }

  override async rollbackToSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.rollbackToSavepoint(name, options)
  }

  override async releaseSavepoint(name: string, options?: DatabaseOperationOptions): Promise<void> {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    await super.releaseSavepoint(name, options)
  }
}

export function createMySQLAdapter<TConfig extends MySQLConnectionConfig = MySQLConnectionConfig>(
  options: MySQLAdapterOptions<TConfig> = {},
): MySQLAdapter<TConfig> {
  return new MySQLAdapter(options)
}
