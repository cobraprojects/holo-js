import { AsyncLocalStorage } from 'node:async_hooks'
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise'
import { TransactionError } from '../core/errors'
import type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '../core/types'

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

export interface MySQLAdapterOptions {
  uri?: string
  config?: PoolOptions
  client?: MySQLClientLike
  pool?: MySQLPoolLike
  createPool?: (config: PoolOptions) => MySQLPoolLike
}

type ScopedMySQLTransaction = {
  client: MySQLClientLike
  leased: boolean
  released: boolean
}

type RawMySQLClientLike = {
  query(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  release?(): void
  end?(): Promise<void>
}

type RawMySQLPoolLike = {
  query(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  getConnection(): Promise<PoolConnection | MySQLClientLike>
  end(): Promise<void>
}

function toMutableBindings(bindings: readonly unknown[] = []): unknown[] {
  return [...bindings]
}

function wrapMySQLClient(client: PoolConnection | MySQLClientLike): MySQLClientLike {
  const rawClient = client as unknown as RawMySQLClientLike

  return {
    async query(sql: string, bindings: readonly unknown[] = []) {
      return rawClient.query(sql, toMutableBindings(bindings))
    },
    release: rawClient.release?.bind(rawClient),
    end: rawClient.end?.bind(rawClient),
  }
}

function wrapMySQLPool(pool: Pool | MySQLPoolLike): MySQLPoolLike {
  const rawPool = pool as unknown as RawMySQLPoolLike

  return {
    async query(sql: string, bindings: readonly unknown[] = []) {
      return rawPool.query(sql, toMutableBindings(bindings))
    },
    async getConnection() {
      return wrapMySQLClient(await rawPool.getConnection())
    },
    end: rawPool.end.bind(rawPool),
  }
}

export class MySQLAdapter implements DriverAdapter {
  private pool?: MySQLPoolLike
  private readonly directClient?: MySQLClientLike
  private readonly createPoolInstance?: (config: PoolOptions) => MySQLPoolLike
  private readonly config: PoolOptions
  private connected: boolean
  private transactionClient?: MySQLClientLike
  private leasedTransactionClient = false
  private readonly transactionScope = new AsyncLocalStorage<ScopedMySQLTransaction>()

  constructor(options: MySQLAdapterOptions = {}) {
    this.directClient = options.client ? wrapMySQLClient(options.client) : undefined
    this.pool = options.pool ? wrapMySQLPool(options.pool) : undefined
    this.createPoolInstance = options.createPool ?? (options.client || options.pool
      ? undefined
      : config => wrapMySQLPool(mysql.createPool(config)))
    this.config = options.config ?? (options.uri ? { uri: options.uri } as PoolOptions : {})
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
      throw new TransactionError('MySQL adapter is not initialized with a pool or client.')
    }

    const state: ScopedMySQLTransaction = {
      client: await this.pool.getConnection(),
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
    const queryable = await this.getQueryable()
    const [rows] = await queryable.query(sql, bindings)
    const normalized = rows as RowDataPacket[] & TRow[]
    return {
      rows: Array.isArray(normalized) ? [...normalized] : [],
      rowCount: Array.isArray(normalized) ? normalized.length : 0,
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
    const queryable = await this.getQueryable()
    const [result] = await queryable.query(sql, bindings)
    const execution = result as ResultSetHeader
    return {
      affectedRows: typeof execution.affectedRows === 'number' ? execution.affectedRows : 0,
      lastInsertId: execution.insertId,
    }
  }

  async beginTransaction(): Promise<void> {
    const client = await this.leaseTransactionClient()
    await client.query('START TRANSACTION')
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

  private async getQueryable(): Promise<MySQLQueryableLike> {
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
      throw new TransactionError('MySQL adapter is not initialized with a pool or client.')
    }

    return this.pool
  }

  private async leaseTransactionClient(): Promise<MySQLClientLike> {
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
      throw new TransactionError('MySQL adapter is not initialized with a pool or client.')
    }

    this.transactionClient = await this.pool.getConnection()
    this.leasedTransactionClient = true
    return this.transactionClient
  }

  private requireTransactionClient(): MySQLClientLike {
    const scoped = this.transactionScope.getStore()
    if (scoped) {
      return scoped.client
    }

    if (!this.transactionClient) {
      throw new TransactionError('No active MySQL transaction client is available.')
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

  private releaseScopedTransaction(state: ScopedMySQLTransaction): void {
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

export function createMySQLAdapter(options: MySQLAdapterOptions = {}): MySQLAdapter {
  return new MySQLAdapter(options)
}
