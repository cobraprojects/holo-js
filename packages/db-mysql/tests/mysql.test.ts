import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  createDatabase,
  createDialect,
  createMigrationService,
  defineMigration,
  type DriverAdapter,
} from '@holo-js/db'
import { createMySQLAdapter } from '../src'

const runLiveMySql = process.env.HOLO_MYSQL_INTEGRATION === '1' ? it : it.skip

describe('@holo-js/db-mysql', () => {
  it('creates the configured database before opening the application pool', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => [
      sql.startsWith('SELECT SCHEMA_NAME') ? [] : { affectedRows: 1 },
      undefined,
    ] as const)
    const bootstrapEnd = vi.fn(async () => {})
    const applicationQuery = vi.fn(async () => [[{ ok: 1 }], undefined] as const)
    const applicationEnd = vi.fn(async () => {})
    const createPool = vi.fn((config) => {
      if ('database' in config) {
        return {
          query: applicationQuery,
          getConnection: vi.fn(),
          end: applicationEnd,
        }
      }

      return {
        query: bootstrapQuery,
        getConnection: vi.fn(),
        end: bootstrapEnd,
      }
    })
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'fresh_app',
      },
      createPool,
    })

    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ ok: 1 }],
      rowCount: 1,
    })

    expect(createPool).toHaveBeenNthCalledWith(1, {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      host: '127.0.0.1',
      port: 3306,
      user: 'root',
      database: 'fresh_app',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      ['fresh_app'],
    )
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'CREATE DATABASE `fresh_app`', [])
    expect(bootstrapEnd).toHaveBeenCalledTimes(1)
    expect(applicationQuery).toHaveBeenCalledWith('select 1', [])
  })

  it('escapes configured database names during bootstrap', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => [
      sql.startsWith('SELECT SCHEMA_NAME') ? [] : { affectedRows: 1 },
      undefined,
    ] as const)
    const createPool = vi.fn((config) => ({
      query: 'database' in config ? vi.fn(async () => [[{ ok: 1 }], undefined] as const) : bootstrapQuery,
      getConnection: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        database: 'tenant`prod',
      },
      createPool,
    })

    await adapter.initialize()

    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'CREATE DATABASE `tenant``prod`', [])
  })

  it('creates databases from connection URIs before opening the application pool', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => [
      sql.startsWith('SELECT SCHEMA_NAME') ? [] : { affectedRows: 1 },
      undefined,
    ] as const)
    const createPool = vi.fn((config) => ({
      query: 'uri' in config && String(config.uri).includes('/fresh_app')
        ? vi.fn(async () => [[{ ok: 1 }], undefined] as const)
        : bootstrapQuery,
      getConnection: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createMySQLAdapter({
      uri: 'mysql://root:secret@127.0.0.1:3306/fresh_app?timezone=Z',
      createPool,
    })

    await adapter.initialize()

    expect(createPool).toHaveBeenNthCalledWith(1, {
      uri: 'mysql://root:secret@127.0.0.1:3306?timezone=Z',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      uri: 'mysql://root:secret@127.0.0.1:3306/fresh_app?timezone=Z',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(
      1,
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      ['fresh_app'],
    )
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'CREATE DATABASE `fresh_app`', [])
  })

  it('does not create a MySQL database when it already exists', async () => {
    const bootstrapQuery = vi.fn(async () => [[{ SCHEMA_NAME: 'existing_app' }], undefined] as const)
    const createPool = vi.fn((config) => ({
      query: 'database' in config ? vi.fn(async () => [[{ ok: 1 }], undefined] as const) : bootstrapQuery,
      getConnection: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createMySQLAdapter({
      config: {
        database: 'existing_app',
      },
      createPool,
    })

    await adapter.initialize()

    expect(bootstrapQuery).toHaveBeenCalledTimes(1)
    expect(bootstrapQuery).toHaveBeenCalledWith(
      'SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?',
      ['existing_app'],
    )
  })

  it('reports MySQL database bootstrap failures with the configured database name', async () => {
    const createPool = vi.fn(() => ({
      query: vi.fn(async () => {
        throw new Error('access denied')
      }),
      getConnection: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createMySQLAdapter({
      config: {
        database: 'private_app',
      },
      createPool,
    })

    await expect(adapter.initialize()).rejects.toThrow(
      'Unable to ensure MySQL database "private_app" exists: access denied',
    )
  })

  it('supports direct clients without creating a pool', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'insert into logs values (?)') {
        return [{
          affectedRows: 1,
          insertId: 13,
        }, undefined] as const
      }

      return [[{ sql }], undefined] as const
    })
    const adapter = createMySQLAdapter({
      client: {
        query,
        end: vi.fn(async () => {}),
      },
    })
    const canonicalAdapter: DriverAdapter = adapter

    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ sql: 'select 1' }],
      rowCount: 1,
    })
    await expect(adapter.execute('insert into logs values (?)', ['value'])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 13,
    })

    await adapter.beginTransaction()
    await adapter.rollback()
    expect(query).toHaveBeenNthCalledWith(3, 'START TRANSACTION', [])
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK', [])
    void canonicalAdapter
  })

  runLiveMySql('runs queries against a local MySQL server through the public adapter', async () => {
    const tableName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })

    try {
      await adapter.execute(`create table ${tableName} (id int auto_increment primary key, name varchar(255) not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values (?)`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = ?`,
        [inserted.lastInsertId],
      )

      expect(inserted.affectedRows).toBe(1)
      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.execute(`drop table if exists ${tableName}`)
      await adapter.disconnect()
    }
  }, 30_000)

  runLiveMySql('creates a missing configured database against a real MySQL server', async () => {
    const databaseName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const tableName = 'users'
    const admin = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: databaseName,
      },
    })

    try {
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await adapter.execute(`create table ${tableName} (id int auto_increment primary key, name varchar(255) not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values (?)`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = ?`,
        [inserted.lastInsertId],
      )

      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await admin.disconnect()
    }
  }, 30_000)

  runLiveMySql('runs migration tracking against a real MySQL server', async () => {
    const databaseName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const migration = defineMigration({
      name: '2026_05_31_000001_create_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
          table.string('email')
          table.timestamp('created_at').nullable()
        })
      },
      async down({ schema }) {
        await schema.dropTable('users')
      },
    })
    const admin = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: databaseName,
      },
    })
    const db = createDatabase({
      connectionName: 'main',
      adapter,
      dialect: createDialect('mysql'),
    })
    const migrator = createMigrationService(db, [migration])

    try {
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await expect(migrator.migrate()).resolves.toEqual([migration])

      const tracked = await adapter.query<{ name: string }>(
        'select name from `_holo_migrations` where name = ?',
        [migration.name],
      )

      expect(tracked.rows).toEqual([{ name: migration.name }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists \`${databaseName}\``)
      await admin.disconnect()
    }
  }, 30_000)
})
