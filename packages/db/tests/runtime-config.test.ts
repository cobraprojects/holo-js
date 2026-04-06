import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_HOLO_PROJECT_PATHS,
  MySQLAdapter,
  PostgresAdapter,
  SQLiteAdapter,
  createAdapter,
  createDialect,
  createRuntimeConnectionOptions,
  createRuntimeLogger,
  defineHoloProject,
  isSupportedDatabaseDriver,
  normalizeHoloProjectConfig,
  parseDatabaseDriver,
  resolveRuntimeConnectionManagerOptions } from '../src'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runtime config helpers', () => {
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
    expect(createAdapter('postgres', 'postgres://localhost/app')).toBeInstanceOf(PostgresAdapter)
    expect(createAdapter('postgres', {
      host: 'localhost',
      port: 5432,
      username: 'holo',
      password: 'secret',
      database: 'app',
      ssl: { rejectUnauthorized: false } })).toBeInstanceOf(PostgresAdapter)

    expect(createAdapter('mysql', 'mysql://localhost/app')).toBeInstanceOf(MySQLAdapter)
    expect(createAdapter('mysql', {
      host: 'localhost',
      port: 3306,
      username: 'holo',
      password: 'secret',
      database: 'app',
      ssl: true })).toBeInstanceOf(MySQLAdapter)
    expect(createAdapter('mysql', {
      host: 'localhost',
      database: 'app' })).toBeInstanceOf(MySQLAdapter)

    expect(createAdapter('sqlite', './data.sqlite')).toBeInstanceOf(SQLiteAdapter)
    expect(createAdapter('sqlite', { database: ':memory:' })).toBeInstanceOf(SQLiteAdapter)
    expect(createAdapter('sqlite', {})).toBeInstanceOf(SQLiteAdapter)
    expect(() => createAdapter('oracle' as never, './db.sqlite')).toThrow('Unsupported Holo database driver "oracle"')

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

  it('creates runtime loggers only when enabled and formats log output', () => {
    expect(createRuntimeLogger(false)).toBeUndefined()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createRuntimeLogger(true)
    expect(logger).toBeDefined()

    logger!.onQuerySuccess!({
      kind: 'query',
      connectionName: 'default',
      scope: 'root',
      durationMs: 4,
      sql: 'select 1',
      bindings: [],
      rowCount: 2 })
    logger!.onQuerySuccess!({
      kind: 'execute',
      connectionName: 'default',
      scope: 'root',
      durationMs: 5,
      sql: 'delete from users',
      bindings: [],
      affectedRows: 3 })
    logger!.onQuerySuccess!({
      kind: 'query',
      connectionName: 'default',
      scope: 'root',
      durationMs: 7,
      sql: 'select now()',
      bindings: [] })
    logger!.onQueryError!({
      kind: 'query',
      connectionName: 'default',
      scope: 'root',
      durationMs: 6,
      sql: 'select 1',
      bindings: [],
      error: new Error('boom') })
    logger!.onQueryError!({
      kind: 'query',
      connectionName: 'default',
      scope: 'root',
      durationMs: 8,
      sql: 'select broken()',
      bindings: [],
      error: 'bad query' })
    logger!.onTransactionStart!({
      scope: 'transaction',
      depth: 1,
      savepointName: 'sp_1' })
    logger!.onTransactionStart!({
      scope: 'transaction',
      depth: 1 })
    logger!.onTransactionCommit!({
      scope: 'transaction',
      depth: 1 })
    logger!.onTransactionCommit!({
      scope: 'savepoint',
      depth: 2,
      savepointName: 'sp_2' })
    logger!.onTransactionRollback!({
      scope: 'savepoint',
      depth: 2,
      savepointName: 'sp_2',
      error: 'rollback failed' })
    logger!.onTransactionRollback!({
      scope: 'transaction',
      depth: 1,
      error: new Error('tx boom') })
    logger!.onTransactionRollback!({
      scope: 'transaction',
      depth: 1 })

    expect(warnSpy).toHaveBeenCalledWith('[holo:db] query ok connection=default scope=root duration=4ms rows=2 sql=select 1')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] execute ok connection=default scope=root duration=5ms affected=3 sql=delete from users')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] query ok connection=default scope=root duration=7ms sql=select now()')
    expect(errorSpy).toHaveBeenCalledWith('[holo:db] query error connection=default scope=root duration=6ms sql=select 1 error=boom')
    expect(errorSpy).toHaveBeenCalledWith('[holo:db] query error connection=default scope=root duration=8ms sql=select broken() error=bad query')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction start scope=transaction depth=1 savepoint=sp_1')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction start scope=transaction depth=1')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction commit scope=transaction depth=1')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction commit scope=savepoint depth=2 savepoint=sp_2')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction rollback scope=savepoint depth=2 savepoint=sp_2 error=rollback failed')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction rollback scope=transaction depth=1 error=tx boom')
    expect(warnSpy).toHaveBeenCalledWith('[holo:db] transaction rollback scope=transaction depth=1')
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
    expect((manager.connection().getAdapter() as unknown as { filename: string }).filename).toBe('./manifest.sqlite')
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
      config: { port?: number }
    }).config.port).toBe(5432)

    expect(() => resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            host: 'localhost',
            port: 5432 } } } })).toThrow('must declare a database driver when using host, port, username, password, or ssl settings')
  })
})
