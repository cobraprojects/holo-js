import { holoRuntimeInternals } from '@holo-js/db'
import { Pool, types, type PoolConfig, type QueryResult } from 'pg'
import type {
  DatabaseDriverFactory,
  DriverAdapter,
  DriverExecutionResult,
  DriverQueryResult,
} from '@holo-js/db'

export type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

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

export interface PostgresAdapterOptions<TConfig extends PoolConfig = PoolConfig> {
  connectionString?: string
  config?: TConfig
  client?: PostgresClientLike
  pool?: PostgresPoolLike
  createPool?: (config?: TConfig) => PostgresPoolLike
}

type BootstrapTarget = {
  database: string
  config: PoolConfig
}

function quoteDatabaseIdentifier(database: string): string {
  return `"${database.replaceAll('"', '""')}"`
}

function stripDatabaseFromConnectionString(connectionString: string): { database?: string, connectionString: string } {
  const parsed = new URL(connectionString)
  const database = parsed.pathname.replace(/^\/+/, '')

  parsed.pathname = '/postgres'

  return {
    database: database ? decodeURIComponent(database) : undefined,
    connectionString: parsed.toString(),
  }
}

function resolveBootstrapTarget(config?: PoolConfig): BootstrapTarget | undefined {
  if (!config) {
    return undefined
  }

  if (typeof config.database === 'string' && config.database.trim().length > 0) {
    const { database, ...bootstrapConfig } = config
    if (database === 'postgres') {
      return undefined
    }

    return {
      database,
      config: {
        ...bootstrapConfig,
        database: 'postgres',
      },
    }
  }

  if (typeof config.connectionString === 'string' && config.connectionString.trim().length > 0) {
    const stripped = stripDatabaseFromConnectionString(config.connectionString)
    if (!stripped.database || stripped.database === 'postgres') {
      return undefined
    }

    return {
      database: stripped.database,
      config: {
        ...config,
        connectionString: stripped.connectionString,
      },
    }
  }

  return undefined
}

export class PostgresAdapter<TConfig extends PoolConfig = PoolConfig> implements DriverAdapter {
  readonly supportsConcurrentTransactionScopes = true
  private pool?: PostgresPoolLike
  private readonly directClient?: PostgresClientLike
  private readonly createPoolInstance?: (config?: TConfig) => PostgresPoolLike
  private readonly config?: TConfig
  private connected: boolean
  private readonly transactionClients

  constructor(options: PostgresAdapterOptions<TConfig> = {}) {
    this.directClient = options.client
    this.pool = options.pool
    this.createPoolInstance = options.createPool ?? (options.client || options.pool
      ? undefined
      : config => new Pool({
          ...config,
          types: config?.types ?? {
            getTypeParser(oid: number, format: 'text' | 'binary' = 'text') {
              if (oid === 1114 && format === 'text') return (value: string) => new Date(`${value}Z`)
              return types.getTypeParser(oid, format)
            },
          },
        }))
    this.config = options.config ?? (options.connectionString ? { connectionString: options.connectionString } as TConfig : undefined)
    this.connected = !!(options.client || options.pool)
    this.transactionClients = new holoRuntimeInternals.PooledTransactionClients(
      'Postgres',
      this.directClient,
      async () => {
        await this.initialize()
        if (this.directClient) {
          return this.directClient
        }

        if (!this.pool) {
          throw new TransactionError('Postgres adapter is not initialized with a pool or client.')
        }

        return this.pool.connect()
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
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === '3D000'
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
    const client = await this.transactionClients.lease()
    await client.query('BEGIN')
  }

  async commit(): Promise<void> {
    const client = this.transactionClients.require()
    await client.query('COMMIT')
    this.transactionClients.release()
  }

  async rollback(): Promise<void> {
    const client = this.transactionClients.require()
    await client.query('ROLLBACK')
    this.transactionClients.release()
  }

  async createSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`ROLLBACK TO SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  async releaseSavepoint(name: string): Promise<void> {
    await this.transactionClients.require().query(`RELEASE SAVEPOINT ${this.normalizeSavepointName(name)}`)
  }

  private async getQueryable(): Promise<PostgresQueryableLike> {
    const active = this.transactionClients.current
    if (active) {
      return active
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
      const existing = await bootstrapPool.query('select 1 from pg_database where datname = $1', [target.database])
      if (existing.rows.length === 0) {
        await bootstrapPool.query(`create database ${quoteDatabaseIdentifier(target.database)}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `Postgres database "${target.database}" could not be found or created. Please create the database and try again. Original error: ${message}`,
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

export function createPostgresAdapter<TConfig extends PoolConfig = PoolConfig>(options: PostgresAdapterOptions<TConfig> = {}): PostgresAdapter<TConfig> {
  return new PostgresAdapter(options)
}

export const postgresDatabaseDriverFactory: DatabaseDriverFactory = Object.freeze({
  driver: 'postgres',
  supportsConcurrentTransactionScopes: true,
  create(connection) {
    return connection.url
      ? createPostgresAdapter({ connectionString: connection.url })
      : createPostgresAdapter({ config: {
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password: connection.password,
          database: connection.database,
          ssl: connection.ssl,
        } })
  },
})
