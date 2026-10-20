import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { types as pgTypes } from 'pg'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createDatabase, createDialect } from '../src'

describe('PostgreSQL date and timestamp values in app.timezone', () => {
  it('reads and writes calendar dates and wall-clock timestamps in app.timezone, not the process timezone', async () => {
    const previousTimeZone = process.env.TZ
    configureConfigRuntime({ app: { timezone: 'Asia/Tokyo' } } as never)
    process.env.TZ = 'America/New_York'
    const adapter = createPostgresAdapter({ config: {
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
      max: 2,
    } })
    const db = createDatabase({ adapter, dialect: createDialect('postgres') })
    const source = `holo_tz_${randomUUID().replaceAll('-', '')}`
    const copy = `${source}_copy`
    try {
      await adapter.execute(`CREATE TABLE ${source} (id INTEGER PRIMARY KEY, day DATE NOT NULL, at TIMESTAMP NOT NULL, instant TIMESTAMPTZ NOT NULL)`)
      await adapter.execute(`CREATE TABLE ${copy} (id INTEGER PRIMARY KEY, day DATE NOT NULL, at TIMESTAMP NOT NULL, instant TIMESTAMPTZ NOT NULL)`)
      await adapter.execute(`INSERT INTO ${source} VALUES (1, '2024-03-15', '2024-03-15 10:00:00', '2024-03-15T01:00:00Z')`)

      const [row] = (await db.queryCompiled({ sql: `SELECT day, at, instant FROM ${source} WHERE id = $1`, bindings: [1] })).rows
      expect(row).toEqual({
        day: new Date('2024-03-14T15:00:00Z'),
        at: new Date('2024-03-15T01:00:00Z'),
        instant: new Date('2024-03-15T01:00:00Z'),
      })

      await db.executeCompiled({
        sql: `INSERT INTO ${copy} (id, day, at, instant) VALUES ($1, $2, $3, $4)`,
        bindings: [2, row!.day, row!.at, row!.instant],
      })
      expect((await db.queryCompiled({ sql: `SELECT day::text AS day, at::text AS at FROM ${copy} WHERE id = $1`, bindings: [2] })).rows)
        .toEqual([{ day: '2024-03-15', at: '2024-03-15 10:00:00' }])
      expect((await db.queryCompiled({ sql: `SELECT instant = $2 AS same FROM ${copy} WHERE id = $1`, bindings: [2, new Date('2024-03-15T01:00:00Z')] })).rows)
        .toEqual([{ same: true }])
    } finally {
      resetConfigRuntime()
      process.env.TZ = previousTimeZone
      await adapter.execute(`DROP TABLE IF EXISTS ${source}`)
      await adapter.execute(`DROP TABLE IF EXISTS ${copy}`)
      await db.disconnect()
    }
  })
})

const liveConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
  password: process.env.HOLO_POSTGRES_PASSWORD,
  database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
}

async function withAppTimezone<T>(timeZone: string, callback: () => Promise<T>): Promise<T> {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: timeZone } } as never)
  process.env.TZ = 'America/New_York'
  try {
    return await callback()
  } finally {
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  }
}

