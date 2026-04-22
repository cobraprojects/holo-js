import { randomUUID } from 'node:crypto'
import {
  CacheConfigError,
  CacheInvalidNumericMutationError,
  CacheLockAcquisitionError,
  deserializeCacheValue,
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
  TableQueryBuilder,
  type DatabaseContext,
  type DatabaseContextOptions,
  type DriverExecutionResult,
  type HoloProjectConnectionConfig,
  type SupportedDatabaseDriver,
} from '@holo-js/db'

export const DEFAULT_CACHE_DATABASE_TABLE = 'cache'
export const DEFAULT_CACHE_DATABASE_LOCK_TABLE = 'cache_locks'

export type DatabaseCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly table: string
  readonly lockTable: string
  readonly prefix?: string
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
      : typeof connection.port === 'string' && connection.port.trim()
        ? Number.parseInt(connection.port.trim(), 10)
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

async function prepareCacheDatabaseTables(
  connection: DatabaseContext,
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): Promise<void> {
  const schema = createSchemaService(connection)
  await connection.initialize()

  if (!(await schema.hasTable(tableName))) {
    await schema.createTable(tableName, (table) => {
      table.string('key').primaryKey()
      table.text('payload')
      table.bigInteger('expires_at').nullable()
      table.index(['expires_at'], `${tableName.replaceAll('.', '_')}_expires_at_index`)
    })
  }

  if (!(await schema.hasTable(lockTableName))) {
    await schema.createTable(lockTableName, (table) => {
      table.string('name').primaryKey()
      table.string('owner')
      table.bigInteger('expires_at')
      table.index(['expires_at'], `${lockTableName.replaceAll('.', '_')}_expires_at_index`)
    })
  }
}

function renderCacheTableMigration(
  tableName = DEFAULT_CACHE_DATABASE_TABLE,
  lockTableName = DEFAULT_CACHE_DATABASE_LOCK_TABLE,
): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'key\').primaryKey()',
    '      table.text(\'payload\')',
    '      table.bigInteger(\'expires_at\').nullable()',
    `      table.index(['expires_at'], '${tableName.replaceAll('.', '_')}_expires_at_index')`,
    '    })',
    `    await schema.createTable('${lockTableName}', (table) => {`,
    '      table.string(\'name\').primaryKey()',
    '      table.string(\'owner\')',
    '      table.bigInteger(\'expires_at\')',
    `      table.index(['expires_at'], '${lockTableName.replaceAll('.', '_')}_expires_at_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${lockTableName}')`,
    `    await schema.dropTable('${tableName}')`,
    '  },',
    '})',
    '',
  ].join('\n')
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
  const errorCode = typeof Reflect.get(error, 'code') === 'string'
    ? String(Reflect.get(error, 'code')).toUpperCase()
    : undefined
  const mentionsCacheTable = message.includes(tableName.toLowerCase()) || message.includes(lockTableName.toLowerCase())

  if (errorCode === 'SQLITE_ERROR' || errorCode === 'ER_NO_SUCH_TABLE' || errorCode === '42P01') {
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

async function readEntry(
  connection: DatabaseContext,
  tableName: string,
  key: string,
  now: number,
): Promise<DatabaseReadResult<DatabaseCacheEntryRow>> {
  const row = await new TableQueryBuilder(tableName, connection)
    .where('key', key)
    .first<DatabaseCacheEntryRow>()

  if (!row) {
    return { state: 'missing' }
  }

  if (typeof row.expires_at === 'number' && row.expires_at <= now) {
    await new TableQueryBuilder(tableName, connection)
      .where('key', key)
      .delete()
    return { state: 'missing' }
  }

  return {
    state: 'hit',
    value: row,
  }
}

async function readLock(
  connection: DatabaseContext,
  tableName: string,
  name: string,
  now: number,
): Promise<DatabaseReadResult<DatabaseCacheLockRow>> {
  const row = await new TableQueryBuilder(tableName, connection)
    .where('name', name)
    .first<DatabaseCacheLockRow>()

  if (!row) {
    return { state: 'missing' }
  }

  if (row.expires_at <= now) {
    await new TableQueryBuilder(tableName, connection)
      .where('name', name)
      .delete()
    return { state: 'missing' }
  }

  return {
    state: 'hit',
    value: row,
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

  async function tryAcquire(): Promise<boolean> {
    return withDatabaseCacheTableGuard(entryTableName, tableName, async () => connection.transaction(async (tx) => {
      const locks = new TableQueryBuilder(tableName, tx)
      const existing = await readLock(tx, tableName, name, now())
      if (existing.state === 'hit') {
        return false
      }

      const inserted = await locks.insertOrIgnore({
        name,
        owner,
        expires_at: now() + (seconds * 1000),
      })
      return resolveExecutionResultAffectedRows(inserted) > 0
    }))
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
      const deleted = await withDatabaseCacheTableGuard(entryTableName, tableName, async () => connection.transaction(async (tx) => {
        const current = await readLock(tx, tableName, name, now())
        if (current.state === 'missing' || current.value.owner !== owner) {
          return 0
        }

        return resolveExecutionResultAffectedRows(
          await new TableQueryBuilder(tableName, tx)
            .where('name', name)
            .delete(),
        )
      }))

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
  const prefix = options.prefix ?? ''

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

  return {
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
      await withDatabaseCacheTableGuard(entryTableName, lockTableName, async () => connection.transaction(async (tx) => {
        if (!prefix) {
          await new TableQueryBuilder(lockTableName, tx).delete()
          await new TableQueryBuilder(entryTableName, tx).delete()
          return
        }

        const likePattern = `${prefix}%`

        await new TableQueryBuilder(lockTableName, tx)
          .whereLike('name', likePattern)
          .delete()
        await new TableQueryBuilder(entryTableName, tx)
          .whereLike('key', likePattern)
          .delete()
      }))
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
}

export const cacheDbInternals = {
  createDatabaseConnection,
  createDatabaseContextOptions,
  defaultSleep,
  isDatabaseCacheTableMissingError,
  normalizeDatabaseCacheTableError,
  prepareCacheDatabaseTables,
  readEntry,
  readLock,
  renderCacheTableMigration,
  resolveDriver,
  withDatabaseCacheTableGuard,
}
