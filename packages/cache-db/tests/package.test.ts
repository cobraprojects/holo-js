import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CacheConfigError, CacheInvalidNumericMutationError, deserializeCacheValue, serializeCacheValue } from '@holo-js/cache'
import {
  DB,
  TableQueryBuilder,
  clearGeneratedTables,
  column,
  configureDB,
  createConnectionManager,
  createRuntimeConnectionOptions,
  createSchemaService,
  defineGeneratedTable,
  defineModel,
  registerGeneratedTables,
  resetDB,
} from '@holo-js/db'
import {
  cacheDbInternals,
  createDatabaseCacheDriver,
  DEFAULT_CACHE_DATABASE_LOCK_TABLE,
  DEFAULT_CACHE_DATABASE_TABLE,
} from '../src/index'

const tempDirectories: string[] = []

async function createPreparedDriver(options: {
  readonly table?: string
  readonly lockTable?: string
  readonly databasePath?: string
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly ownerFactory?: () => string
} = {}) {
  const table = options.table ?? DEFAULT_CACHE_DATABASE_TABLE
  const lockTable = options.lockTable ?? DEFAULT_CACHE_DATABASE_LOCK_TABLE
  const tempDirectory = await mkdtemp(join(tmpdir(), 'holo-cache-db-'))
  tempDirectories.push(tempDirectory)
  const databasePath = options.databasePath ?? join(tempDirectory, 'cache.sqlite')
  const connection = cacheDbInternals.createDatabaseConnection('cache', {
    driver: 'sqlite',
    filename: databasePath,
  })
  await cacheDbInternals.prepareCacheDatabaseTables(connection, table, lockTable)

  return {
    databasePath,
    connection,
    driver: createDatabaseCacheDriver({
      name: 'database',
      connectionName: 'cache',
      table,
      lockTable,
      connection: {
        driver: 'sqlite',
        filename: databasePath,
      },
      now: options.now,
      sleep: options.sleep,
      ownerFactory: options.ownerFactory,
    }),
  }
}

async function createPublicFeatureHarness() {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'holo-cache-db-feature-'))
  tempDirectories.push(tempDirectory)
  const databasePath = join(tempDirectory, 'feature.sqlite')

  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: {
      default: createRuntimeConnectionOptions('sqlite', databasePath, false, undefined, 'default'),
    },
  }))

  const users = defineGeneratedTable('users', {
    id: column.id(),
    name: column.string(),
    status: column.string(),
    loginCount: column.integer(),
    created_at: column.timestamp().defaultNow(),
    updated_at: column.timestamp().defaultNow(),
  })
  registerGeneratedTables({ users })

  const User = defineModel('users', {
    fillable: ['name', 'status', 'loginCount'],
    timestamps: true,
  })

  const schema = createSchemaService(DB.connection())
  await schema.sync([users])
  await schema.createTable(DEFAULT_CACHE_DATABASE_TABLE, (table) => {
    table.string('key').primaryKey()
    table.text('payload')
    table.bigInteger('expires_at').nullable()
    table.index(['expires_at'], `${DEFAULT_CACHE_DATABASE_TABLE}_expires_at_index`)
  })
  await schema.createTable(DEFAULT_CACHE_DATABASE_LOCK_TABLE, (table) => {
    table.string('name').primaryKey()
    table.string('owner')
    table.bigInteger('expires_at')
    table.index(['expires_at'], `${DEFAULT_CACHE_DATABASE_LOCK_TABLE}_expires_at_index`)
  })

  const driver = createDatabaseCacheDriver({
    name: 'database',
    connectionName: 'default',
    table: DEFAULT_CACHE_DATABASE_TABLE,
    lockTable: DEFAULT_CACHE_DATABASE_LOCK_TABLE,
    connection: databasePath,
    prefix: 'users:',
  })

  return {
    User,
    driver,
    databasePath,
  }
}

