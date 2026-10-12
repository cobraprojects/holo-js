import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAdapter,
  createDialect,
  createRuntimeConnectionOptions,
  createRuntimeLogger,
  isSupportedDatabaseDriver,
  parseDatabaseDriver,
  resolveRuntimeConnectionManagerOptions,
  DeferredDatabaseDriverAdapter } from '../src'
import { openDatabase } from './support/database'
import { DEFAULT_HOLO_PROJECT_PATHS, defineHoloProject, normalizeHoloProjectConfig } from '@holo-js/kernel'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime config helpers', () => {
  it('rejects a non-boolean raw SQL opt-in in application configuration', () => {
    const connections = {
      main: { driver: 'postgres' as const, url: 'postgres://localhost/app', security: { allowUnsafeRawSql: true } },
    }
    Object.assign(connections.main.security, { allowUnsafeRawSql: 'false' })
    expect(() => resolveRuntimeConnectionManagerOptions({ db: { connections } })).toThrow('allowUnsafeRawSql must be a boolean')
  })

  it('normalizes and defines Holo project configuration', () => {
    const normalized = normalizeHoloProjectConfig()
    expect(normalized.paths).toEqual(DEFAULT_HOLO_PROJECT_PATHS)
    expect(normalized.models).toEqual([])
    expect(normalized.migrations).toEqual([])
    expect(normalized.seeders).toEqual([])
    expect(Object.isFrozen(normalized)).toBe(true)
    expect(Object.isFrozen(normalized.paths)).toBe(true)
    expect(Object.isFrozen(normalized.models)).toBe(true)

    const defined = defineHoloProject({
      paths: {
        models: 'app/models',
        commands: 'app/commands',
        jobs: 'app/jobs',
      },
      database: {
        defaultConnection: 'analytics',
        connections: {
          analytics: 'postgres://localhost/analytics' } },
      models: ['server/models/User.ts'],
      migrations: ['server/db/migrations/001_users.ts'],
      seeders: ['server/db/seeders/UserSeeder.ts'] })

    expect(defined.paths.models).toBe('app/models')
    expect(defined.paths.commands).toBe('app/commands')
    expect(defined.paths.jobs).toBe('app/jobs')
    expect(defined.database?.defaultConnection).toBe('analytics')
    expect(defined.models).toEqual(['server/models/User.ts'])
    expect(defined.migrations).toEqual(['server/db/migrations/001_users.ts'])
    expect(defined.seeders).toEqual(['server/db/seeders/UserSeeder.ts'])
  })

  it('parses supported drivers and creates dialects', () => {
    expect(isSupportedDatabaseDriver('sqlite')).toBe(true)
    expect(isSupportedDatabaseDriver('postgres')).toBe(true)
    expect(isSupportedDatabaseDriver('mysql')).toBe(true)
    expect(isSupportedDatabaseDriver('mssql')).toBe(false)

    expect(parseDatabaseDriver(undefined, 'sqlite')).toBe('sqlite')
    expect(parseDatabaseDriver('postgres', 'sqlite')).toBe('postgres')
    expect(() => parseDatabaseDriver('oracle', 'sqlite')).toThrow('Unsupported Holo database driver "oracle"')

    const sqliteDialect = createDialect('sqlite')
    expect(sqliteDialect.name).toBe('sqlite')
    expect(sqliteDialect.quoteIdentifier('users')).toBe('"users"')
    expect(sqliteDialect.createPlaceholder(1)).toBe('?')

    const postgresDialect = createDialect('postgres')
    expect(postgresDialect.name).toBe('postgres')
    expect(postgresDialect.quoteIdentifier('public.users')).toBe('"public"."users"')
    expect(postgresDialect.createPlaceholder(2)).toBe('$2')
    expect(postgresDialect.capabilities.returning).toBe(true)

    const mysqlDialect = createDialect('mysql')
    expect(mysqlDialect.name).toBe('mysql')
    expect(mysqlDialect.quoteIdentifier('app.users')).toBe('`app`.`users`')
    expect(mysqlDialect.createPlaceholder(3)).toBe('?')
    expect(mysqlDialect.capabilities.concurrentQueries).toBe(true)
  })

  it('creates adapters and runtime connection options for each driver', () => {
    expect(createAdapter('postgres', 'postgres://localhost/app')).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(createAdapter('postgres', {
      host: 'localhost',
      port: 5432,
      username: 'holo',
      password: 'secret',
      database: 'app',
      ssl: { rejectUnauthorized: false } })).toBeInstanceOf(DeferredDatabaseDriverAdapter)

    expect(createAdapter('mysql', 'mysql://localhost/app')).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(createAdapter('mysql', {
      host: 'localhost',
      port: 3306,
      username: 'holo',
      password: 'secret',
      database: 'app',
      ssl: true })).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(createAdapter('mysql', {
      host: 'localhost',
      database: 'app' })).toBeInstanceOf(DeferredDatabaseDriverAdapter)

    expect(createAdapter('sqlite', './data.sqlite')).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(createAdapter('sqlite', { database: ':memory:' })).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(createAdapter('sqlite', {})).toBeInstanceOf(DeferredDatabaseDriverAdapter)
    expect(() => createAdapter('oracle' as never, {})).toThrow('Unsupported Holo database driver')

    const sqliteOptions = createRuntimeConnectionOptions('sqlite', './data.sqlite', false, 'main', 'sqlite-main')
    expect(sqliteOptions.connectionName).toBe('sqlite-main')
    expect(sqliteOptions.driver).toBe('sqlite')
    expect(sqliteOptions.schemaName).toBe('main')
    expect(sqliteOptions.logger).toBeUndefined()
    expect(sqliteOptions.security).toBeUndefined()

    const postgresOptions = createRuntimeConnectionOptions('postgres', {
      host: 'localhost',
      port: 5432,
      username: 'holo',
      password: 'secret',
      database: 'app' }, true, 'public', 'pg-main')
    expect(postgresOptions.connectionName).toBe('pg-main')
    expect(postgresOptions.driver).toBe('postgres')
    expect(postgresOptions.logger).toBeDefined()
    expect(postgresOptions.security).toEqual({
      debugSqlInLogs: true,
      redactBindingsInLogs: false })
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('logs real %s query and transaction outcomes', async driver => {
    expect(createRuntimeLogger(false)).toBeUndefined()
    const warnings = vi.spyOn(console, 'warn')
    const errors = vi.spyOn(console, 'error')
    const { db, table } = await openDatabase(driver, { logger: createRuntimeLogger(true), security: { debugSqlInLogs: true } })
    await db.table(table).insert({ id: 1, name: 'Persisted' })
    expect(await db.table(table).count()).toBe(1)
    await db.transaction(async tx => { await tx.table(table).insert({ id: 2, name: 'Committed' }) })
    await expect(db.transaction(async tx => {
      await tx.table(table).insert({ id: 3, name: 'Rolled back' })
      throw new Error('transaction failed')
    })).rejects.toThrow('transaction failed')
    await expect(db.queryCompiled({ sql: 'SELECT * FROM holo_nonexistent_table', source: 'query' })).rejects.toThrow()
    expect(await db.table(table).orderBy('id').pluck('name')).toEqual(['Persisted', 'Committed'])
    const output = warnings.mock.calls.flat().join('\n')
    expect(output).toContain('query ok connection=default')
    expect(output).toContain('execute ok connection=default')
    expect(output).toContain('transaction start')
    expect(output).toContain('transaction commit')
    expect(output).toContain('transaction rollback')
    expect(errors.mock.calls.flat().join('\n')).toContain('query error connection=default')
  })

  it('resolves runtime connection managers from defaults and explicit groups', () => {
    const defaultManager = resolveRuntimeConnectionManagerOptions({})
    expect(defaultManager.getDefaultConnectionName()).toBe('default')
    expect(defaultManager.getConnectionNames()).toEqual(['default'])
    expect(defaultManager.connection().getDriver()).toBe('sqlite')
    expect(defaultManager.connection().getSchemaName()).toBeUndefined()

    const mergedManager = resolveRuntimeConnectionManagerOptions({
      db: {
        defaultConnection: 'reporting',
        connections: {
          primary: {
            driver: 'sqlite',
            filename: './primary.sqlite' },
          analytics: 'postgres://localhost/analytics',
          reporting: 'mysql2://localhost/reporting' } } })
    expect(mergedManager.getDefaultConnectionName()).toBe('reporting')
    expect(mergedManager.getConnectionNames()).toEqual(['primary', 'analytics', 'reporting'])
    expect(mergedManager.connection('primary').getDriver()).toBe('sqlite')
    expect(mergedManager.connection('analytics').getDriver()).toBe('postgres')
    expect(mergedManager.connection('reporting').getDriver()).toBe('mysql')

    const implicitDefaultManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          first: './first.sqlite' } } })
    expect(implicitDefaultManager.getDefaultConnectionName()).toBe('first')
    expect(implicitDefaultManager.connection().getDriver()).toBe('sqlite')
  })

  it('uses the configured default connection as-is', () => {
    const manager = resolveRuntimeConnectionManagerOptions({
      db: {
        defaultConnection: 'primary',
        connections: {
          primary: {
            driver: 'sqlite',
            url: './manifest.sqlite' } } } })

    expect(manager.getDefaultConnectionName()).toBe('primary')
    expect((manager.connection().getAdapter() as unknown as { connection: { url?: string } }).connection.url).toBe('./manifest.sqlite')
  })

  it('infers drivers from urls and rejects incomplete network-only configs', () => {
    const postgresManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'postgresql://localhost/app' } } })
    expect(postgresManager.connection().getDriver()).toBe('postgres')

    const mysqlManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'mysql://localhost/app' } } })
    expect(mysqlManager.connection().getDriver()).toBe('mysql')

    const sqliteManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: '../data/app.sqlite3' } } })
    expect(sqliteManager.connection().getDriver()).toBe('sqlite')

    const dbFileManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'app.db' } } })
    expect(dbFileManager.connection().getDriver()).toBe('sqlite')

    const sqliteFileManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'app.sqlite' } } })
    expect(sqliteFileManager.connection().getDriver()).toBe('sqlite')

    const fallbackManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'redis://cache',
          shadow: undefined as never } } } as never)
    expect(fallbackManager.connection().getDriver()).toBe('sqlite')

    const booleanSslManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            driver: 'postgres',
            host: 'localhost',
            ssl: true } } } })
    expect(booleanSslManager.connection().getDriver()).toBe('postgres')

    const stringPortManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            driver: 'postgres',
            host: 'localhost',
            port: '5432',
            username: 'holo',
            database: 'app',
          },
        },
      },
    })
    expect((stringPortManager.connection().getAdapter() as unknown as {
      connection: { port?: number }
    }).connection.port).toBe(5432)

    const invalidPortManager = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            driver: 'postgres',
            host: 'localhost',
            port: 'invalid',
          },
        },
      },
    } as never)
    expect((invalidPortManager.connection().getAdapter() as unknown as {
      connection: { port?: number }
    }).connection.port).toBeUndefined()

    expect(() => resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            host: 'localhost',
            port: 5432 } } } })).toThrow('must declare a database driver when using host, port, username, password, or ssl settings')
  })
})
