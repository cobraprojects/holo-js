import { createConnectionManager, type ConnectionManager } from './connection/ConnectionManager'
import {
  createMySQLAdapter,
  createPostgresAdapter,
  createSQLiteAdapter,
  type MySQLAdapterOptions,
  type PostgresAdapterOptions,
} from './drivers'
import type { DatabaseCapabilities } from './core/capabilities'
import type { DatabaseContextOptions, DatabaseLogger, Dialect } from './core/types'

export type SupportedDatabaseDriver = 'sqlite' | 'postgres' | 'mysql'

export interface RuntimeConnectionConfig {
  driver?: SupportedDatabaseDriver | string
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  filename?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging?: boolean
}

export interface RuntimeDatabaseConfig {
  defaultConnection?: string
  connections?: Record<string, RuntimeConnectionConfig | string>
}

export interface RuntimeHoloConfig {
  appEnv?: 'production' | 'development' | 'test'
  appDebug?: boolean
  appUrl?: string
}

export interface RuntimeConfigInput {
  holo?: RuntimeHoloConfig
  db?: RuntimeDatabaseConfig
}

const DEFAULT_RUNTIME_CONNECTION = Object.freeze({
  driver: 'sqlite' as const,
  url: './data/database.sqlite',
  schema: 'public',
  logging: false,
})

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function normalizeConnectionInput(input: RuntimeConnectionConfig | string | undefined): RuntimeConnectionConfig {
  if (typeof input === 'string') {
    return { url: input }
  }

  return input ?? {}
}

function inferDatabaseDriver(value: string | undefined): SupportedDatabaseDriver | undefined {
  if (!value) return undefined

  const normalized = value.trim().toLowerCase()
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) {
    return 'postgres'
  }

  if (normalized.startsWith('mysql://') || normalized.startsWith('mysql2://')) {
    return 'mysql'
  }

  if (
    normalized === ':memory:'
    || normalized.startsWith('file:')
    || normalized.startsWith('/')
    || normalized.startsWith('./')
    || normalized.startsWith('../')
    || normalized.endsWith('.db')
    || normalized.endsWith('.sqlite')
    || normalized.endsWith('.sqlite3')
  ) {
    return 'sqlite'
  }

  return undefined
}

type RuntimeAdapterConnectionConfig = {
  url?: string
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
  ssl?: boolean | Record<string, unknown>
}

function coercePort(value: number | string | undefined): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed
    }
  }

  return undefined
}

function asSslConfig(
  value: boolean | Record<string, unknown> | undefined,
): boolean | Record<string, unknown> | undefined {
  if (typeof value === 'boolean') {
    return value
  }

  return asRecord(value)
}

function resolveConnectionConfig(
  name: string,
  input: RuntimeConnectionConfig | string | undefined,
): DatabaseContextOptions {
  const normalized = normalizeConnectionInput(input)
  const pickValue = <TValue>(...values: Array<TValue | undefined>): TValue | undefined => {
    for (const value of values) {
      if (typeof value !== 'undefined') {
        return value
      }
    }

    return undefined
  }
  const url = normalized.url
  const host = normalized.host
  const port = coercePort(normalized.port)
  const username = normalized.username
  const password = normalized.password
  const database = pickValue(normalized.database, normalized.filename)
  const ssl = asSslConfig(normalized.ssl)
  const explicitDriver = normalized.driver
  const hasStructuredNetworkConfig = (
    host !== undefined
    || port !== undefined
    || username !== undefined
    || password !== undefined
    || ssl !== undefined
  )

  if (!explicitDriver && !url && hasStructuredNetworkConfig) {
    throw new Error(`Connection "${name}" must declare a database driver when using host, port, username, password, or ssl settings.`)
  }

  const requestedDriver = explicitDriver
    ?? inferDatabaseDriver(url)
    ?? DEFAULT_RUNTIME_CONNECTION.driver
  const driver = parseDatabaseDriver(String(requestedDriver), DEFAULT_RUNTIME_CONNECTION.driver)
  const schemaName = normalized.schema
  const logging = normalized.logging ?? DEFAULT_RUNTIME_CONNECTION.logging

  const connection = driver === 'sqlite'
    ? {
        url: url ?? database ?? DEFAULT_RUNTIME_CONNECTION.url,
        database,
      }
    : {
        url,
        host,
        port,
        username,
        password,
        database,
        ssl,
      }

  return createRuntimeConnectionOptions(driver, connection, logging, schemaName, name)
}