describe('PostgreSQL dates in app.timezone at DST gaps and historical offsets', () => {
  it.each([
    { zone: 'America/Santiago', day: '2026-09-06', instant: '2026-09-06T04:00:00.000Z' },
    { zone: 'America/Havana', day: '2026-03-08', instant: '2026-03-08T05:00:00.000Z' },
  ])('keeps a DATE on its calendar day when local midnight does not exist in $zone', async ({ zone, day, instant }) => {
    await withAppTimezone(zone, async () => {
      const adapter = createPostgresAdapter({ config: { ...liveConfig, max: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('postgres') })
      const source = `holo_gap_date_${randomUUID().replaceAll('-', '')}`
      const copy = `${source}_copy`
      try {
        await adapter.execute(`CREATE TABLE ${source} (id INTEGER PRIMARY KEY, day DATE NOT NULL)`)
        await adapter.execute(`CREATE TABLE ${copy} (id INTEGER PRIMARY KEY, day DATE NOT NULL)`)
        await adapter.execute(`INSERT INTO ${source} VALUES (1, '${day}')`)

        const [row] = (await db.queryCompiled({ sql: `SELECT day FROM ${source} WHERE id = $1`, bindings: [1] })).rows
        expect(row!.day).toEqual(new Date(instant))

        await db.executeCompiled({ sql: `INSERT INTO ${copy} (id, day) VALUES ($1, $2)`, bindings: [1, row!.day] })
        expect((await db.queryCompiled({ sql: `SELECT day::text AS day FROM ${copy} WHERE id = $1`, bindings: [1] })).rows)
          .toEqual([{ day }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${source}`)
        await adapter.execute(`DROP TABLE IF EXISTS ${copy}`)
        await db.disconnect()
      }
    })
  })

  it('resolves a TIMESTAMP inside a New York spring-forward gap forward, as PostgreSQL does', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...liveConfig, max: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('postgres') })
      const source = `holo_gap_ts_${randomUUID().replaceAll('-', '')}`
      const copy = `${source}_copy`
      try {
        await adapter.execute(`CREATE TABLE ${source} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        await adapter.execute(`CREATE TABLE ${copy} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        await adapter.execute(`INSERT INTO ${source} VALUES (1, '2026-03-08 02:30:00')`)

        const [row] = (await db.queryCompiled({ sql: `SELECT at FROM ${source} WHERE id = $1`, bindings: [1] })).rows
        expect(row!.at).toEqual(new Date('2026-03-08T07:30:00.000Z'))
        expect((await db.queryCompiled({
          sql: 'SELECT (($1::timestamp) AT TIME ZONE \'America/New_York\') = $2::timestamptz AS same',
          bindings: ['2026-03-08 02:30:00', row!.at],
        })).rows).toEqual([{ same: true }])

        await db.executeCompiled({ sql: `INSERT INTO ${copy} (id, at) VALUES ($1, $2)`, bindings: [1, row!.at] })
        expect((await db.queryCompiled({ sql: `SELECT at::text AS at FROM ${copy} WHERE id = $1`, bindings: [1] })).rows)
          .toEqual([{ at: '2026-03-08 03:30:00' }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${source}`)
        await adapter.execute(`DROP TABLE IF EXISTS ${copy}`)
        await db.disconnect()
      }
    })
  })

  it('binds timestamptz values with historical offsets that include seconds exactly', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...liveConfig, max: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('postgres') })
      const table = `holo_tstz_${randomUUID().replaceAll('-', '')}`
      const original = new Date('1800-06-01T12:00:00Z')
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, instant TIMESTAMPTZ NOT NULL)`)
        await db.executeCompiled({ sql: `INSERT INTO ${table} (id, instant) VALUES ($1, $2)`, bindings: [1, original] })
        expect((await db.queryCompiled({ sql: `SELECT instant = $2 AS same FROM ${table} WHERE id = $1`, bindings: [1, original] })).rows)
          .toEqual([{ same: true }])
        expect((await db.queryCompiled({ sql: `SELECT instant FROM ${table} WHERE id = $1`, bindings: [1] })).rows)
          .toEqual([{ instant: original }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })

  it('keeps TIMESTAMP values in app.timezone when custom types customize an unrelated OID', async () => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createPostgresAdapter({ config: {
        ...liveConfig,
        max: 2,
        types: {
          getTypeParser(oid: number, format?: 'text' | 'binary') {
            if (oid === 23) return (value: string) => `int:${value}`
            return pgTypes.getTypeParser(oid, format)
          },
        },
      } as never })
      const db = createDatabase({ adapter, dialect: createDialect('postgres') })
      const table = `holo_custom_types_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        await adapter.execute(`INSERT INTO ${table} VALUES (1, '2024-03-15 10:00:00')`)
        expect((await db.queryCompiled({ sql: `SELECT id, at FROM ${table} WHERE id = $1`, bindings: [1] })).rows)
          .toEqual([{ id: 'int:1', at: new Date('2024-03-15T01:00:00Z') }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })
})
