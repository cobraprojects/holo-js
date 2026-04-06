import { describe, expect, it, vi } from 'vitest'
import {
  createAdapter,
  createDialect,
  createRuntimeConnectionOptions,
  createRuntimeLogger,
  isSupportedDatabaseDriver,
  parseDatabaseDriver,
  resolveRuntimeConnectionManagerOptions,
} from '../src/portable/dbRuntime'

type AdapterHarness = {
  config?: Record<string, unknown>
}

describe('core db runtime bootstrap', () => {
  it('does not create a logger or log security override when db logging is disabled', () => {
    const options = createRuntimeConnectionOptions('sqlite', './data.sqlite', false)

    expect(options.logger).toBeUndefined()
    expect(options.security).toBeUndefined()
  })

  it('creates a logger and enables visible SQL/bindings when db logging is enabled', () => {
    const options = createRuntimeConnectionOptions('sqlite', './data.sqlite', true)

    expect(options.logger).toBeDefined()
    expect(options.security).toEqual({
      debugSqlInLogs: true,
      redactBindingsInLogs: false,
    })
  })

  it('propagates an optional schema name into runtime connection options', () => {
    const options = createRuntimeConnectionOptions('mysql', 'mysql://db', false, 'analytics')

    expect(options.schemaName).toBe('analytics')
  })

  it('creates Postgres runtime adapters from structured credentials when no URL is provided', () => {
    const options = createRuntimeConnectionOptions('postgres', {
      host: 'db.internal',
      port: 5432,
      username: 'app',
      password: 'secret',
      database: 'primary',
      ssl: true,
    }, false, 'public', 'primary')

    const adapter = options.adapter as unknown as AdapterHarness

    expect(adapter.config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      user: 'app',
      password: 'secret',
      database: 'primary',
      ssl: true,
    })
  })

  it('resolves documented multi-connection runtime config shapes', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        defaultConnection: 'analytics',
        connections: {
          primary: {
            driver: 'sqlite',
            database: './storage/app.sqlite',
          },
          analytics: {
            driver: 'postgres',
            url: 'postgresql://analytics',
            schema: 'warehouse',
            logging: true,
          },
        },
      },
    })

    expect(options.getDefaultConnectionName()).toBe('analytics')
    expect(options.getConnectionNames()).toEqual(['primary', 'analytics'])
    expect(options.connection('primary').getDriver()).toBe('sqlite')
    expect(options.connection('primary').getSchemaName()).toBeUndefined()
    expect(options.connection('analytics').getDriver()).toBe('postgres')
    expect(options.connection('analytics').getSchemaName()).toBe('warehouse')
    expect(options.connection('analytics').getLogger()).toBeDefined()
  })

  it('uses the sole named connection as default when no explicit default is configured', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          analytics: {
            driver: 'postgres',
            url: 'postgresql://analytics',
          },
        },
      },
    })

    expect(options.getDefaultConnectionName()).toBe('analytics')
    expect(options.getConnectionNames()).toEqual(['analytics'])
  })

  it('resolves structured credential fields for named network connections', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        defaultConnection: 'primary',
        connections: {
          primary: {
            driver: 'postgres',
            host: 'db.internal',
            port: 5432,
            username: 'app',
            password: 'secret',
            database: 'primary',
            ssl: true,
          },
          analytics: {
            driver: 'mysql',
            host: 'mysql.internal',
            port: '3306',
            username: 'reporter',
            password: 'top-secret',
            database: 'analytics',
            schema: 'warehouse',
          },
        },
      },
    })

    const primaryAdapter = options.connection('primary').getAdapter() as unknown as AdapterHarness
    const analyticsAdapter = options.connection('analytics').getAdapter() as unknown as AdapterHarness

    expect(options.connection('primary').getDriver()).toBe('postgres')
    expect(primaryAdapter.config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      user: 'app',
      password: 'secret',
      database: 'primary',
      ssl: true,
    })
    expect(options.connection('analytics').getDriver()).toBe('mysql')
    expect(options.connection('analytics').getSchemaName()).toBe('warehouse')
    expect(analyticsAdapter.config).toMatchObject({
      host: 'mysql.internal',
      port: 3306,
      user: 'reporter',
      password: 'top-secret',
      database: 'analytics',
    })
  })

  it('falls back to sqlite defaults when no connection map exists', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      holo: {},
    })

    expect(options.getDefaultConnectionName()).toBe('default')
    expect(options.getConnectionNames()).toEqual(['default'])
    expect(options.connection().getDriver()).toBe('sqlite')
    expect(options.connection().getSchemaName()).toBeUndefined()
    expect(options.connection().getLogger()).toBeUndefined()
  })

  it('supports canonical structured credential fields without a URL', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: {
            driver: 'postgres',
            host: 'db.internal',
            port: '5432',
            username: 'app',
            password: 'secret',
            database: 'primary',
            ssl: true,
            schema: 'public',
          },
        },
      },
    })

    const adapter = options.connection().getAdapter() as unknown as AdapterHarness

    expect(options.connection().getDriver()).toBe('postgres')
    expect(options.connection().getSchemaName()).toBe('public')
    expect(adapter.config).toMatchObject({
      host: 'db.internal',
      port: 5432,
      user: 'app',
      password: 'secret',
      database: 'primary',
      ssl: true,
    })
  })

  it('requires an explicit driver when using host-style connection fields', () => {
    expect(() => resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          primary: {
            host: 'db.internal',
            username: 'app',
            password: 'secret',
            database: 'primary',
          },
        },
      },
    })).toThrow('must declare a database driver when using host, port, username, password, or ssl settings')
  })

  it('marks Postgres and MySQL runtime dialects as alter-capable', () => {
    expect(createDialect('sqlite').capabilities.ddlAlterSupport).toBe(false)
    expect(createDialect('postgres').capabilities.ddlAlterSupport).toBe(true)
    expect(createDialect('mysql').capabilities.ddlAlterSupport).toBe(true)
  })

  it('logs query and transaction lifecycle events when enabled', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createRuntimeLogger(true)

    expect(logger).toBeDefined()

    logger?.onQuerySuccess?.({
      kind: 'query',
      connectionName: 'default',
      sql: 'select * from "users"',
      bindings: ['ops@example.com'],
      scope: 'root',
      durationMs: 12,
      rowCount: 2,
    })

    logger?.onQueryError?.({
      kind: 'execute',
      connectionName: 'default',
      sql: 'delete from "users"',
      bindings: [],
      scope: 'transaction',
      durationMs: 7,
      error: new Error('boom'),
    })

    logger?.onTransactionStart?.({
      scope: 'transaction',
      depth: 1,
    })

    logger?.onTransactionCommit?.({
      scope: 'savepoint',
      depth: 2,
      savepointName: 'sp_1',
    })

    logger?.onTransactionRollback?.({
      scope: 'savepoint',
      depth: 2,
      savepointName: 'sp_2',
      error: new Error('rollback'),
    })

    expect(warn).toHaveBeenCalledTimes(4)
    expect(error).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[holo:db] query ok connection=default')
    expect(warn.mock.calls[0]?.[0]).toContain('sql=select * from "users"')
    expect(error.mock.calls[0]?.[0]).toContain('[holo:db] execute error connection=default')
    expect(warn.mock.calls[3]?.[0]).toContain('transaction rollback')

    warn.mockRestore()
    error.mockRestore()
  })

  it('returns no runtime logger when disabled', () => {
    expect(createRuntimeLogger(false)).toBeUndefined()
  })

  it('covers driver parsing helpers and adapter factories', () => {
    expect(isSupportedDatabaseDriver('sqlite')).toBe(true)
    expect(isSupportedDatabaseDriver('mongo')).toBe(false)
    expect(parseDatabaseDriver(undefined, 'mysql')).toBe('mysql')
    expect(parseDatabaseDriver('postgres', 'sqlite')).toBe('postgres')
    expect(() => parseDatabaseDriver('mongo', 'sqlite')).toThrow('Unsupported Holo database driver')

    expect(createAdapter('postgres', 'postgresql://db.internal/app')).toBeDefined()
    expect(createAdapter('postgres', {
      host: 'db.internal',
      port: 5432,
      username: 'app',
      password: 'secret',
      database: 'primary',
      ssl: { rejectUnauthorized: false },
    })).toBeDefined()

    expect(createAdapter('mysql', 'mysql://db.internal/app')).toBeDefined()
    expect(createAdapter('mysql', {
      host: 'db.internal',
      port: 3306,
      username: 'app',
      password: 'secret',
      database: 'primary',
    })).toBeDefined()

    expect(createAdapter('sqlite', { database: './data/app.sqlite' })).toBeDefined()
    expect(() => createAdapter('mongo' as never, 'mongodb://db')).toThrow('Unsupported Holo database driver')
    expect(createDialect('sqlite').createPlaceholder(3)).toBe('?')
  })

  it('covers remaining runtime logger branches', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logger = createRuntimeLogger(true)

    logger?.onQuerySuccess?.({
      kind: 'query',
      connectionName: 'analytics',
      sql: 'update "users" set "name" = ?',
      bindings: [],
      scope: 'root',
      durationMs: 4,
      affectedRows: 3,
    })

    logger?.onTransactionStart?.({
      scope: 'transaction',
      depth: 1,
      savepointName: 'sp_1',
    })

    logger?.onTransactionCommit?.({
      scope: 'transaction',
      depth: 1,
    })

    logger?.onTransactionRollback?.({
      scope: 'transaction',
      depth: 1,
      error: 'forced rollback',
    })

    logger?.onQuerySuccess?.({
      kind: 'query',
      connectionName: 'analytics',
      sql: 'select 1',
      bindings: [],
      scope: 'root',
      durationMs: 1,
    })

    expect(warn.mock.calls[0]?.[0]).toContain('affected=3')
    expect(warn.mock.calls[1]?.[0]).toContain('savepoint=sp_1')
    expect(warn.mock.calls[2]?.[0]).toContain('transaction commit')
    expect(warn.mock.calls[3]?.[0]).toContain('error=forced rollback')
    expect(warn.mock.calls[4]?.[0]).toContain('duration=1ms sql=select 1')

    warn.mockRestore()
  })

  it('falls back to sqlite defaults when no runtime config is provided', () => {
    const options = resolveRuntimeConnectionManagerOptions({})

    expect(options.getDefaultConnectionName()).toBe('default')
    expect(options.connection().getDriver()).toBe('sqlite')
  })

  it('normalizes undefined connection entries as empty configs', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: undefined as never,
        },
      },
    })

    expect(options.getDefaultConnectionName()).toBe('default')
    expect(options.connection().getDriver()).toBe('sqlite')
  })

  it('supports sqlite filename and invalid port fallbacks in named connections', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        defaultConnection: 'local',
        connections: {
          local: {
            filename: './data/local.sqlite',
            port: 'not-a-port',
            logging: true,
          },
        },
      },
    })

    expect(options.getDefaultConnectionName()).toBe('local')
    expect(options.connection('local').getDriver()).toBe('sqlite')
    expect(options.connection('local').getLogger()).toBeDefined()
  })

  it('infers drivers from string connection inputs and default connection names', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          default: 'mysql://default.internal/app',
          analytics: 'postgresql://analytics.internal/app',
        },
      },
    })

    expect(options.getDefaultConnectionName()).toBe('default')
    expect(options.connection('default').getDriver()).toBe('mysql')
    expect(options.connection('analytics').getDriver()).toBe('postgres')
  })

  it('infers sqlite drivers from filesystem-style urls', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          absolute: '/tmp/app.db',
          filedb: 'file:./data/app.sqlite',
          memory: ':memory:',
          relative: '../data/app.sqlite3',
          sqlite: './data/app.sqlite',
        },
      },
    })

    expect(options.connection('absolute').getDriver()).toBe('sqlite')
    expect(options.connection('filedb').getDriver()).toBe('sqlite')
    expect(options.connection('memory').getDriver()).toBe('sqlite')
    expect(options.connection('relative').getDriver()).toBe('sqlite')
    expect(options.connection('sqlite').getDriver()).toBe('sqlite')
  })

  it('falls back to the default runtime driver when a url does not imply one', () => {
    const options = resolveRuntimeConnectionManagerOptions({
      db: {
        connections: {
          unknown: 'https://example.test/not-a-db-url',
        },
      },
    })

    expect(options.connection('unknown').getDriver()).toBe('sqlite')
  })

  it('covers adapter fallbacks and logger string branches', () => {
    expect(createAdapter('mysql', {
      host: 'db.internal',
      port: 3306,
      username: 'app',
      password: 'secret',
      database: 'primary',
      ssl: true,
    })).toBeDefined()
    expect(createAdapter('sqlite', {})).toBeDefined()
    expect(createDialect('postgres').quoteIdentifier('users.email')).toBe('"users"."email"')
    expect(createDialect('postgres').createPlaceholder(2)).toBe('$2')
    expect(createDialect('mysql').quoteIdentifier('users.email')).toBe('`users`.`email`')
    expect(createDialect('mysql').createPlaceholder(9)).toBe('?')
    expect(createDialect('sqlite').quoteIdentifier('users')).toBe('"users"')

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createRuntimeLogger(true)

    logger?.onQueryError?.({
      kind: 'query',
      connectionName: 'default',
      sql: 'select 1',
      bindings: [],
      scope: 'root',
      durationMs: 1,
      error: 'boom',
    })

    logger?.onTransactionRollback?.({
      scope: 'transaction',
      depth: 1,
    })

    expect(error.mock.calls[0]?.[0]).toContain('error=boom')
    expect(warn.mock.calls[0]?.[0]).toContain('transaction rollback scope=transaction depth=1')

    warn.mockRestore()
    error.mockRestore()
  })
})
