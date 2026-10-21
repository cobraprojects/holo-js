import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { Client, types as pgTypes } from 'pg'
import { describe, expect, it } from 'vitest'
import {
  column, configureDB, createConnectionManager, createDialect, defineGeneratedTable,
  createDatabase, defineModel, latestOfMany, resetDB,
  type Entity, type TableDefinition,
} from '@holo-js/db'
import { createPostgresAdapter } from '../src'

const livePostgresConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: 'postgres',
  database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('@holo-js/db-postgres', () => {
  it.each([1, 4, 8])('completes overlapping transactions and ordinary queries with a four-client pool and %i admission slots', async maxConcurrentQueries => {
    const adapter = createPostgresAdapter({ config: {
      ...livePostgresConfig, max: 4, connectionTimeoutMillis: 500, idleTimeoutMillis: 30_000,
    } })
    const db = createDatabase({
      adapter, dialect: createDialect('postgres'),
      concurrency: { maxConcurrentQueries, queueLimit: 128, workerThreads: false },
    })
    const tableName = `holo_admission_${randomUUID().replaceAll('-', '')}`
    let notifyReady = () => {}
    let release = () => {}
    const ready = new Promise<void>(resolve => { notifyReady = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    let entered = 0
    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY)`)
      const transactions = Array.from({ length: 21 }, (_, id) => db.transaction(async tx => {
        entered += 1
        if (entered === Math.min(4, maxConcurrentQueries)) notifyReady()
        await proceed
        await tx.executeCompiled({ sql: `INSERT INTO ${tableName} VALUES ($1)`, bindings: [id] })
        expect((await tx.queryCompiled({ sql: `SELECT id FROM ${tableName} WHERE id = $1`, bindings: [id] })).rows)
          .toEqual([{ id }])
      }))
      const settledTransactions = Promise.allSettled(transactions)
      await ready
      const queries = Promise.allSettled(Array.from({ length: 4 }, () => db.queryCompiled({ sql: 'SELECT 1 AS value', bindings: [] })))
      await setTimeout(20)
      release()
      expect(await settledTransactions).toEqual(Array.from({ length: 21 }, () => ({ status: 'fulfilled', value: undefined })))
      expect(await queries).toEqual(Array.from({ length: 4 }, () => ({ status: 'fulfilled', value: { rows: [{ value: 1 }], rowCount: 1 } })))
      expect((await db.queryCompiled({ sql: `SELECT count(*)::int AS count FROM ${tableName}`, bindings: [] })).rows)
        .toEqual([{ count: 21 }])
    } finally {
      release()
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await db.disconnect()
    }
  }, 10_000)

  it('applies shared admission backpressure to transactions and releases capacity after rollback', async () => {
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 4, connectionTimeoutMillis: 500 } })
    const db = createDatabase({
      adapter, dialect: createDialect('postgres'),
      concurrency: { maxConcurrentQueries: 1, queueLimit: 0 },
    })
    let notifyReady = () => {}
    let release = () => {}
    const ready = new Promise<void>(resolve => { notifyReady = resolve })
    const proceed = new Promise<void>(resolve => { release = resolve })
    try {
      const running = db.transaction(async tx => {
        notifyReady()
        await proceed
        await tx.transaction(nested => nested.queryCompiled({ sql: 'SELECT 1', bindings: [] }))
        throw new Error('abort')
      })
      const rejected = expect(running).rejects.toThrow('abort')
      await ready
      await expect(db.transaction(tx => tx.queryCompiled({ sql: 'SELECT 1', bindings: [] })))
        .rejects.toMatchObject({ code: 'QUERY_SCHEDULER_BACKPRESSURE' })
      await expect(db.queryCompiled({ sql: 'SELECT 1', bindings: [] }))
        .rejects.toMatchObject({ code: 'QUERY_SCHEDULER_BACKPRESSURE' })
      release()
      await rejected
      expect((await db.transaction(tx => tx.queryCompiled({ sql: 'SELECT 2 AS value', bindings: [] }))).rows)
        .toEqual([{ value: 2 }])
      expect((await db.queryCompiled({ sql: 'SELECT 3 AS value', bindings: [] })).rows).toEqual([{ value: 3 }])
    } finally {
      release()
      await db.disconnect()
    }
  })

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

  it.each(['lockForUpdate', 'sharedLock'] as const)('loads one-of-many relations under a %s constraint on PostgreSQL', async lockMethod => {
    const suffix = randomUUID().replaceAll('-', '_')
    const usersTable = `holo_one_of_many_lock_users_${suffix}`
    const postsTable = `holo_one_of_many_lock_posts_${suffix}`
    const adapter = createPostgresAdapter({
      config: livePostgresConfig,
    })
    const Post = defineModel(defineGeneratedTable(postsTable, {
      id: column.id(),
      user_id: column.integer(),
      score: column.integer(),
    }), { timestamps: false })
    const User = defineModel(defineGeneratedTable(usersTable, {
      id: column.id(),
      name: column.string(),
    }), {
      timestamps: false,
      relations: { topScorePost: latestOfMany(() => Post, 'user_id', 'id', 'score') },
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))

    try {
      await adapter.execute(`CREATE TABLE ${usersTable} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
      await adapter.execute(`CREATE TABLE ${postsTable} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, score INTEGER NOT NULL)`)
      await adapter.execute(`INSERT INTO ${usersTable} VALUES (1, 'Mohamed'), (2, 'Amina')`)
      await adapter.execute(`INSERT INTO ${postsTable} VALUES (10, 1, 5), (11, 1, 9), (12, 2, 3)`)

      const users = await User.with('topScorePost', query => query[lockMethod]()).orderBy('id').get()
      expect(users.map(user => user.getRelation<Entity<TableDefinition>>('topScorePost')?.get('id'))).toEqual([11, 12])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${usersTable}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${postsTable}`)
      await adapter.disconnect()
      resetDB()
    }
  }, 30_000)

  it('locks only the latest one-of-many rows under a constraint lock on PostgreSQL', async () => {
    const suffix = randomUUID().replaceAll('-', '_')
    const usersTable = `holo_one_of_many_scope_users_${suffix}`
    const postsTable = `holo_one_of_many_scope_posts_${suffix}`
    const adapter = createPostgresAdapter({
      config: { ...livePostgresConfig, max: 1, options: '-c lock_timeout=300' },
    })
    const holder = new Client(livePostgresConfig)
    const Post = defineModel(defineGeneratedTable(postsTable, {
      id: column.id(),
      user_id: column.integer(),
      score: column.integer(),
    }), { timestamps: false })
    const User = defineModel(defineGeneratedTable(usersTable, {
      id: column.id(),
      name: column.string(),
    }), {
      timestamps: false,
      relations: { topScorePost: latestOfMany(() => Post, 'user_id', 'id', 'score') },
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))

    try {
      await adapter.execute(`CREATE TABLE ${usersTable} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
      await adapter.execute(`CREATE TABLE ${postsTable} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, score INTEGER NOT NULL)`)
      await adapter.execute(`INSERT INTO ${usersTable} VALUES (1, 'Mohamed'), (2, 'Amina')`)
      await adapter.execute(`INSERT INTO ${postsTable} VALUES (10, 1, 5), (11, 1, 9), (12, 2, 3)`)
      await holder.connect()

      await holder.query(`BEGIN`)
      await holder.query(`SELECT id FROM ${postsTable} WHERE id = 10 FOR UPDATE`)
      const withSuperseded = await User.with('topScorePost', query => query.lockForUpdate()).orderBy('id').get()
      expect(withSuperseded.map(user => user.getRelation<Entity<TableDefinition>>('topScorePost')?.get('id'))).toEqual([11, 12])
      await holder.query(`ROLLBACK`)

      await holder.query(`BEGIN`)
      await holder.query(`SELECT id FROM ${postsTable} WHERE id = 11 FOR UPDATE`)
      await expect(User.with('topScorePost', query => query.lockForUpdate()).orderBy('id').get())
        .rejects.toThrow('lock timeout')
      await holder.query(`ROLLBACK`)
    } finally {
      await holder.query(`ROLLBACK`).catch(() => undefined)
      await holder.end()
      await adapter.execute(`DROP TABLE IF EXISTS ${usersTable}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${postsTable}`)
      await adapter.disconnect()
      resetDB()
    }
  }, 30_000)

  it('keeps a one-of-many constraint lock source-scoped after removing a global scope on PostgreSQL', async () => {
    const suffix = randomUUID().replaceAll('-', '_')
    const usersTable = `holo_one_of_many_scope_removal_users_${suffix}`
    const postsTable = `holo_one_of_many_scope_removal_posts_${suffix}`
    const adapter = createPostgresAdapter({
      config: livePostgresConfig,
    })
    const Post = defineModel(defineGeneratedTable(postsTable, {
      id: column.id(),
      user_id: column.integer(),
      score: column.integer(),
      published: column.boolean(),
    }), {
      timestamps: false,
      globalScopes: { published: query => query.where('published', true) },
    })
    const User = defineModel(defineGeneratedTable(usersTable, {
      id: column.id(),
      name: column.string(),
    }), {
      timestamps: false,
      relations: { topScorePost: latestOfMany(() => Post, 'user_id', 'id', 'score') },
    })
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('postgres') } },
    }))

    try {
      await adapter.execute(`CREATE TABLE ${usersTable} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
      await adapter.execute(`CREATE TABLE ${postsTable} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, score INTEGER NOT NULL, published BOOLEAN NOT NULL)`)
      await adapter.execute(`INSERT INTO ${usersTable} VALUES (1, 'Mohamed'), (2, 'Amina')`)
      await adapter.execute(`INSERT INTO ${postsTable} VALUES (10, 1, 5, true), (11, 1, 9, true), (12, 2, 3, true), (13, 1, 20, false)`)

      const users = await User.with('topScorePost', query => query.withoutGlobalScope('published').lockForUpdate()).orderBy('id').get()
      expect(users.map(user => user.getRelation<Entity<TableDefinition>>('topScorePost')?.get('id'))).toEqual([13, 12])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${usersTable}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${postsTable}`)
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

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('@holo-js/db-postgres date values', () => {
  it.each([
    { label: 'default types', types: undefined },
    { label: 'custom types that delegate to pg', types: pgTypes },
  ])('reads and writes date columns by calendar day regardless of the process time zone with $label', async ({ types }) => {
    const previousTimeZone = process.env.TZ
    process.env.TZ = 'America/New_York'
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2, types } })
    const db = createDatabase({ adapter, dialect: createDialect('postgres') })
    const tableName = `holo_date_${randomUUID().replaceAll('-', '')}`
    try {
      await adapter.execute(`CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, day DATE NOT NULL)`)
      await adapter.execute(`INSERT INTO ${tableName} (id, day) VALUES (1, '2024-03-15'), (2, '2024-12-31')`)
      const rows = (await db.queryCompiled({ sql: `SELECT id, day FROM ${tableName} ORDER BY id`, bindings: [] })).rows
      expect(rows.map(row => row.day)).toEqual([new Date('2024-03-15T00:00:00Z'), new Date('2024-12-31T00:00:00Z')])

      await db.executeCompiled({ sql: `INSERT INTO ${tableName} (id, day) VALUES ($1, $2)`, bindings: [3, rows[0]!.day] })
      expect((await db.queryCompiled({ sql: `SELECT day::text AS day FROM ${tableName} WHERE id = $1`, bindings: [3] })).rows)
        .toEqual([{ day: '2024-03-15' }])
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimeZone
      await adapter.execute(`DROP TABLE IF EXISTS ${tableName}`)
      await db.disconnect()
    }
  })
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('@holo-js/db-postgres full date formats', () => {
  it('round-trips BC dates, five-digit years, and infinite dates without shifting', async () => {
    const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
    const db = createDatabase({ adapter, dialect: createDialect('postgres') })
    const source = `holo_full_date_${randomUUID().replaceAll('-', '')}`
    const copy = `${source}_copy`
    try {
      await adapter.execute(`CREATE TABLE ${source} (id INTEGER PRIMARY KEY, day DATE NOT NULL, at TIMESTAMP NOT NULL)`)
      await adapter.execute(`CREATE TABLE ${copy} (id INTEGER PRIMARY KEY, day DATE NOT NULL, at TIMESTAMP NOT NULL)`)
      await adapter.execute(`INSERT INTO ${source} VALUES
        (1, '0044-03-15 BC', '0044-03-15 10:00:00 BC'),
        (2, '10000-01-01', '10000-01-01 00:00:00'),
        (3, 'infinity', 'infinity'),
        (4, '-infinity', '-infinity')`)

      const rows = (await db.queryCompiled({ sql: `SELECT id, day, at FROM ${source} ORDER BY id`, bindings: [] })).rows
      expect(rows.map(row => row.day)).toEqual([
        new Date('-000043-03-15T00:00:00.000Z'),
        new Date('+010000-01-01T00:00:00.000Z'),
        Infinity,
        -Infinity,
      ])
      expect(rows.map(row => row.at)).toEqual([
        new Date('-000043-03-15T10:00:00.000Z'),
        new Date('+010000-01-01T00:00:00.000Z'),
        Infinity,
        -Infinity,
      ])

      for (const row of rows) {
        await db.executeCompiled({ sql: `INSERT INTO ${copy} (id, day, at) VALUES ($1, $2, $3)`, bindings: [row.id, row.day, row.at] })
      }
      expect((await db.queryCompiled({ sql: `SELECT day::text AS day, at::text AS at FROM ${copy} ORDER BY id`, bindings: [] })).rows)
        .toEqual([
          { day: '0044-03-15 BC', at: '0044-03-15 10:00:00 BC' },
          { day: '10000-01-01', at: '10000-01-01 00:00:00' },
          { day: 'infinity', at: 'infinity' },
          { day: '-infinity', at: '-infinity' },
        ])
    } finally {
      await adapter.execute(`DROP TABLE IF EXISTS ${source}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${copy}`)
      await db.disconnect()
    }
  })
})
