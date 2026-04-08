import { AsyncLocalStorage } from 'node:async_hooks'
import { Pool, type PoolConfig, type QueryResult } from 'pg'

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
  runWithTransactionScope?<T>(callback: () => Promise<T>): Promise<T>
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

export interface PostgresQueryableLike {
  query(sql: string, bindings?: readonly unknown[]): Promise<QueryResult<Record<string, unknown>> | {
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

export interface PostgresAdapterOptions {
  connectionString?: string
  config?: PoolConfig
  client?: PostgresClientLike
  pool?: PostgresPoolLike
  createPool?: (config?: PoolConfig) => PostgresPoolLike
}

type ScopedPostgresTransaction = {
  client: PostgresClientLike
  leased: boolean
  released: boolean
}

export class PostgresAdapter implements DriverAdapter {
  private pool?: PostgresPoolLike
  private readonly directClient?: PostgresClientLike
  private readonly createPoolInstance?: (config?: PoolConfig) => PostgresPoolLike
  private readonly config?: PoolConfig
  private connected: boolean
  private transactionClient?: PostgresClientLike
  private leasedTransactionClient = false
  private readonly transactionScope = new AsyncLocalStorage<ScopedPostgresTransaction>()

  constructor(options: PostgresAdapterOptions = {}) {
    this.directClient = options.client
    this.pool = options.pool
    this.createPoolInstance = options.createPool ?? (options.client || options.pool
      ? undefined
      : config => new Pool(config))
    this.config = options.config ?? (options.connectionString ? { connectionString: options.connectionString } : undefined)
    this.connected = !!(options.client || options.pool)
  }

  async initialize(): Promise<void> {
    if (this.connected) {
      return
    }

    if (this.createPoolInstance) {
      this.pool = this.createPoolInstance(this.config)
    }

    this.connected = true
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return
    }

    if (this.transactionClient && this.leasedTransactionClient) {
      this.transactionClient.release?.()
      this.transactionClient = undefined
      this.leasedTransactionClient = false
    }

    if (this.pool) {
      await this.pool.end()
      this.pool = undefined
    } else if (this.directClient?.end) {
      await this.directClient.end()
    }

    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    const active = this.transactionScope.getStore()
    if (active) {
      return callback()
    }

    await this.initialize()

    if (this.directClient) {
      return this.transactionScope.run({
        client: this.directClient,
        leased: false,
        released: false,
      }, callback)
    }

    if (!this.pool) {
      throw new TransactionError('Postgres adapter is not initialized with a pool or client.')
    }

    const state: ScopedPostgresTransaction = {
      client: await this.pool.connect(),
      leased: true,
      released: false,
    }

    return this.transactionScope.run(state, async () => {
      try {
        return await callback()
      } finally {
        this.releaseScopedTransaction(state)
      }
    })
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    const client = await this.getQueryable()
    const result = await client.query(sql, bindings)
    return {
      rows: result.rows as TRow[],
      rowCount: result.rowCount ?? result.rows.length,
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
    const client = await this.getQueryable()
    const result = await client.query(sql, bindings)
    const firstRow = result.rows[0]
    const firstValue = firstRow ? Object.values(firstRow)[0] : undefined
    return {
      affectedRows: result.rowCount ?? 0,
      ...(typeof firstValue !== 'undefined' ? { lastInsertId: firstValue as number | string } : {}),
    }
  }

  async beginTransaction(): Promise<void> {
    const client = await this.leaseTransactionClient()
    await client.query('BEGIN')
  }

  async commit(): Promise<void> {
    const client = this.requireTransactionClient()
    await client.query('COMMIT')
    this.releaseTransactionClient()
  }

  async rollback(): Promise<void> {
    const client = this.requireTransactionClient()
    await client.query('ROLLBACK')
    this.releaseTransactionClient()
  }

  async createSavepoint(name: string): Promise<void> {
    await this.requireTransactionClient().query(`SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.requireTransactionClient().query(`ROLLBACK TO SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.requireTransactionClient().query(`RELEASE SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  private async getQueryable(): Promise<PostgresQueryableLike> {
    const scoped = this.transactionScope.getStore()
    if (scoped) {
      return scoped.client
    }

    if (this.transactionClient) {
      return this.transactionClient
    }

    await this.initialize()

    if (this.directClient) {
      return this.directClient
    }

    if (!this.pool) {
      throw new TransactionError('Postgres adapter is not initialized with a pool or client.')
    }

    return this.pool
  }

  private async leaseTransactionClient(): Promise<PostgresClientLike> {
    const scoped = this.transactionScope.getStore()
    if (scoped) {
      return scoped.client
    }

    if (this.transactionClient) {
      return this.transactionClient
    }

    await this.initialize()

    if (this.directClient) {
      this.transactionClient = this.directClient
      this.leasedTransactionClient = false
      return this.transactionClient
    }

    if (!this.pool) {
      throw new TransactionError('Postgres adapter is not initialized with a pool or client.')
    }

    this.transactionClient = await this.pool.connect()
    this.leasedTransactionClient = true
    return this.transactionClient
  }

  private requireTransactionClient(): PostgresClientLike {
    const scoped = this.transactionScope.getStore()
    if (scoped) {
      return scoped.client
    }

    if (!this.transactionClient) {
      throw new TransactionError('No active Postgres transaction client is available.')
    }

    return this.transactionClient
  }

  private releaseTransactionClient(): void {
    if (this.transactionClient && this.leasedTransactionClient) {
      this.transactionClient.release?.()
    }

    this.transactionClient = undefined
    this.leasedTransactionClient = false
  }

  private releaseScopedTransaction(state: ScopedPostgresTransaction): void {
    if (!state.leased || state.released) {
      return
    }

    state.client.release?.()
    state.released = true
  }

  private normalizeSavepointName(name: string): string {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    return name
  }
}

export function createPostgresAdapter(options: PostgresAdapterOptions = {}): PostgresAdapter {
  return new PostgresAdapter(options)
}
