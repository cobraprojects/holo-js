import { holoRuntimeInternals } from '@holo-js/db'
import mysql, {
  type Connection,
  type Pool,
  type PoolConnection,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise'
import type { DatabaseDriverFactory, DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

export type { DriverAdapter, DriverExecutionResult, DriverQueryResult } from '@holo-js/db'

const { formatWallClock, parseCalendarDate, parseWallClockTimestamp } = holoRuntimeInternals

class TransactionError extends Error {}

export interface MySQLQueryableLike {
  query(sql: string, bindings?: readonly unknown[]): Promise<readonly [unknown, unknown]>
  execute?(sql: string, bindings?: readonly unknown[]): Promise<readonly [unknown, unknown]>
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
  client?: Connection | MySQLClientLike
  pool?: MySQLPoolLike
  createPool?: (config: TConfig) => MySQLPoolLike
}

type RawMySQLClientLike = {
  query(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  execute(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  release?(): void
  end?(): Promise<void>
}

type RawMySQLPoolLike = {
  query(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  execute(sql: string, bindings?: unknown[]): Promise<readonly [unknown, unknown]>
  getConnection(): Promise<PoolConnection | MySQLClientLike>
  end(): Promise<void>
}

type BootstrapTarget = {
  database: string
  config: PoolOptions
}

type MySQLTypeCast = Exclude<NonNullable<PoolOptions['typeCast']>, boolean>

const ZERO_DATE_PART = /-00(?:-|\s|$)/

function toDriverBinding(value: unknown, timeZone: string): unknown {
  if (!(value instanceof Date)) return value
  return Number.isNaN(value.getTime()) ? null : formatWallClock(value, timeZone)
}

function toDriverBindings(bindings: readonly unknown[]): unknown[] {
  const timeZone = holoRuntimeInternals.getApplicationTimezone()
  return bindings.map(value => toDriverBinding(value, timeZone))
}

const DATE_TYPE_NAMES = ['date', 'datetime', 'timestamp']

const rawTypeCast: MySQLTypeCast = (field) => field.buffer()

function dateStringTypes(config: PoolOptions): ReadonlySet<string> {
  const uriOption = typeof config.uri === 'string' ? new URL(config.uri).searchParams.get('dateStrings') : null
  const option: unknown = config.dateStrings ?? (uriOption === 'true' ? true : uriOption === 'false' || uriOption === null ? undefined : uriOption)
  if (option === true || config.typeCast === false) return new Set(DATE_TYPE_NAMES)
  if (typeof option === 'string') return new Set([option.toLowerCase()])
  if (Array.isArray(option)) return new Set(option.map(type => String(type).toLowerCase()))
  return new Set()
}

function applicationTypeCast(config: PoolOptions): MySQLTypeCast {
  const fallback = typeof config.typeCast === 'function' ? config.typeCast : config.typeCast === false ? rawTypeCast : undefined
  const stringTypes = dateStringTypes(config)
  return (field, next) => {
    if (field.type !== 'DATE' && field.type !== 'DATETIME' && field.type !== 'TIMESTAMP') {
      return fallback ? fallback(field, next) : next()
    }
    const value = field.string()
    if (value === null) return null
    if (stringTypes.has(field.type.toLowerCase()) || ZERO_DATE_PART.test(value)) return value
    const timeZone = holoRuntimeInternals.getApplicationTimezone()
    if (field.type === 'DATE') return parseCalendarDate(value, timeZone) ?? value
    return parseWallClockTimestamp(value, timeZone) ?? value
  }
}

function sessionTimeZone(timeZone: string): string {
  return timeZone === 'UTC' ? '+00:00' : timeZone
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

async function runStatement(
  queryable: MySQLQueryableLike,
  sql: string,
  bindings: readonly unknown[],
): Promise<readonly [unknown, unknown]> {
  if (bindings.length === 0) {
    return queryable.query(sql)
  }

  if (!queryable.execute) {
    throw new Error('The MySQL driver must support prepared statements (execute) to run statements with bindings.')
  }

  return queryable.execute(sql, bindings.map(value => value === undefined ? null : value))
}

function wrapMySQLClient(client: Connection | MySQLClientLike): MySQLClientLike {
  const rawClient = client as unknown as RawMySQLClientLike

  return {
    async query(sql: string, bindings: readonly unknown[] = []) {
      return bindings.length === 0 ? rawClient.query(sql) : rawClient.query(sql, toDriverBindings(bindings))
    },
    async execute(sql: string, bindings: readonly unknown[] = []) {
      return rawClient.execute(sql, toDriverBindings(bindings))
    },
    release: rawClient.release?.bind(rawClient),
    end: rawClient.end?.bind(rawClient),
  }
}

function wrapMySQLPool(pool: Pool | MySQLPoolLike): MySQLPoolLike {
  const rawPool = pool as unknown as RawMySQLPoolLike

  return {
    async query(sql: string, bindings: readonly unknown[] = []) {
      return bindings.length === 0 ? rawPool.query(sql) : rawPool.query(sql, toDriverBindings(bindings))
    },
    async execute(sql: string, bindings: readonly unknown[] = []) {
      return rawPool.execute(sql, toDriverBindings(bindings))
    },
    async getConnection() {
      return wrapMySQLClient(await rawPool.getConnection())
    },
    end: rawPool.end.bind(rawPool),
  }
}

const DEFAULT_MAX_PREPARED_STATEMENTS = 256

function createNativeMySQLPool(config: PoolOptions): MySQLPoolLike {
  const pool = mysql.createPool({
    maxPreparedStatements: DEFAULT_MAX_PREPARED_STATEMENTS,
    ...config,
    timezone: config.timezone ?? 'Z',
    typeCast: applicationTypeCast(config),
  })
  pool.pool.on('connection', (connection) => {
    connection.query('SET time_zone = ?', [sessionTimeZone(holoRuntimeInternals.getApplicationTimezone())], (error) => {
      if (!error) return
      holoRuntimeInternals.reportError(error, { capability: 'db', operation: 'mysql.sessionTimeZone' })
      connection.destroy()
    })
  })
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
  readonly supportsConcurrentTransactionScopes: boolean
  private pool?: MySQLPoolLike
  private readonly directClient?: MySQLClientLike
  private readonly createPoolInstance?: (config: TConfig) => MySQLPoolLike
  private readonly config: TConfig
  private connected: boolean
  private readonly transactionClients

  constructor(options: MySQLAdapterOptions<TConfig> = {}) {
    this.supportsConcurrentTransactionScopes = !options.client
    this.directClient = options.client as MySQLClientLike | undefined
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
    const [rows] = await runStatement(queryable, sql, bindings)
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
    const [result] = await runStatement(queryable, sql, bindings)
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
      const [existing] = await runStatement(bootstrapPool, 'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?', [target.database])
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
    const ssl = connection.ssl === true ? {} : connection.ssl || undefined
    const urlSetsSsl = connection.url ? new URL(connection.url).searchParams.has('ssl') : false
    const sslOptions = ssl && !urlSetsSsl ? { ssl } : {}

    return connection.url
      ? createMySQLAdapter({ config: { uri: connection.url, ...sslOptions } })
      : createMySQLAdapter({ config: {
          host: connection.host,
          port: connection.port,
          user: connection.username,
          password: connection.password,
          database: connection.database,
          ...sslOptions,
        } })
  },
})
