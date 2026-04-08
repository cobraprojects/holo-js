import Database from 'better-sqlite3'

export interface DriverQueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  rows: TRow[]
  rowCount: number
}

export interface DriverExecutionResult {
  affectedRows?: number
  lastInsertId?: number | string
}

export interface DriverAdapter {
  initialize(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings?: readonly unknown[],
  ): Promise<DriverQueryResult<TRow>>
  execute(
    sql: string,
    bindings?: readonly unknown[],
  ): Promise<DriverExecutionResult>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  createSavepoint?(name: string): Promise<void>
  rollbackToSavepoint?(name: string): Promise<void>
  releaseSavepoint?(name: string): Promise<void>
}

class TransactionError extends Error {}

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

    this.database = this.createDatabaseInstance(this.filename)
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

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    const statement = this.getDatabase().prepare(sql)
    const rows = this.invokeStatement(statement, 'all', bindings) as TRow[]
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
    const result = this.invokeStatement(statement, 'run', bindings)
    return {
      affectedRows: result.changes,
      lastInsertId: typeof result.lastInsertRowid === 'bigint'
        ? Number(result.lastInsertRowid)
        : result.lastInsertRowid as number | string | undefined,
    }
  }

  async beginTransaction(): Promise<void> {
    this.getDatabase().exec('BEGIN')
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

  private invokeStatement<
    TMethod extends 'all' | 'run',
  >(
    statement: SQLiteStatementLike,
    method: TMethod,
    bindings: readonly unknown[],
  ): ReturnType<SQLiteStatementLike[TMethod]> {
    try {
      return statement[method](...bindings) as ReturnType<SQLiteStatementLike[TMethod]>
    } catch (error) {
      if (bindings.length > 0 && this.isBindingArityError(error)) {
        return statement[method](bindings as never) as ReturnType<SQLiteStatementLike[TMethod]>
      }

      throw error
    }
  }

  private isBindingArityError(error: unknown): boolean {
    return error instanceof RangeError
      && (
        error.message.includes('Too many parameter values were provided')
        || error.message.includes('Too few parameter values were provided')
      )
  }
}

export function createSQLiteAdapter(options: SQLiteAdapterOptions = {}): SQLiteAdapter {
  return new SQLiteAdapter(options)
}
