import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  column, configureDB, createConnectionManager, createDialect, defineGeneratedTable,
  defineModel, resetDB,
} from '@holo-js/db'
import { createPostgresAdapter } from '../src'

const livePostgresConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: 'postgres',
  database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
}

describe('@holo-js/db-postgres', () => {
  it('connects to the selected integration database', async () => {
    const adapter = createPostgresAdapter({ config: livePostgresConfig })
    try {
      const result = await adapter.query<{ database: string }>('SELECT current_database() AS database')
      expect(result.rows).toEqual([{ database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres' }])
    } finally {
      await adapter.disconnect()
    }
  }, 30_000)

  it.each(['config', 'url'] as const)('creates and reopens a quoted database name through %s configuration', async mode => {
    const database = `holo_quoted_${randomUUID().replaceAll('-', '')}"tenant`
    const admin = createPostgresAdapter({ config: livePostgresConfig })
    const adapter = createPostgresAdapter(mode === 'config'
      ? { config: { ...livePostgresConfig, database } }
      : { connectionString: `postgresql://${livePostgresConfig.user}@${livePostgresConfig.host}:${livePostgresConfig.port}/${encodeURIComponent(database)}` })
    try {
      await adapter.ensureDatabaseExists()
      await adapter.ensureDatabaseExists()
      expect((await adapter.query('SELECT current_database() AS database')).rows).toEqual([{ database }])
      await adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
      expect((await adapter.query('SELECT 1 AS value')).rows).toEqual([{ value: 1 }])
    } finally {
      await adapter.disconnect()
      await admin.execute(`DROP DATABASE IF EXISTS "${database.replaceAll('"', '""')}"`)
      await admin.disconnect()
    }
  }, 30_000)

  it('reports real database creation permission failures', async () => {
    const role = `holo_denied_${randomUUID().replaceAll('-', '')}`
    const password = randomUUID()
    const admin = createPostgresAdapter({ config: livePostgresConfig })
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, user: role, password, database: role } })
    try {
      await admin.execute(`CREATE ROLE ${role} LOGIN NOCREATEDB PASSWORD '${password}'`)
      await expect(adapter.ensureDatabaseExists()).rejects.toThrow(`Postgres database "${role}" could not be found or created`)
    } finally {
      await adapter.disconnect()
      await admin.execute(`DROP ROLE IF EXISTS ${role}`)
      await admin.disconnect()
    }
  }, 30_000)

  it('uses a real injected client for bound writes, commit, and rollback', async () => {
    const client = new Client(livePostgresConfig)
    await client.connect()
    const adapter = createPostgresAdapter({ client })
    try {
      await adapter.execute('CREATE TEMP TABLE direct_records (id SERIAL PRIMARY KEY, value TEXT NOT NULL)')
      await adapter.beginTransaction()
      const inserted = await adapter.execute('INSERT INTO direct_records (value) VALUES ($1) RETURNING id', ["a'; DROP TABLE direct_records; --"])
      await adapter.commit()
      expect(inserted.affectedRows).toBe(1)
      expect((await adapter.query('SELECT value FROM direct_records WHERE id = $1', [inserted.lastInsertId])).rows)
        .toEqual([{ value: "a'; DROP TABLE direct_records; --" }])
      await adapter.beginTransaction()
      await adapter.execute('DELETE FROM direct_records')
      await adapter.rollback()
      expect((await adapter.query('SELECT count(*)::int AS count FROM direct_records')).rows).toEqual([{ count: 1 }])
    } finally {
      await adapter.disconnect()
    }
  }, 30_000)

  it('returns the final statement result from real multi-statement execution and queries', async () => {
    const adapter = createPostgresAdapter({ config: livePostgresConfig })
    try {
      expect(await adapter.execute('SELECT 1; SELECT 2;')).toEqual({ affectedRows: 1, lastInsertId: 2 })
      expect(await adapter.query('SELECT 1 AS value; SELECT 2 AS value;')).toEqual({ rows: [{ value: 2 }], rowCount: 1 })
      await expect(adapter.execute('SELECT 1; SELECT missing_column; SELECT 2;')).rejects.toThrow('missing_column')
      expect((await adapter.query('SELECT 3 AS value')).rows).toEqual([{ value: 3 }])
    } finally {
      await adapter.disconnect()
    }
  }, 30_000)

  it('hydrates numeric schema columns without losing integer precision', async () => {
    const tableName = `holo_numeric_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({ config: livePostgresConfig })
    const Item = defineModel(defineGeneratedTable(tableName, {
      id: column.id(),
      quantity: column.bigInteger(),
      label: column.string(),
    }), { timestamps: false })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))
    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id BIGSERIAL PRIMARY KEY, quantity BIGINT NOT NULL, label TEXT NOT NULL)`)
      await adapter.execute(`INSERT INTO ${tableName} (quantity, label) VALUES (9007199254740991, '001')`)
      expect((await Item.first())?.toAttributes()).toEqual({ id: 1, quantity: 9007199254740991, label: '001' })
      await adapter.execute(`INSERT INTO ${tableName} (quantity, label) VALUES (9007199254740993, 'unsafe')`)
      await expect(Item.where('label', 'unsafe').first()).rejects.toThrow('safe integer')
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
      resetDB()
    }
  }, 30_000)

  it('chunks grouped projections without selecting the primary key', async () => {
    const tableName = `holo_grouped_chunks_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({
      config: livePostgresConfig,
    })
    const Item = defineModel(defineGeneratedTable(tableName, { id: column.id(), active: column.boolean() }), { timestamps: false })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))

    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, active BOOLEAN NOT NULL)`)
      await adapter.execute(`INSERT INTO ${tableName} VALUES (1, true), (2, false), (3, true)`)
      const batches: boolean[][] = []
      await Item.select('active').groupBy('active').orderBy('active')
        .chunkById(1, records => { batches.push(records.map(record => record.get('active'))) })
      expect(batches).toEqual([[false], [true]])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
      resetDB()
    }
  }, 30_000)

  it.each((['union', 'unionAll'] as const).flatMap(operation => [
    { operation, selection: 'id' as const, attribute: 'id' },
    { operation, selection: 'id as other' as const, attribute: 'other' },
  ]))('chunks $operation model results selecting $selection in ascending ID order', async ({ operation, selection, attribute }) => {
    const tableName = `holo_union_chunks_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({
      config: livePostgresConfig,
    })
    const Item = defineModel(defineGeneratedTable(tableName, { id: column.id() }), { timestamps: false })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))

    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY)`)
      await adapter.execute(`INSERT INTO ${tableName} VALUES (4), (2), (3), (1)`)
      const batches: Array<Array<Record<string, unknown>>> = []
      const query = Item.select(selection).where('id', '<', 3)
      await query[operation](Item.select(selection).where('id', '>=', 3))
        .chunkById(2, records => { batches.push(records.map(record => record.toAttributes())) })
      expect(batches).toEqual([[{ [attribute]: 1 }, { [attribute]: 2 }], [{ [attribute]: 3 }, { [attribute]: 4 }]])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await adapter.disconnect()
      resetDB()
    }
  }, 30_000)

  it('runs queries against a local Postgres server through the public adapter', async () => {
    const tableName = `holo_real_usage_postgres_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({
      config: livePostgresConfig,
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

  it('creates a missing configured database against a real Postgres server', async () => {
    const databaseName = `holo_real_usage_postgres_${randomUUID().replaceAll('-', '_')}`
    const tableName = 'users'
    const admin = createPostgresAdapter({
      config: livePostgresConfig,
    })
    const adapter = createPostgresAdapter({
      config: {
        ...livePostgresConfig,
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
