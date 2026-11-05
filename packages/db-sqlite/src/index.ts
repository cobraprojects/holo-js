import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import {
  DatabaseError,
  holoRuntimeInternals,
  type DatabaseDriverFactory,
  type DatabaseOperationOptions,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult,
} from '@holo-js/db'

export type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

class TransactionError extends Error {}

const MISSING_DATABASE_ERROR_CODE = 'SQLITE_DATABASE_MISSING'

function isInMemoryDatabase(filename: string): boolean {
  return filename === ':memory:' || filename === ''
}

function resolveSQLiteFilename(filename: string): string {
  if (!filename.startsWith('file:')) return filename

  const location = filename.slice('file:'.length).replace(/#.*$/s, '')
  const queryStart = location.indexOf('?')
  if (queryStart !== -1) {
    throw new Error(`SQLite URL "${filename}" has query parameters, which Holo doesn't support. Remove "${location.slice(queryStart)}" from the URL.`)
  }
  if (!location.startsWith('//')) return decodeURIComponent(location)

  const pathStart = location.indexOf('/', 2)
  const authority = pathStart === -1 ? location.slice(2) : location.slice(2, pathStart)
  if (authority !== '' && authority !== 'localhost') {
    throw new Error(`SQLite URL "${filename}" names the host "${authority}". Use "file:" with a local path.`)
  }
  return decodeURIComponent(pathStart === -1 ? '' : location.slice(pathStart))
}

const transactionTails = new Map<string | SQLiteAdapter, Promise<void>>()

type HeldTransactionScope = { active: boolean }

const heldTransactionScopes = new AsyncLocalStorage<ReadonlyMap<string | SQLiteAdapter, HeldTransactionScope>>()

function normalizeBinding(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return Number(value)
  }

  return value instanceof Date ? holoRuntimeInternals.formatSQLiteDateTime(value) : value
}

function exactInteger(value: bigint): number | string {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString()
}

function exactIntegerRow<TRow extends Record<string, unknown>>(row: Record<string, unknown>): TRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? exactInteger(value) : value])) as TRow
}

type SQLiteTransactionMode = 'deferred' | 'immediate' | 'exclusive'

type SQLiteTransactionOptions = DatabaseOperationOptions & {
  readonly mode?: SQLiteTransactionMode
}

type SQLiteMigrationTransactionState = {
  readonly foreignKeysWereEnabled: boolean
}

export interface SQLiteStatementLike {
  all(...params: readonly unknown[]): Record<string, unknown>[]
  run(...params: readonly unknown[]): { changes?: number, lastInsertRowid?: unknown }
  safeIntegers?(enabled: boolean): unknown
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

export class SQLiteAdapter implements DriverAdapter {
  private database?: SQLiteDatabaseLike
  private connected: boolean
  private readonly transactionKey: string | SQLiteAdapter
  private readonly filename: string
  private readonly createDatabaseInstance: (filename: string) => SQLiteDatabaseLike

  constructor(options: SQLiteAdapterOptions = {}) {
    this.database = options.database
    this.connected = !!options.database
    this.filename = resolveSQLiteFilename(options.filename ?? ':memory:')
    this.transactionKey = options.database || isInMemoryDatabase(this.filename) ? this : resolve(this.filename)
    this.createDatabaseInstance = options.createDatabase ?? ((filename) => {
      const database = new Database(filename, { fileMustExist: !isInMemoryDatabase(filename) })
      try {
        database.exec('PRAGMA journal_mode = WAL')
        return database
      } catch (error) {
        database.close()
        throw error
      }
    })
  }

  async initialize(): Promise<void> {
    this.connected = true
  }

  async databaseExists(): Promise<boolean> {
    return !!this.database || isInMemoryDatabase(this.filename) || existsSync(this.filename)
  }

  async ensureDatabaseExists(): Promise<void> {
    await mkdir(dirname(resolve(this.filename)), { recursive: true })
    await appendFile(this.filename, '')
  }

  isDatabaseMissingError(error: unknown): boolean {
    return error instanceof DatabaseError && error.code === MISSING_DATABASE_ERROR_CODE
  }

