import { randomUUID } from 'node:crypto'
import {
  CacheConfigError,
  CacheInvalidNumericMutationError,
  CacheLockAcquisitionError,
  deserializeCacheValue,
  registerCacheDriverFactory,
  serializeCacheValue,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheDriverPutInput,
  type CacheLockContract,
} from '@holo-js/cache'
import {
  createConnectionManager,
  createSchemaService,
  createRuntimeConnectionOptions,
  driverErrorCodes,
  isDatabaseDeadlockError,
  TableQueryBuilder,
  type DatabaseContext,
  type DatabaseContextOptions,
  type DriverExecutionResult,
  type SupportedDatabaseDriver,
  type TableDefinitionBuilder,
} from '@holo-js/db'
import type { HoloProjectConnectionConfig } from '@holo-js/kernel'

export const DEFAULT_CACHE_DATABASE_TABLE = 'cache'
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = 'cache_locks'
const DATABASE_CACHE_LOCK_LOTTERY = { chances: 2, outOf: 100 }
const MISSING_TABLE_DRIVER_CODES: ReadonlySet<string> = new Set(['SQLITE_ERROR', 'ER_NO_SUCH_TABLE', '42P01'])

export type CacheDatabaseTableColumnKind = 'string' | 'text' | 'bigInteger'

export type CacheDatabaseTableColumnDefinition = {
  readonly name: string
  readonly kind: CacheDatabaseTableColumnKind
  readonly nullable?: boolean
  readonly primaryKey?: boolean
}

export type CacheDatabaseTableDefinition = {
  readonly role: 'entries' | 'locks'
  readonly defaultName: string
  readonly columns: readonly CacheDatabaseTableColumnDefinition[]
  readonly indexColumn: string
  readonly indexName: (tableName: string) => string
}

export const CACHE_DATABASE_TABLE_DEFINITIONS = [
  {
    role: 'entries',
    defaultName: DEFAULT_CACHE_DATABASE_TABLE,
    columns: [
      { name: 'key', kind: 'string', primaryKey: true },
      { name: 'payload', kind: 'text' },
      { name: 'expires_at', kind: 'bigInteger', nullable: true },
    ],
    indexColumn: 'expires_at',
    indexName: tableName => `${tableName.replaceAll('.', '_')}_expires_at_index`,
  },
  {
    role: 'locks',
    defaultName: DEFAULT_CACHE_DATABASE_LOCK_TABLE,
    columns: [
      { name: 'name', kind: 'string', primaryKey: true },
      { name: 'owner', kind: 'string' },
      { name: 'expires_at', kind: 'bigInteger' },
    ],
    indexColumn: 'expires_at',
    indexName: tableName => `${tableName.replaceAll('.', '_')}_expires_at_index`,
  },
] as const satisfies readonly CacheDatabaseTableDefinition[]

export type DatabaseCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly table: string
  readonly lockTable: string
  readonly connection: HoloProjectConnectionConfig | string
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly ownerFactory?: () => string
}

type DatabaseCacheEntryRow = {
  readonly key: string
  readonly payload: string
  readonly expires_at: number | null
}

type DatabaseCacheLockRow = {
  readonly name: string
  readonly owner: string
  readonly expires_at: number
}

type DatabaseReadResult<TValue> =
  | {
      readonly state: 'missing'
    }
  | {
      readonly state: 'hit'
      readonly value: TValue
    }

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}

function resolveDriver(
  connection: HoloProjectConnectionConfig | string,
): SupportedDatabaseDriver {
  if (typeof connection === 'string') {
    if (
      connection === ':memory:'
      || connection.startsWith('file:')
      || connection.startsWith('/')
      || connection.startsWith('./')
      || connection.startsWith('../')
      || connection.endsWith('.db')
      || connection.endsWith('.sqlite')
      || connection.endsWith('.sqlite3')
    ) {
      return 'sqlite'
    }

    if (connection.startsWith('postgres://') || connection.startsWith('postgresql://')) {
      return 'postgres'
    }

    if (connection.startsWith('mysql://') || connection.startsWith('mysql2://')) {
      return 'mysql'
    }

    return 'sqlite'
  }

  return connection.driver ?? (connection.url
    ? resolveDriver(connection.url)
    : 'sqlite')
}