function mergeConnectionGroups(
  ...groups: Array<RuntimeDatabaseConfig | undefined>
): Record<string, RuntimeConnectionConfig | string> {
  const merged: Record<string, RuntimeConnectionConfig | string> = {}

  for (const group of groups) {
    if (!group?.connections) {
      continue
    }

    Object.assign(merged, group.connections)
  }

  return merged
}

function resolveConfiguredDefaultConnection(
  ...groups: Array<RuntimeDatabaseConfig | undefined>
): string | undefined {
  for (const group of groups) {
    const configured = group?.defaultConnection
    if (configured) {
      return configured
    }
  }

  return undefined
}

function resolveImplicitDefaultConnectionName(
  connectionNames: readonly string[],
): string {
  if (connectionNames.includes('default')) {
    return 'default'
  }

  /* v8 ignore next */
  return connectionNames[0] ?? 'default'
}

export function isSupportedDatabaseDriver(value: string): value is SupportedDatabaseDriver {
  return value === 'sqlite' || value === 'postgres' || value === 'mysql'
}

export function parseDatabaseDriver(value: string | undefined, fallback: SupportedDatabaseDriver): SupportedDatabaseDriver {
  if (!value) {
    return fallback
  }

  if (isSupportedDatabaseDriver(value)) {
    return value
  }

  throw new Error(`Unsupported Holo database driver "${value}". Supported drivers are sqlite, postgres, and mysql.`)
}

export function createDialect(driver: SupportedDatabaseDriver): Dialect {
  const sqliteLike: DatabaseCapabilities = {
    returning: false,
    savepoints: true,
    concurrentQueries: false,
    workerThreadExecution: false,
    lockForUpdate: false,
    sharedLock: false,
    jsonValueQuery: true,
    jsonContains: false,
    jsonLength: true,
    schemaQualifiedIdentifiers: false,
    nativeUpsert: true,
    ddlAlterSupport: false,
    introspection: true,
  }

  if (driver === 'postgres') {
    return {
      name: 'postgres',
      capabilities: {
        ...sqliteLike,
        returning: true,
        concurrentQueries: true,
        lockForUpdate: true,
        sharedLock: true,
        jsonContains: true,
        schemaQualifiedIdentifiers: true,
        ddlAlterSupport: true,
      },
      quoteIdentifier(identifier: string) {
        return identifier
          .split('.')
          .map(part => `"${part}"`)
          .join('.')
      },
      createPlaceholder(index: number) {
        return `$${index}`
      },
    }
  }

  if (driver === 'mysql') {
    return {
      name: 'mysql',
      capabilities: {
        ...sqliteLike,
        concurrentQueries: true,
        lockForUpdate: true,
        sharedLock: true,
        jsonContains: true,
        schemaQualifiedIdentifiers: true,
        ddlAlterSupport: true,
      },
      quoteIdentifier(identifier: string) {
        return identifier
          .split('.')
          .map(part => `\`${part}\``)
          .join('.')
      },
      createPlaceholder() {
        return '?'
      },
    }
  }

  return {
    name: 'sqlite',
    capabilities: sqliteLike,
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder() {
      return '?'
    },
  }
}

