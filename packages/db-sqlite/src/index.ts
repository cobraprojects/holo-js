import Database from 'better-sqlite3'
import type {
  DatabaseDriverFactory,
  DatabaseOperationOptions,
  DriverAdapter,
  DriverExecutionResult,
  DriverQueryResult,
} from '@holo-js/db'

export type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

class TransactionError extends Error {}

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
  private transactionTail: Promise<void> = Promise.resolve()
  private readonly filename: string
  private readonly createDatabaseInstance: (filename: string) => SQLiteDatabaseLike

  constructor(options: SQLiteAdapterOptions = {}) {
    this.database = options.database
    this.connected = !!options.database
    this.filename = options.filename ?? ':memory:'
    this.createDatabaseInstance = options.createDatabase ?? (filename => new Database(filename))
  }

  async initialize(): Promise<void> {
    if (this.connected) {
      return
    }

    try {
      this.database = this.createDatabaseInstance(this.filename)
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Unknown SQLite driver error.'
      throw new Error(`Unable to open SQLite database "${this.filename}": ${message}`, { cause: error })
    }
    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.database) {
      return
    }

    this.database.close()
    this.database = undefined
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.transactionTail
    let release!: () => void
    const current = previous.then(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    this.transactionTail = current

    await previous

    try {
      return await callback()
    } finally {
      release()
      if (this.transactionTail === current) {
        this.transactionTail = Promise.resolve()
      }
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
      throw new Error(
        `SQLite migration left ${violations.length} foreign key violation${violations.length === 1 ? '' : 's'}.`,
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
    const statement = this.getDatabase().prepare(sql)
    const rows = statement.all(...bindings) as TRow[]
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
    const statement = this.getDatabase().prepare(sql)
    const result = statement.run(...bindings)
    return {
      affectedRows: result.changes,
      lastInsertId: typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid as number | string | undefined,
    }
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

  private getDatabase(): SQLiteDatabaseLike {
    if (!this.connected || !this.database) {
      this.database = this.createDatabaseInstance(this.filename)
      this.connected = true
    }

    return this.database
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