function createDatabaseContextOptions(
  connectionName: string,
  connection: HoloProjectConnectionConfig | string,
): DatabaseContextOptions {
  const driver = resolveDriver(connection)
  if (driver === 'sqlite') {
    const url = typeof connection === 'string'
      ? connection
      : connection.url ?? connection.filename ?? ':memory:'
    return createRuntimeConnectionOptions(driver, url, Boolean(typeof connection === 'string' ? false : connection.logging), undefined, connectionName)
  }

  const parsedPort = typeof connection === 'string'
    ? undefined
    : typeof connection.port === 'number'
      ? connection.port
      : typeof connection.port === 'string' && /^\d+$/.test(connection.port.trim())
        ? Number(connection.port.trim())
        : undefined
  const port = typeof parsedPort === 'number'
    && Number.isInteger(parsedPort)
    && parsedPort > 0
    && parsedPort <= 65_535
    ? parsedPort
    : undefined

  return createRuntimeConnectionOptions(
    driver,
    typeof connection === 'string'
      ? { url: connection }
      : {
          url: connection.url,
          host: connection.host,
          port,
          username: connection.username,
          password: connection.password,
          database: connection.database,
          ssl: connection.ssl,
        },
    Boolean(typeof connection === 'string' ? false : connection.logging),
    typeof connection === 'string' ? undefined : connection.schema,
    connectionName,
  )
}

function createDatabaseConnection(
  connectionName: string,
  connection: HoloProjectConnectionConfig | string,
): DatabaseContext {
  return createConnectionManager({
    defaultConnection: connectionName,
    connections: {
      [connectionName]: createDatabaseContextOptions(connectionName, connection),
    },
  }).connection(connectionName)
}

function applyCacheDatabaseColumnDefinition(
  table: TableDefinitionBuilder<string>,
  columnDefinition: CacheDatabaseTableColumnDefinition,
): void {
  let columnBuilder = table[columnDefinition.kind](columnDefinition.name)

  if (columnDefinition.primaryKey) {
    columnBuilder = columnBuilder.primaryKey()
  }

  if (columnDefinition.nullable) {
    columnBuilder.nullable()
  }
}

function applyCacheDatabaseTableDefinition(
  table: TableDefinitionBuilder<string>,
  tableName: string,
  tableDefinition: CacheDatabaseTableDefinition,
): void {
  for (const columnDefinition of tableDefinition.columns) {
    applyCacheDatabaseColumnDefinition(table, columnDefinition)
  }

  table.index([tableDefinition.indexColumn], tableDefinition.indexName(tableName))
}

function resolveCacheDatabaseTableDefinition(role: CacheDatabaseTableDefinition['role']): CacheDatabaseTableDefinition {
  const tableDefinition = CACHE_DATABASE_TABLE_DEFINITIONS.find(definition => definition.role === role)
  if (!tableDefinition) {
    throw new Error(`Missing cache database table definition for "${role}".`)
  }

  return tableDefinition
}

async function prepareCacheDatabaseTables(
  connection: DatabaseContext,
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): Promise<void> {
  const schema = createSchemaService(connection)
  await connection.initialize()
  const entryTableDefinition = resolveCacheDatabaseTableDefinition('entries')
  const lockTableDefinition = resolveCacheDatabaseTableDefinition('locks')

  if (!(await schema.hasTable(tableName))) {
    await schema.createTable(tableName, (table) => {
      applyCacheDatabaseTableDefinition(table, tableName, entryTableDefinition)
    })
  }

  if (!(await schema.hasTable(lockTableName))) {
    await schema.createTable(lockTableName, (table) => {
      applyCacheDatabaseTableDefinition(table, lockTableName, lockTableDefinition)
    })
  }
}

function resolveExecutionResultAffectedRows(result: DriverExecutionResult): number {
  /* v8 ignore next -- Holo DB adapters normalize affectedRows to a number for executed mutations. */
  return result.affectedRows ?? 0
}

function isDatabaseCacheTableMissingError(
  error: unknown,
  tableName: string,
  lockTableName: string,
): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  const mentionsCacheTable = message.includes(tableName.toLowerCase()) || message.includes(lockTableName.toLowerCase())

  if (driverErrorCodes(error).some(code => MISSING_TABLE_DRIVER_CODES.has(code.toUpperCase()))) {
    return mentionsCacheTable || message.includes('no such table') || message.includes('does not exist')
  }

  return (
    message.includes('no such table')
    || message.includes('does not exist')
    || message.includes("doesn't exist")
  ) && mentionsCacheTable
}

function normalizeDatabaseCacheTableError(
  error: unknown,
  tableName: string,
  lockTableName: string,
): never {
  if (isDatabaseCacheTableMissingError(error, tableName, lockTableName)) {
    throw new CacheConfigError(
      `[@holo-js/cache] Database cache tables "${tableName}" and "${lockTableName}" are missing. Run "holo cache:table" and then "holo migrate".`,
      { cause: error },
    )
  }

  throw error
}

async function withDatabaseCacheTableGuard<TValue>(
  tableName: string,
  lockTableName: string,
  callback: () => Promise<TValue>,
): Promise<TValue> {
  try {
    return await callback()
  } catch (error) {
    normalizeDatabaseCacheTableError(error, tableName, lockTableName)
  }
}