  async disconnect(): Promise<void> {
    this.database?.close()
    this.database = undefined
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  get [holoRuntimeInternals.transactionScopeKey](): string | SQLiteAdapter {
    return this.transactionKey
  }

  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    const held = heldTransactionScopes.getStore()
    if (held?.get(this.transactionKey)?.active) {
      return callback()
    }

    const previous = transactionTails.get(this.transactionKey) ?? Promise.resolve()
    let release!: () => void
    const current = previous.then(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    transactionTails.set(this.transactionKey, current)

    await previous

    const scope: HeldTransactionScope = { active: true }
    try {
      return await heldTransactionScopes.run(new Map(held).set(this.transactionKey, scope), callback)
    } finally {
      scope.active = false
      release()
      if (transactionTails.get(this.transactionKey) === current) transactionTails.delete(this.transactionKey)
    }
  }

  async beforeMigrationTransaction(): Promise<SQLiteMigrationTransactionState> {
    const row = this.getDatabase().prepare('PRAGMA foreign_keys').all()[0] as { foreign_keys?: number } | undefined
    const foreignKeysWereEnabled = row?.foreign_keys === 1
    if (foreignKeysWereEnabled) {
      this.getDatabase().exec('PRAGMA foreign_keys = OFF')
    }
    return { foreignKeysWereEnabled }
  }

  async validateMigrationTransaction(): Promise<void> {
    const violations = this.getDatabase().prepare('PRAGMA foreign_key_check').all()
    if (violations.length > 0) {
      throw new DatabaseError(
        `SQLite migration left ${violations.length} foreign key violation${violations.length === 1 ? '' : 's'}.`,
        'SQLITE_MIGRATION_FOREIGN_KEY_VIOLATION',
      )
    }
  }

  async afterMigrationTransaction(state: unknown): Promise<void> {
    if (
      typeof state === 'object'
      && state !== null
      && 'foreignKeysWereEnabled' in state
      && state.foreignKeysWereEnabled === true
    ) {
      this.getDatabase().exec('PRAGMA foreign_keys = ON')
    }
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    const rows = this.prepareExact(sql).all(...bindings.map(normalizeBinding)).map(row => exactIntegerRow<TRow>(row))
    return {
      rows,
      rowCount: rows.length,
    }
  }

  async introspect<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    return this.query<TRow>(sql, bindings)
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    return this.runWithTransactionScope(async () => {
      const result = this.prepareExact(sql).run(...bindings.map(normalizeBinding))
      return {
        affectedRows: result.changes,
        lastInsertId: typeof result.lastInsertRowid === 'bigint'
          ? exactInteger(result.lastInsertRowid)
          : result.lastInsertRowid as number | string | undefined,
      }
    })
  }

  async beginTransaction(options?: SQLiteTransactionOptions): Promise<void> {
    this.getDatabase().exec(this.resolveBeginStatement(options?.mode))
  }

  async commit(): Promise<void> {
    this.getDatabase().exec('COMMIT')
  }

  async rollback(): Promise<void> {
    this.getDatabase().exec('ROLLBACK')
  }

  async createSavepoint(name: string): Promise<void> {
    this.getDatabase().exec(`SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    this.getDatabase().exec(`ROLLBACK TO SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    this.getDatabase().exec(`RELEASE SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  private prepareExact(sql: string): SQLiteStatementLike {
    const statement = this.getDatabase().prepare(sql)
    statement.safeIntegers?.(true)
    return statement
  }

  private getDatabase(): SQLiteDatabaseLike {
    this.database ??= this.openDatabase()
    this.connected = true
    return this.database
  }

  private openDatabase(): SQLiteDatabaseLike {
    if (!isInMemoryDatabase(this.filename) && !existsSync(this.filename)) {
      throw new DatabaseError(
        `Database file at path "${this.filename}" does not exist. Run "holo migrate" to create it.`,
        MISSING_DATABASE_ERROR_CODE,
      )
    }

    try {
      return this.createDatabaseInstance(this.filename)
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Unknown SQLite driver error.'
      throw new Error(`Unable to open SQLite database "${this.filename}": ${message}`, { cause: error })
    }
  }

  private normalizeSavepointName(name: string): string {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    return name
  }

  private resolveBeginStatement(mode: SQLiteTransactionMode = 'deferred'): string {
    if (mode === 'deferred') {
      return 'BEGIN'
    }

    if (mode === 'immediate') {
      return 'BEGIN IMMEDIATE'
    }

    if (mode === 'exclusive') {
      return 'BEGIN EXCLUSIVE'
    }

    throw new TransactionError(`Unsupported SQLite transaction mode "${String(mode)}".`)
  }
}

export function createSQLiteAdapter(options: SQLiteAdapterOptions = {}): SQLiteAdapter {
  return new SQLiteAdapter(options)
}

export const sqliteDatabaseDriverFactory: DatabaseDriverFactory = Object.freeze({
  driver: 'sqlite',
  create(connection) {
    return createSQLiteAdapter({ filename: connection.url ?? connection.database ?? './data/database.sqlite' })
  },
})
