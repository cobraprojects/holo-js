import { createConnectionManager, type ConnectionManager } from './connection/ConnectionManager'
import { createDeferredDatabaseDriverAdapter } from './drivers/registry'
import type { DatabaseCapabilities } from './core/capabilities'
import type { DatabaseContextOptions, DatabaseLogger, Dialect, DriverAdapter } from './core/types'
import type { HoloProjectConnectionConfig } from '@holo-js/kernel'

export type SupportedDatabaseDriver = 'sqlite' | 'postgres' | 'mysql'

export interface RuntimeConnectionConfig extends Omit<HoloProjectConnectionConfig, 'driver'> {
  driver?: SupportedDatabaseDriver | string
}

export interface RuntimeDatabaseConfig {
  defaultConnection?: string
  connections?: Record<string, RuntimeConnectionConfig | string>
}

export interface RuntimeHoloConfig {
  appUrl?: string
}

export interface RuntimeConfigInput {
  holo?: RuntimeHoloConfig
  db?: RuntimeDatabaseConfig
}

type RuntimeConnectionEntry = [string, RuntimeConnectionConfig | string]
type RuntimeConnectionEntries = RuntimeConnectionEntry[]
type NonEmptyRuntimeConnectionEntries = [RuntimeConnectionEntry, ...RuntimeConnectionEntry[]]

const DEFAULT_RUNTIME_CONNECTION = Object.freeze({
  driver: 'sqlite' as const,
  url: './data/database.sqlite',
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

  for (const key of ['allowUnsafeRawSql', 'debugSqlInLogs'] as const) {
    const value = input?.security?.[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`Database connection security.${key} must be a boolean.`)
    }
  }
  for (const key of ['max', 'connectionTimeoutMillis', 'idleTimeoutMillis'] as const) {
    const value = input?.[key]
    const minimum = key === 'max' ? 1 : 0
    if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
      throw new Error(`Database connection ${key} must be an integer greater than or equal to ${minimum}.`)
    }
  }
  return input ?? {}
}

function hasRuntimeConnectionEntries(
  entries: RuntimeConnectionEntries,
): entries is NonEmptyRuntimeConnectionEntries {
  return entries.length > 0
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

type RuntimeAdapterConnectionConfig = Pick<HoloProjectConnectionConfig, 'max' | 'connectionTimeoutMillis' | 'idleTimeoutMillis' | 'application_name'> & {
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
        max: normalized.max,
        connectionTimeoutMillis: normalized.connectionTimeoutMillis,
        idleTimeoutMillis: normalized.idleTimeoutMillis,
        application_name: normalized.application_name,
      }

  const options = createRuntimeConnectionOptions(driver, connection, false, schemaName, name)
  return {
    ...options,
    logger: normalized.logger ?? createRuntimeLogger(logging, normalized.security?.debugSqlInLogs),
    concurrency: normalized.concurrency,
    security: normalized.security ? { ...options.security, ...normalized.security } : options.security,
  }
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
    ddlAddColumnSupport: true,
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
    capabilities: { ...sqliteLike, returning: true },
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
): DriverAdapter {
  if (!isSupportedDatabaseDriver(driver)) {
    throw new Error(`Unsupported Holo database driver "${String(driver)}". Supported drivers are sqlite, postgres, and mysql.`)
  }
  const target = typeof connection === 'string'
    ? { url: connection }
    : connection

  return createDeferredDatabaseDriverAdapter(driver, target)
}

export function createRuntimeLogger(enabled: boolean, debugSqlInLogs = false): DatabaseLogger | undefined {
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
      console.warn(`[holo:db] ${entry.kind} ok connection=${entry.connectionName} scope=${entry.scope} duration=${entry.durationMs}ms${count}${debugSqlInLogs ? ` sql=${entry.sql}` : ''}`)
    },
    onQueryError(entry) {
      console.error(`[holo:db] ${entry.kind} error connection=${entry.connectionName} scope=${entry.scope} duration=${entry.durationMs}ms${debugSqlInLogs ? ` sql=${entry.sql}` : ''}`)
    },
    onTransactionStart(entry) {
      console.warn(`[holo:db] transaction start scope=${entry.scope} depth=${entry.depth}`)
    },
    onTransactionCommit(entry) {
      console.warn(`[holo:db] transaction commit scope=${entry.scope} depth=${entry.depth}`)
    },
    onTransactionRollback(entry) {
      console.warn(`[holo:db] transaction rollback scope=${entry.scope} depth=${entry.depth}`)
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
  }
}

export function resolveRuntimeConnectionManagerOptions(
  config: RuntimeConfigInput,
): ConnectionManager {
  const topLevelDb = asRecord(config.db) as RuntimeDatabaseConfig | undefined
  const connections = topLevelDb?.connections ?? {}
  const connectionEntries = Object.entries(connections)

  if (!hasRuntimeConnectionEntries(connectionEntries)) {
    return createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: resolveConnectionConfig('default', undefined),
      },
    })
  }

  const configuredDefault = topLevelDb?.defaultConnection
  const defaultConnection = configuredDefault
    ? configuredDefault
    : Object.hasOwn(connections, 'default')
      ? 'default'
      : connectionEntries[0][0]

  const resolvedConnections = connectionEntries
    .map(([name, input]) => [
      name,
      resolveConnectionConfig(name, input),
    ] as const)

  return createConnectionManager({
    defaultConnection,
    connections: Object.fromEntries(resolvedConnections),
  })
}