function normalizeDatabaseTimestamp(value: number | string): number {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp)) {
    throw new CacheConfigError('[@holo-js/cache] Database cache expiration must be a safe integer timestamp.')
  }
  return timestamp
}

async function readEntry(
  connection: DatabaseContext,
  tableName: string,
  key: string,
  now: number,
): Promise<DatabaseReadResult<DatabaseCacheEntryRow>> {
  const row = await new TableQueryBuilder(tableName, connection)
    .where('key', key)
    .first<Omit<DatabaseCacheEntryRow, 'expires_at'> & { expires_at: number | string | null }>()

  if (!row) {
    return { state: 'missing' }
  }

  const expiresAt = row.expires_at === null ? null : normalizeDatabaseTimestamp(row.expires_at)
  if (expiresAt !== null && expiresAt <= now) {
    await new TableQueryBuilder(tableName, connection)
      .where('key', key)
      .delete()
    return { state: 'missing' }
  }

  return {
    state: 'hit',
    value: { ...row, expires_at: expiresAt },
  }
}

async function readLock(
  connection: DatabaseContext,
  tableName: string,
  name: string,
): Promise<DatabaseCacheLockRow | undefined> {
  const row = await new TableQueryBuilder(tableName, connection)
    .where('name', name)
    .first<Omit<DatabaseCacheLockRow, 'expires_at'> & { expires_at: number | string }>()

  if (!row) {
    return undefined
  }

  return { ...row, expires_at: normalizeDatabaseTimestamp(row.expires_at) }
}

async function retryOnDeadlock<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
  try {
    return await operation()
  } catch (error) {
    if (!isDatabaseDeadlockError(error)) {
      throw error
    }

    return operation()
  }
}

async function pruneExpiredLocks(
  connection: DatabaseContext,
  tableName: string,
  nowMs: number,
): Promise<void> {
  try {
    await new TableQueryBuilder(tableName, connection)
      .where('expires_at', '<=', nowMs)
      .delete()
  } catch (error) {
    if (!isDatabaseDeadlockError(error)) {
      throw error
    }
  }
}

function createDatabaseLock(
  connection: DatabaseContext,
  tableName: string,
  entryTableName: string,
  name: string,
  seconds: number,
  now: () => number,
  sleep: (milliseconds: number) => Promise<void>,
  ownerFactory: () => string,
): CacheLockContract {
  const owner = ownerFactory()

  async function acquireInTransaction(): Promise<boolean> {
    return connection.transaction(async (tx) => {
      const nowMs = now()
      const existing = await readLock(tx, tableName, name)
      if (existing && existing.expires_at > nowMs) {
        return false
      }

      if (existing) {
        await new TableQueryBuilder(tableName, tx)
          .where('name', name)
          .where('expires_at', '<=', nowMs)
          .delete()
      }

      const inserted = await new TableQueryBuilder(tableName, tx).insertOrIgnore({
        name,
        owner,
        expires_at: nowMs + (seconds * 1000),
      })
      return resolveExecutionResultAffectedRows(inserted) > 0
    })
  }

  async function tryAcquire(): Promise<boolean> {
    return withDatabaseCacheTableGuard(entryTableName, tableName, async () => {
      if (Math.random() * DATABASE_CACHE_LOCK_LOTTERY.outOf < DATABASE_CACHE_LOCK_LOTTERY.chances) {
        await pruneExpiredLocks(connection, tableName, now())
      }

      return retryOnDeadlock(acquireInTransaction)
    })
  }

  async function withCallback<TValue>(
    callback: (() => TValue | Promise<TValue>) | undefined,
  ): Promise<boolean | TValue> {
    if (!callback) {
      return true
    }

    try {
      return await callback()
    } finally {
      await lock.release()
    }
  }

  const lock: CacheLockContract = {
    name,
    async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      if (!(await tryAcquire())) {
        return false
      }

      return withCallback(callback)
    },
    async release(): Promise<boolean> {
      const deleted = await withDatabaseCacheTableGuard(entryTableName, tableName, async () => resolveExecutionResultAffectedRows(
        await new TableQueryBuilder(tableName, connection)
          .where('name', name)
          .where('owner', owner)
          .delete(),
      ))

      return deleted > 0
    },
    async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      const deadline = now() + (waitSeconds * 1000)
      while (true) {
        if (await tryAcquire()) {
          return withCallback(callback)
        }

        if (now() >= deadline) {
          return false
        }

        await sleep(10)
      }
    },
  }

  return lock
}

