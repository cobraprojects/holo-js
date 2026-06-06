import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DriverAdapter } from '@holo-js/db'
import { createPostgresAdapter } from '../src'

const runLivePostgres = process.env.HOLO_POSTGRES_INTEGRATION === '1' ? it : it.skip

describe('@holo-js/db-postgres', () => {
  it('creates the configured database when explicitly ensured', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('select 1 from pg_database') ? [] : [{ ok: 1 }],
      rowCount: sql.startsWith('select 1 from pg_database') ? 0 : 1,
    }))
    const bootstrapEnd = vi.fn(async () => {})
    const applicationQuery = vi.fn(async () => ({
      rows: [{ ok: 1 }],
      rowCount: 1,
    }))
    const applicationEnd = vi.fn(async () => {})
    const createPool = vi.fn((config) => {
      if (config?.database === 'fresh_app') {
        return {
          query: applicationQuery,
          connect: vi.fn(),
          end: applicationEnd,
        }
      }

      return {
        query: bootstrapQuery,
        connect: vi.fn(),
        end: bootstrapEnd,
      }
    })
    const adapter = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'fresh_app',
      },
      createPool,
    })

    await adapter.ensureDatabaseExists()
    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ ok: 1 }],
      rowCount: 1,
    })

    expect(createPool).toHaveBeenNthCalledWith(1, {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'postgres',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'fresh_app',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(1, 'select 1 from pg_database where datname = $1', ['fresh_app'])
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'create database "fresh_app"')
    expect(bootstrapEnd).toHaveBeenCalledTimes(1)
    expect(applicationQuery).toHaveBeenCalledWith('select 1', [])
  })

  it('escapes configured database names during bootstrap', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('select 1 from pg_database') ? [] : [{ ok: 1 }],
      rowCount: sql.startsWith('select 1 from pg_database') ? 0 : 1,
    }))
    const createPool = vi.fn((config) => {
      if (config?.database === 'tenant"prod') {
        return {
          query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
          connect: vi.fn(),
          end: vi.fn(async () => {}),
        }
      }

      return {
        query: bootstrapQuery,
        connect: vi.fn(),
        end: vi.fn(async () => {}),
      }
    })
    const adapter = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        database: 'tenant"prod',
      },
      createPool,
    })

    await adapter.ensureDatabaseExists()

    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'create database "tenant""prod"')
  })

  it('creates databases from connection strings when explicitly ensured', async () => {
    const bootstrapQuery = vi.fn(async (sql: string) => ({
      rows: sql.startsWith('select 1 from pg_database') ? [] : [{ ok: 1 }],
      rowCount: sql.startsWith('select 1 from pg_database') ? 0 : 1,
    }))
    const createPool = vi.fn((config) => {
      if (config?.connectionString?.includes('/fresh_app')) {
        return {
          query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
          connect: vi.fn(),
          end: vi.fn(async () => {}),
        }
      }

      return {
        query: bootstrapQuery,
        connect: vi.fn(),
        end: vi.fn(async () => {}),
      }
    })
    const adapter = createPostgresAdapter({
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/fresh_app?sslmode=disable',
      createPool,
    })

    await adapter.ensureDatabaseExists()
    await adapter.initialize()

    expect(createPool).toHaveBeenNthCalledWith(1, {
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/postgres?sslmode=disable',
    })
    expect(createPool).toHaveBeenNthCalledWith(2, {
      connectionString: 'postgres://postgres:secret@127.0.0.1:5432/fresh_app?sslmode=disable',
    })
    expect(bootstrapQuery).toHaveBeenNthCalledWith(1, 'select 1 from pg_database where datname = $1', ['fresh_app'])
    expect(bootstrapQuery).toHaveBeenNthCalledWith(2, 'create database "fresh_app"')
  })

  it('initializes without checking whether a Postgres database already exists', async () => {
    const applicationQuery = vi.fn(async () => ({
      rows: [{ '?column?': 1 }],
      rowCount: 1,
    }))
    const bootstrapQuery = vi.fn(async () => ({
      rows: [{ '?column?': 1 }],
      rowCount: 1,
    }))
    const createPool = vi.fn((config) => ({
      query: config?.database === 'existing_app' ? applicationQuery : bootstrapQuery,
      connect: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createPostgresAdapter({
      config: {
        database: 'existing_app',
      },
      createPool,
    })

    await adapter.initialize()

    expect(createPool).toHaveBeenCalledTimes(1)
    expect(applicationQuery).not.toHaveBeenCalled()
    expect(bootstrapQuery).not.toHaveBeenCalled()
  })

  it('reports Postgres database bootstrap failures with the configured database name', async () => {
    const createPool = vi.fn(() => ({
      query: vi.fn(async () => {
        throw new Error('permission denied')
      }),
      connect: vi.fn(),
      end: vi.fn(async () => {}),
    }))
    const adapter = createPostgresAdapter({
      config: {
        database: 'private_app',
      },
      createPool,
    })

    await expect(adapter.ensureDatabaseExists()).rejects.toThrow(
      'Postgres database "private_app" could not be found or created. Please create the database and try again. Original error: permission denied',
    )
  })

  it('supports direct clients without creating a pool', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'insert into logs values ($1) returning id') {
        return {
          rows: [{ id: 9 }],
          rowCount: 1,
        }
      }

      return {
        rows: [{ sql }],
        rowCount: 1,
      }
    })
    const adapter = createPostgresAdapter({
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
    await expect(adapter.execute('insert into logs values ($1) returning id', ['value'])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 9,
    })

    await adapter.beginTransaction()
    await adapter.commit()
    expect(query).toHaveBeenNthCalledWith(3, 'BEGIN')
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT')
    void canonicalAdapter
  })

  runLivePostgres('runs queries against a local Postgres server through the public adapter', async () => {
    const tableName = `holo_real_usage_postgres_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'postgres',
      },
    })

    try {
      await adapter.execute(`create table ${tableName} (id serial primary key, name text not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values ($1) returning id`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = $1`,
        [inserted.lastInsertId],
      )

      expect(inserted.affectedRows).toBe(1)
      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.execute(`drop table if exists ${tableName}`)
      await adapter.disconnect()
    }
  }, 30_000)

  runLivePostgres('creates a missing configured database against a real Postgres server', async () => {
    const databaseName = `holo_real_usage_postgres_${randomUUID().replaceAll('-', '_')}`
    const tableName = 'users'
    const admin = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'postgres',
      },
    })
    const adapter = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: databaseName,
      },
    })

    try {
      await admin.execute(`drop database if exists "${databaseName}"`)
      await adapter.ensureDatabaseExists()
      await adapter.execute(`create table ${tableName} (id serial primary key, name text not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values ($1) returning id`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = $1`,
        [inserted.lastInsertId],
      )

      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`drop database if exists "${databaseName}"`)
      await admin.disconnect()
    }
  }, 30_000)
})