export function createAdapter(
  driver: SupportedDatabaseDriver,
  connection: string | RuntimeAdapterConnectionConfig,
) {
  const target = typeof connection === 'string'
    ? { url: connection }
    : connection

  if (driver === 'postgres') {
    if (target.url) {
      return createPostgresAdapter({ connectionString: target.url })
    }

    const config: PostgresAdapterOptions['config'] = {
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      database: target.database,
      ssl: target.ssl,
    }
    return createPostgresAdapter({ config })
  }

  if (driver === 'mysql') {
    if (target.url) {
      return createMySQLAdapter({ uri: target.url })
    }

    const config: MySQLAdapterOptions['config'] = {
      host: target.host,
      port: target.port,
      user: target.username,
      password: target.password,
      database: target.database,
      ...(typeof target.ssl === 'undefined' ? {} : { ssl: target.ssl as never }),
    }
    return createMySQLAdapter({ config })
  }

  if (driver === 'sqlite') {
    return createSQLiteAdapter({ filename: target.url ?? target.database ?? DEFAULT_RUNTIME_CONNECTION.url })
  }

  throw new Error(`Unsupported Holo database driver "${driver}". Supported drivers are sqlite, postgres, and mysql.`)
}

export function createRuntimeLogger(enabled: boolean): DatabaseLogger | undefined {
  if (!enabled) {
    return undefined
  }

  return {
    onQuerySuccess(entry) {
      const count = typeof entry.rowCount === 'number'
        ? ` rows=${entry.rowCount}`
        : typeof entry.affectedRows === 'number'
          ? ` affected=${entry.affectedRows}`
          : ''
      console.warn(`[holo:db] ${entry.kind} ok connection=${entry.connectionName} scope=${entry.scope} duration=${entry.durationMs}ms${count} sql=${entry.sql}`)
    },
    onQueryError(entry) {
      const message = entry.error instanceof Error ? entry.error.message : String(entry.error)
      console.error(`[holo:db] ${entry.kind} error connection=${entry.connectionName} scope=${entry.scope} duration=${entry.durationMs}ms sql=${entry.sql} error=${message}`)
    },
    onTransactionStart(entry) {
      console.warn(`[holo:db] transaction start scope=${entry.scope} depth=${entry.depth}${entry.savepointName ? ` savepoint=${entry.savepointName}` : ''}`)
    },
    onTransactionCommit(entry) {
      console.warn(`[holo:db] transaction commit scope=${entry.scope} depth=${entry.depth}${entry.savepointName ? ` savepoint=${entry.savepointName}` : ''}`)
    },
    onTransactionRollback(entry) {
      const message = entry.error instanceof Error ? ` error=${entry.error.message}` : entry.error ? ` error=${String(entry.error)}` : ''
      console.warn(`[holo:db] transaction rollback scope=${entry.scope} depth=${entry.depth}${entry.savepointName ? ` savepoint=${entry.savepointName}` : ''}${message}`)
    },
  }
}

export function createRuntimeConnectionOptions(
  driver: SupportedDatabaseDriver,
  connection: string | RuntimeAdapterConnectionConfig,
  dbLogging: boolean,
  schemaName?: string,
  connectionName = 'default',
): DatabaseContextOptions {
  return {
    connectionName,
    schemaName,
    driver,
    adapter: createAdapter(driver, connection),
    dialect: createDialect(driver),
    logger: createRuntimeLogger(dbLogging),
    security: dbLogging
      ? {
          debugSqlInLogs: true,
          redactBindingsInLogs: false,
        }
      : undefined,
  }
}

export function resolveRuntimeConnectionManagerOptions(
  config: RuntimeConfigInput,
): ConnectionManager {
  const topLevelDb = asRecord(config.db) as RuntimeDatabaseConfig | undefined
  const mergedConnections = mergeConnectionGroups(topLevelDb)
  const connectionNames = Object.keys(mergedConnections)

  if (connectionNames.length === 0) {
    return createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: resolveConnectionConfig('default', undefined),
      },
    })
  }

  const configuredDefault = resolveConfiguredDefaultConnection(topLevelDb)
  const defaultConnection = configuredDefault
    ?? resolveImplicitDefaultConnectionName(connectionNames)

  const connectionEntries = Object.entries(mergedConnections)
    .map(([name, input]) => [
      name,
      resolveConnectionConfig(name, input),
    ] as const)

  return createConnectionManager({
    defaultConnection,
    connections: Object.fromEntries(connectionEntries),
  })
}