export function createDatabaseCacheDriver(options: DatabaseCacheDriverOptions): CacheDriverContract {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const ownerFactory = options.ownerFactory ?? randomUUID
  const connection = createDatabaseConnection(options.connectionName, options.connection)
  const entryTableName = options.table
  const lockTableName = options.lockTable

  async function writeEntry(
    tx: DatabaseContext,
    input: CacheDriverPutInput,
  ): Promise<boolean> {
    await new TableQueryBuilder(entryTableName, tx)
      .upsert({
        key: input.key,
        payload: input.payload,
        expires_at: input.expiresAt ?? null,
      }, ['key'], ['payload', 'expires_at'])
    return true
  }

  async function mutateNumericValue(key: string, amount: number): Promise<number> {
    const result = await createDatabaseLock(
      connection,
      lockTableName,
      entryTableName,
      `__numeric__:${key}`,
      1,
      now,
      sleep,
      ownerFactory,
    ).block(1, async () => {
      return connection.transaction(async (tx) => {
        const entry = await readEntry(tx, entryTableName, key, now())
        const currentValue = entry.state === 'hit'
          ? deserializeCacheValue<unknown>(entry.value.payload)
          : 0

        if (typeof currentValue !== 'number' || !Number.isFinite(currentValue)) {
          throw new CacheInvalidNumericMutationError(`[@holo-js/cache] Cache key "${key}" does not contain a numeric value.`)
        }

        const nextValue = currentValue + amount
        await writeEntry(tx, {
          key,
          payload: serializeCacheValue(nextValue),
          expiresAt: entry.state === 'hit' ? (entry.value.expires_at ?? undefined) : undefined,
        })
        return nextValue
      })
    })

    if (result === false) {
      throw new CacheLockAcquisitionError(`[@holo-js/cache] Could not acquire database cache mutation lock for "${key}".`)
    }

    /* v8 ignore next 3 -- block() is only invoked with a callback here, so a bare boolean true is not a reachable runtime result. */
    if (result === true) {
      throw new CacheLockAcquisitionError(`[@holo-js/cache] Database cache mutation lock for "${key}" returned no numeric result.`)
    }

    return result
  }

  const driver: CacheDriverContract = {
    name: options.name,
    driver: 'database',
    async get(key: string): Promise<CacheDriverGetResult> {
      const entry = await withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => {
        return readEntry(connection, entryTableName, key, now())
      })
      if (entry.state === 'missing') {
        return Object.freeze({ hit: false })
      }

      return Object.freeze({
        hit: true,
        payload: entry.value.payload,
        expiresAt: entry.value.expires_at ?? undefined,
      })
    },
    async put(input: CacheDriverPutInput): Promise<boolean> {
      return withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => connection.transaction(async (tx) => {
        return writeEntry(tx, input)
      }))
    },
    async add(input: CacheDriverPutInput): Promise<boolean> {
      return withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => connection.transaction(async (tx) => {
        const existing = await readEntry(tx, entryTableName, input.key, now())
        if (existing.state === 'hit') {
          return false
        }

        const inserted = await new TableQueryBuilder(entryTableName, tx)
          .insertOrIgnore({
            key: input.key,
            payload: input.payload,
            expires_at: input.expiresAt ?? null,
          })

        return resolveExecutionResultAffectedRows(inserted) > 0
      }))
    },
    async forget(key: string): Promise<boolean> {
      return withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => {
        return resolveExecutionResultAffectedRows(
          await new TableQueryBuilder(entryTableName, connection)
            .where('key', key)
            .delete(),
        ) > 0
      })
    },
    async flush(): Promise<void> {
      await withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => {
        await new TableQueryBuilder(entryTableName, connection).delete()
      })
    },
    async increment(key: string, amount: number): Promise<number> {
      return mutateNumericValue(key, amount)
    },
    async decrement(key: string, amount: number): Promise<number> {
      return mutateNumericValue(key, -amount)
    },
    lock(name: string, seconds: number): CacheLockContract {
      return createDatabaseLock(connection, lockTableName, entryTableName, name, seconds, now, sleep, ownerFactory)
    },
  }
  Object.defineProperty(driver, Symbol.for('holo.cache.driver.dispose'), {
    value() {
      return connection.disconnect()
    },
  })
  return driver
}

export const databaseCacheDriverFactory = Object.freeze({
  driver: 'database',
  registrationKey: '@holo-js/cache-db',
  create: createDatabaseCacheDriver,
})

registerCacheDriverFactory(databaseCacheDriverFactory)

export const cacheDbInternals = {
  createDatabaseConnection,
  createDatabaseContextOptions,
  defaultSleep,
  isDatabaseCacheTableMissingError,
  normalizeDatabaseCacheTableError,
  prepareCacheDatabaseTables,
  readEntry,
  readLock,
  resolveDriver,
  withDatabaseCacheTableGuard,
}
