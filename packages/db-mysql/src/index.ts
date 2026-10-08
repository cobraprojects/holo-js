import { holoRuntimeInternals } from '@holo-js/db'
import mysql, {
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise'
import type { DatabaseDriverFactory, DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

export type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

class TransactionError extends Error {}

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

export interface MySQLAdapterOptions<TConfig extends PoolOptions = PoolOptions> {
  uri?: string
  config?: TConfig
  client?: MySQLClientLike
  pool?: MySQLPoolLike
  createPool?: (config: TConfig) => MySQLPoolLike
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

type BootstrapTarget = {
  database: string
  config: PoolOptions
}

function toMutableBindings(bindings: readonly unknown[] = []): unknown[] {
  return [...bindings]
}

function quoteDatabaseIdentifier(database: string): string {
  return `\`${database.replaceAll('`', '``')}\``
}

function stripDatabaseFromUri(uri: string): { database?: string, uri: string } {
  const parsed = new URL(uri)
  const database = parsed.pathname.replace(/^\/+/, '')

  parsed.pathname = ''

  return {
    database: database ? decodeURIComponent(database) : undefined,
    uri: parsed.toString(),
  }
}

function resolveBootstrapTarget(config: PoolOptions): BootstrapTarget | undefined {
  if (typeof config.database === 'string' && config.database.trim().length > 0) {
    const { database, ...bootstrapConfig } = config

    return {
      database,
      config: bootstrapConfig,
    }
  }

  if (typeof config.uri === 'string' && config.uri.trim().length > 0) {
    const stripped = stripDatabaseFromUri(config.uri)
    if (!stripped.database) {
      return undefined
    }

    return {
      database: stripped.database,
      config: {
        ...config,
        uri: stripped.uri,
      },
    }
  }

  return undefined
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

function createNativeMySQLPool(config: PoolOptions): MySQLPoolLike {
  const pool = mysql.createPool({ ...config, timezone: config.timezone ?? 'Z' })
  if (!config.timezone || config.timezone === 'Z') {
    pool.pool.on('connection', (connection) => {
      connection.query("SET time_zone = '+00:00'")
    })
  }
  return wrapMySQLPool(pool)
}

function isMySQLDatabaseMissing(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (
      ('code' in error && error.code === 'ER_BAD_DB_ERROR')
      || ('errno' in error && error.errno === 1049)
    )
}

export class MySQLAdapter<TConfig extends PoolOptions = PoolOptions> implements DriverAdapter {
  readonly supportsConcurrentTransactionScopes = true
  private pool?: MySQLPoolLike
  private readonly directClient?: MySQLClientLike
  private readonly createPoolInstance?: (config: TConfig) => MySQLPoolLike
  private readonly config: TConfig
  private connected: boolean
  private readonly transactionClients

  constructor(options: MySQLAdapterOptions<TConfig> = {}) {
    this.directClient = options.client
    this.pool = options.pool
    this.createPoolInstance = options.createPool ?? (options.client || options.pool
      ? undefined
      : createNativeMySQLPool)
    this.config = options.config ?? (options.uri ? { uri: options.uri } as TConfig : {} as TConfig)
    this.connected = !!(options.client || options.pool)
    this.transactionClients = new holoRuntimeInternals.PooledTransactionClients(
      'MySQL',
      this.directClient,
      async () => {
        await this.initialize()
        if (this.directClient) {
          return this.directClient
        }

        if (!this.pool) {
          throw new TransactionError('MySQL adapter is not initialized with a pool or client.')
        }

        return this.pool.getConnection()
      },
    )
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

  isDatabaseMissingError(error: unknown): boolean {
    return isMySQLDatabaseMissing(error)
  }

  async disconnect(): Promise<void> {
    if (!this.connected) {
      return
    }

    this.transactionClients.disconnect()

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

  runWithTransactionScope<T>(callback: () => Promise<T>): Promise<T> {
    return this.transactionClients.run(callback)
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
    const client = await this.transactionClients.lease()
    await client.query('START TRANSACTION', [])
  }

  async commit(): Promise<void> {
    const client = this.transactionClients.require()
    await client.query('COMMIT', [])
    this.transactionClients.release()
  }

  async rollback(): Promise<void> {
    const client = this.transactionClients.require()
    await client.query('ROLLBACK', [])
    this.transactionClients.release()
  }

  async createSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`SAVEPOINT ${this.normalizeSavepointName(name)}`, [])
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`ROLLBACK TO SAVEPOINT ${this.normalizeSavepointName(name)}`, [])
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`RELEASE SAVEPOINT ${this.normalizeSavepointName(name)}`, [])
  }

  private async getQueryable(): Promise<MySQLQueryableLike> {
    const active = this.transactionClients.current
    if (active) {
      return active
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

  async ensureDatabaseExists(): Promise<void> {
    if (!this.createPoolInstance) {
      return
    }

    const target = resolveBootstrapTarget(this.config)
    if (!target) {
      return
    }

    const bootstrapPool = this.createPoolInstance(target.config as TConfig)

    try {
      const [existing] = await bootstrapPool.query(
        'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
        [target.database],
      )
      if (Array.isArray(existing) && existing.length === 0) {
        await bootstrapPool.query(`CREATE DATABASE ${quoteDatabaseIdentifier(target.database)}`, [])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `MySQL database "${target.database}" could not be found or created. Please create the database and try again. Original error: ${message}`,
        { cause: error },
      )
    } finally {
      await bootstrapPool.end()
    }
  }

  private normalizeSavepointName(name: string): string {
    if (!/^[A-Z_]\w*$/i.test(name)) {
      throw new TransactionError(`Invalid savepoint name "${name}".`)
    }

    return name
  }
}

export function createMySQLAdapter<TConfig extends PoolOptions = PoolOptions>(options: MySQLAdapterOptions<TConfig> = {}): MySQLAdapter<TConfig> {
  return new MySQLAdapter(options)
}

export const mysqlDatabaseDriverFactory: DatabaseDriverFactory = Object.freeze({
  driver: 'mysql',
  supportsConcurrentTransactionScopes: true,
  create(connection) {
    return connection.url
      ? createMySQLAdapter({ uri: connection.url })
      : createMySQLAdapter({ config: {
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password: connection.password,
          database: connection.database,
          ssl: connection.ssl === true ? {} : connection.ssl || undefined,
        } })
  },
})