describe('@holo-js/cache-db', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetDB()
    clearGeneratedTables()
  })

  afterEach(async () => {
    resetDB()
    clearGeneratedTables()
    await Promise.all(tempDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true })
    }))
  })

  it('renders the cache table migration scaffold', () => {
    const migration = cacheDbInternals.renderCacheTableMigration('cache_entries', 'cache_entry_locks')

    expect(migration).toContain('await schema.createTable(\'cache_entries\'')
    expect(migration).toContain('await schema.createTable(\'cache_entry_locks\'')
    expect(migration).toContain('await schema.dropTable(\'cache_entry_locks\')')
  })

  it('resolves database drivers from explicit config and urls', () => {
    expect(cacheDbInternals.resolveDriver({ driver: 'mysql' })).toBe('mysql')
    expect(cacheDbInternals.resolveDriver('postgres://cache.internal/db')).toBe('postgres')
    expect(cacheDbInternals.resolveDriver({ url: 'mysql://cache.internal/db' })).toBe('mysql')
    expect(cacheDbInternals.resolveDriver({ filename: 'cache.sqlite' })).toBe('sqlite')
    expect(cacheDbInternals.resolveDriver('cache-name')).toBe('sqlite')
    expect(cacheDbInternals.resolveDriver(':memory:')).toBe('sqlite')
  })

  it('creates runtime database context options for sqlite and networked drivers', async () => {
    await expect(cacheDbInternals.defaultSleep(0)).resolves.toBeUndefined()

    expect(cacheDbInternals.createDatabaseContextOptions('cache', ':memory:')).toMatchObject({
      connectionName: 'cache',
      driver: 'sqlite',
      schemaName: undefined,
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', {
      filename: 'cache.sqlite',
    })).toMatchObject({
      connectionName: 'cache',
      driver: 'sqlite',
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', {} as never)).toMatchObject({
      connectionName: 'cache',
      driver: 'sqlite',
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', {
      driver: 'postgres',
      url: 'postgres://cache.internal/db',
      schema: 'cache',
      logging: true,
    })).toMatchObject({
      connectionName: 'cache',
      driver: 'postgres',
      schemaName: 'cache',
      security: {
        debugSqlInLogs: true,
        redactBindingsInLogs: false,
      },
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', 'postgres://cache.internal/db')).toMatchObject({
      connectionName: 'cache',
      driver: 'postgres',
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', {
      driver: 'postgres',
      url: 'postgres://cache.internal/db',
      port: 5432,
    })).toMatchObject({
      connectionName: 'cache',
      driver: 'postgres',
    })
    expect(cacheDbInternals.createDatabaseContextOptions('cache', {
      driver: 'postgres',
      url: 'postgres://cache.internal/db',
      port: '5432' as never,
    })).toMatchObject({
      connectionName: 'cache',
      driver: 'postgres',
    })
    const stringPortOptions = cacheDbInternals.createDatabaseContextOptions('cache', {
      driver: 'postgres',
      host: 'cache.internal',
      database: 'app',
      username: 'user',
      password: 'secret',
      port: '5433' as never,
    })
    const adapter = stringPortOptions.adapter as {
      readonly options?: {
        readonly config?: {
          readonly host?: string
          readonly port?: number
          readonly user?: string
          readonly password?: string
          readonly database?: string
        }
      }
    }

    expect(adapter.options?.config).toMatchObject({
      host: 'cache.internal',
      port: 5433,
      user: 'user',
      password: 'secret',
      database: 'app',
    })

    const invalidStringPortOptions = cacheDbInternals.createDatabaseContextOptions('cache', {
      driver: 'postgres',
      host: 'cache.internal',
      database: 'app',
      username: 'user',
      password: 'secret',
      port: 'not-a-port' as never,
    })
    const invalidStringAdapter = invalidStringPortOptions.adapter as {
      readonly options?: {
        readonly config?: {
          readonly port?: number
        }
      }
    }

    expect(invalidStringAdapter.options?.config?.port).toBeUndefined()
  })

  it('creates cache tables through the shared schema helper', async () => {
    const connection = cacheDbInternals.createDatabaseConnection('cache', {
      driver: 'sqlite',
      filename: ':memory:',
    })

    await cacheDbInternals.prepareCacheDatabaseTables(connection, 'entries', 'locks')

    const schema = createSchemaService(connection)
    await expect(schema.hasTable('entries')).resolves.toBe(true)
    await expect(schema.hasTable('locks')).resolves.toBe(true)
  })

  it('normalizes missing-table errors only for matching cache table failures', async () => {
    expect(cacheDbInternals.isDatabaseCacheTableMissingError('boom', 'cache_entries', 'cache_entry_locks')).toBe(false)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      Object.assign(new Error('SQLITE_ERROR: no such table: cache_entries'), { code: 'SQLITE_ERROR' }),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(true)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      Object.assign(new Error('relation "cache_entry_locks" does not exist'), { code: '42P01' }),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(true)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      Object.assign(new Error('table lookup failed'), { code: 'SQLITE_ERROR' }),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(false)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      new Error('Table other_table does not exist'),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(false)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      new Error('Table cache_entry_locks does not exist'),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(true)
    expect(cacheDbInternals.isDatabaseCacheTableMissingError(
      new Error('Table cache_entry_locks doesn\'t exist'),
      'cache_entries',
      'cache_entry_locks',
    )).toBe(true)

    expect(() => cacheDbInternals.normalizeDatabaseCacheTableError(
      new Error('Query failed for another reason.'),
      'cache_entries',
      'cache_entry_locks',
    )).toThrow('Query failed for another reason.')
  })

  it('passes through successful guarded callbacks', async () => {
    await expect(cacheDbInternals.withDatabaseCacheTableGuard(
      'cache_entries',
      'cache_entry_locks',
      async () => 'ok',
    )).resolves.toBe('ok')
  })

  it('throws a helpful error when the database cache entry tables are missing', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'holo-cache-db-missing-entry-'))
    tempDirectories.push(tempDirectory)
    const databasePath = join(tempDirectory, 'missing-entry.sqlite')
    const driver = createDatabaseCacheDriver({
      name: 'database',
      connectionName: 'cache',
      table: 'cache_entries',
      lockTable: 'cache_entry_locks',
      connection: {
        driver: 'sqlite',
        filename: databasePath,
      },
    })

    await expect(driver.get('alpha')).rejects.toThrow(CacheConfigError)
    await expect(driver.get('alpha')).rejects.toThrow(
      '[@holo-js/cache] Database cache tables "cache_entries" and "cache_entry_locks" are missing. Run "holo cache:table" and then "holo migrate".',
    )
  })

  it('throws a helpful error when the database cache lock table is missing', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'holo-cache-db-missing-lock-'))
    tempDirectories.push(tempDirectory)
    const databasePath = join(tempDirectory, 'missing-lock.sqlite')
    const connection = cacheDbInternals.createDatabaseConnection('cache', {
      driver: 'sqlite',
      filename: databasePath,
    })
    await cacheDbInternals.prepareCacheDatabaseTables(connection, 'cache_entries', 'cache_entry_locks')
    await createSchemaService(connection).dropTable('cache_entry_locks')

    const driver = createDatabaseCacheDriver({
      name: 'database',
      connectionName: 'cache',
      table: 'cache_entries',
      lockTable: 'cache_entry_locks',
      connection: {
        driver: 'sqlite',
        filename: databasePath,
      },
    })

    await expect(driver.lock('report', 60).get()).rejects.toThrow(CacheConfigError)
    await expect(driver.lock('report', 60).get()).rejects.toThrow(
      '[@holo-js/cache] Database cache tables "cache_entries" and "cache_entry_locks" are missing. Run "holo cache:table" and then "holo migrate".',
    )
  })

  it('supports reads, writes, adds, forgets, and flushes', async () => {
    const { driver } = await createPreparedDriver()

    expect(await driver.put({
      key: 'alpha',
      payload: '"one"',
      expiresAt: Date.now() + 60_000,
    })).toBe(true)
    expect(await driver.get('alpha')).toEqual({
      hit: true,
      payload: '"one"',
      expiresAt: expect.any(Number),
    })
    expect(await driver.add({
      key: 'alpha',
      payload: '"two"',
      expiresAt: Date.now() + 61_000,
    })).toBe(false)
    expect(await driver.add({
      key: 'beta',
      payload: '"two"',
      expiresAt: Date.now() + 61_000,
    })).toBe(true)
    expect(await driver.put({
      key: 'gamma',
      payload: '"three"',
    })).toBe(true)
    expect(await driver.get('gamma')).toEqual({
      hit: true,
      payload: '"three"',
      expiresAt: undefined,
    })
    expect(await driver.add({
      key: 'delta',
      payload: '"four"',
    })).toBe(true)
    expect(await driver.forget('beta')).toBe(true)
    expect(await driver.forget('beta')).toBe(false)
    await driver.flush()
    expect(await driver.get('alpha')).toEqual({ hit: false })
  })

  it('preserves differently prefixed entries when flushing a shared database store', async () => {
    const { databasePath } = await createPreparedDriver()
    const primary = createDatabaseCacheDriver({
      name: 'primary',
      connectionName: 'cache',
      table: DEFAULT_CACHE_DATABASE_TABLE,
      lockTable: DEFAULT_CACHE_DATABASE_LOCK_TABLE,
      connection: {
        driver: 'sqlite',
        filename: databasePath,
      },
      prefix: 'primary:',
    })
    const secondary = createDatabaseCacheDriver({
      name: 'secondary',
      connectionName: 'cache',
      table: DEFAULT_CACHE_DATABASE_TABLE,
      lockTable: DEFAULT_CACHE_DATABASE_LOCK_TABLE,
      connection: {
        driver: 'sqlite',
        filename: databasePath,
      },
      prefix: 'secondary:',
    })

    await primary.put({
      key: 'primary:alpha',
      payload: '"one"',
      expiresAt: Date.now() + 60_000,
    })
    await secondary.put({
      key: 'secondary:alpha',
      payload: '"two"',
      expiresAt: Date.now() + 60_000,
    })
    expect(await primary.lock('primary:report', 60).get()).toBe(true)
    expect(await secondary.lock('secondary:report', 60).get()).toBe(true)

    const getSpy = vi.spyOn(TableQueryBuilder.prototype, 'get')

    await primary.flush()
    expect(getSpy).not.toHaveBeenCalled()
    getSpy.mockRestore()

    expect(await primary.get('primary:alpha')).toEqual({ hit: false })
    expect(await secondary.get('secondary:alpha')).toEqual({
      hit: true,
      payload: '"two"',
      expiresAt: expect.any(Number),
    })
    expect(await primary.lock('primary:report', 60).get()).toBe(true)
    expect(await secondary.lock('secondary:report', 60).get()).toBe(false)
  })

  it('supports expiration cleanup and numeric mutation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'))

    const { driver } = await createPreparedDriver({
      now: Date.now,
    })

    await driver.put({
      key: 'ttl',
      payload: '"ok"',
      expiresAt: Date.now() + 1_000,
    })
    expect(await driver.get('ttl')).toEqual({
      hit: true,
      payload: '"ok"',
      expiresAt: Date.now() + 1_000,
    })

    vi.advanceTimersByTime(1_001)
    expect(await driver.get('ttl')).toEqual({ hit: false })

    expect(await driver.increment('counter', 2)).toBe(2)
    expect(await driver.decrement('counter', 1)).toBe(1)

    await driver.put({
      key: 'label',
      payload: '"text"',
    })
    await expect(driver.increment('label', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
  })

  it('implements database-backed locks with release and wait behavior', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'))

    const { driver } = await createPreparedDriver({
      now: Date.now,
      sleep: async (milliseconds) => {
        vi.advanceTimersByTime(milliseconds)
      },
      ownerFactory: (() => {
        let counter = 0
        return () => `owner-${++counter}`
      })(),
    })

    const firstLock = driver.lock('report', 1)
    const secondLock = driver.lock('report', 1)

    expect(await firstLock.get()).toBe(true)
    expect(await secondLock.get()).toBe(false)
    expect(await secondLock.release()).toBe(false)
    expect(await firstLock.release()).toBe(true)
    expect(await secondLock.get(async () => 'after-release')).toBe('after-release')

    const blockingLock = driver.lock('wait', 0.02)
    expect(await blockingLock.get()).toBe(true)
    await expect(driver.lock('wait', 0.02).block(0.05, async () => 'after-wait')).resolves.toBe('after-wait')
  })

  it('times out contested locks and numeric mutations when the lock is held too long', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'))

    const { driver } = await createPreparedDriver({
      now: Date.now,
      sleep: async (milliseconds) => {
        vi.advanceTimersByTime(milliseconds)
      },
      ownerFactory: (() => {
        let counter = 0
        return () => `owner-${++counter}`
      })(),
    })

    const heldLock = driver.lock('stuck', 2)
    expect(await heldLock.get()).toBe(true)
    await expect(driver.lock('stuck', 0.5).block(1, async () => 'never')).resolves.toBe(false)

    const numericLock = driver.lock('__numeric__:counter', 2)
    expect(await numericLock.get()).toBe(true)
    await expect(driver.increment('counter', 1)).rejects.toThrow('Could not acquire database cache mutation lock for "counter".')
  })

  it('supports a public-api integration flow with real models and persisted cache records', async () => {
    const { User, driver } = await createPublicFeatureHarness()

    await User.createMany([
      { name: 'Amina', status: 'active', loginCount: 4 },
      { name: 'Omar', status: 'active', loginCount: 2 },
      { name: 'Layla', status: 'disabled', loginCount: 1 },
    ])

    const refreshResult = await driver.lock('users:refresh-summary', 5).get(async () => {
      const activeUsers = await User.where('status', 'active').orderBy('id').get()
      const summary = {
        totalActiveUsers: activeUsers.length,
        totalLoginCount: activeUsers.reduce((sum, user) => sum + Number(user.get('loginCount')), 0),
        names: activeUsers.map(user => String(user.get('name'))),
      }

      await driver.put({
        key: 'users:summary',
        payload: serializeCacheValue(summary),
        expiresAt: Date.now() + 60_000,
      })

      return summary
    })

    expect(refreshResult).toEqual({
      totalActiveUsers: 2,
      totalLoginCount: 6,
      names: ['Amina', 'Omar'],
    })

    const cachedSummary = await driver.get('users:summary')
    expect(cachedSummary.hit).toBe(true)
    if (!cachedSummary.hit) {
      throw new Error('Expected cached summary to be present.')
    }
    if (typeof cachedSummary.payload !== 'string') {
      throw new Error('Expected cached summary payload to be a string.')
    }
    expect(deserializeCacheValue(cachedSummary.payload)).toEqual(refreshResult)

    expect(await driver.increment('users:refresh-count', 1)).toBe(1)
    expect(await driver.increment('users:refresh-count', 4)).toBe(5)
    expect(await driver.decrement('users:refresh-count', 2)).toBe(3)

    const persistedEntries = await new TableQueryBuilder(DEFAULT_CACHE_DATABASE_TABLE, DB.connection())
      .orderBy('key')
      .get<{ key: string, payload: string, expires_at: number | null }>()
    expect(persistedEntries).toEqual([
      {
        key: 'users:refresh-count',
        payload: '3',
        expires_at: null,
      },
      {
        key: 'users:summary',
        payload: JSON.stringify(refreshResult),
        expires_at: expect.any(Number),
      },
    ])

    expect(await driver.lock('users:refresh-summary', 5).get()).toBe(true)
    expect(await driver.lock('users:refresh-summary', 5).release()).toBe(false)

    await driver.flush()

    expect(await driver.get('users:summary')).toEqual({ hit: false })
    expect(await driver.get('users:refresh-count')).toEqual({ hit: false })
    await expect(User.query().orderBy('id').pluck('name')).resolves.toEqual(['Amina', 'Omar', 'Layla'])
  })
})
