import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'

const livePostgresConfig = {
  host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
  user: 'postgres',
  database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
}

async function withAppTimezone<T>(timeZone: string, callback: () => Promise<T>): Promise<T> {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: timeZone } } as never)
  process.env.TZ = 'Asia/Tokyo'
  try {
    return await callback()
  } finally {
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  }
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('@holo-js/db-postgres Date writes in app.timezone', () => {
  it('writes Date values through a typed model as app.timezone wall-clock time and reads back the same instant', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const table = `holo_pg_model_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, day DATE NOT NULL, at TIMESTAMP NOT NULL, instant TIMESTAMPTZ NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('postgres') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), day: column.date(), at: column.timestamp(), instant: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'day', 'at', 'instant'] })
        const value = new Date('2026-11-15T03:30:00Z')
        await Model.create({ id: 1, day: value, at: value, instant: value })

        expect((await adapter.query<{ day: string, at: string, seconds: number }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day, to_char(at, 'YYYY-MM-DD HH24:MI:SS') AS at, EXTRACT(EPOCH FROM instant)::float8 AS seconds FROM ${table} WHERE id = 1`,
        )).rows).toEqual([{ day: '2026-11-14', at: '2026-11-14 22:30:00', seconds: value.getTime() / 1000 }])

        const stored = await Model.find(1)
        expect(stored!.at).toEqual(value)
        expect(stored!.instant).toEqual(value)

        const next = new Date('2026-11-16T12:00:00Z')
        await Model.query().where('id', 1).update({ at: next, instant: next })
        expect((await adapter.query<{ at: string, seconds: number }>(
          `SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS') AS at, EXTRACT(EPOCH FROM instant)::float8 AS seconds FROM ${table} WHERE id = 1`,
        )).rows).toEqual([{ at: '2026-11-16 07:00:00', seconds: next.getTime() / 1000 }])
        expect((await Model.find(1))!.at).toEqual(next)

        const entity = await Model.find(1)
        const later = new Date('2026-11-17T12:00:00Z')
        entity!.forceFill({ at: later, instant: later })
        await entity!.save()
        expect((await adapter.query<{ at: string, seconds: number }>(
          `SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS') AS at, EXTRACT(EPOCH FROM instant)::float8 AS seconds FROM ${table} WHERE id = 1`,
        )).rows).toEqual([{ at: '2026-11-17 07:00:00', seconds: later.getTime() / 1000 }])
        expect((await Model.find(1))!.at).toEqual(later)
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it.each([
    '2025-02-30T03:04:05Z',
    '2025-04-31T00:00:00+02:00',
  ])('rejects zoned text with an impossible calendar value (%s) instead of writing a different instant', async (value) => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const table = `holo_pg_invalid_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('postgres') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'at'] })

        await expect(Model.create({ id: 1, at: value } as never)).rejects.toThrow()
        expect((await adapter.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`)).rows).toEqual([{ count: '0' }])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('writes an end-of-day zoned value as the instant it names, and rejects a leap second', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const table = `holo_pg_eod_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('postgres') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'at'] })

        await Model.create({ id: 1, at: '2025-01-02T24:00:00Z' } as never)
        expect((await adapter.query<{ at: string }>(`SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS') AS at FROM ${table} WHERE id = 1`)).rows)
          .toEqual([{ at: '2025-01-02 19:00:00' }])

        await expect(Model.create({ id: 2, at: '2025-01-02T03:04:60Z' } as never)).rejects.toThrow('Leap second')
        expect((await adapter.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`)).rows).toEqual([{ count: '1' }])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('keeps microseconds from explicitly zoned text written through a typed model', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const table = `holo_pg_micro_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL, instant TIMESTAMPTZ NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('postgres') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.timestamp(), instant: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'at', 'instant'] })
        await Model.create({ id: 1, at: '2026-11-15T03:30:00.123456Z', instant: '2026-11-15T03:30:00.123456Z' } as never)

        expect((await adapter.query<{ at: string, instant: string }>(
          `SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS.US') AS at, to_char(instant AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS instant FROM ${table} WHERE id = 1`,
        )).rows).toEqual([{ at: '2026-11-14 22:30:00.123456', instant: '2026-11-15 03:30:00.123456' }])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('matches and stores Date query values as app.timezone wall-clock time through the query builder', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('postgres') })
      const table = `holo_pg_query_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL)`)
        const value = new Date('2026-11-15T12:00:00Z')
        await db.table(table).insert({ id: 1, at: value })

        expect((await adapter.query<{ at: string }>(`SELECT to_char(at, 'YYYY-MM-DD HH24:MI:SS') AS at FROM ${table} WHERE id = 1`)).rows)
          .toEqual([{ at: '2026-11-15 07:00:00' }])
        expect((await db.table(table).where('at', '=', value).pluck('id')))
          .toEqual([1])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })

  it('round-trips a DATE on a day the app timezone skipped entirely, by calendar day', async () => {
    await withAppTimezone('Pacific/Apia', async () => {
      const adapter = createPostgresAdapter({ config: { ...livePostgresConfig, max: 2 } })
      const table = `holo_pg_gap_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, day DATE NOT NULL)`)
        await adapter.execute(`INSERT INTO ${table} (id, day) VALUES (1, '2011-12-29'), (2, '2011-12-30'), (3, '2011-12-31')`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('postgres') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), day: column.date() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'day'] })

        expect((await adapter.query<{ day: unknown }>(`SELECT day FROM ${table} ORDER BY id`)).rows.map(row => row.day))
          .toEqual([new Date('2011-12-29T10:00:00Z'), '2011-12-30', new Date('2011-12-30T10:00:00Z')])

        for (const id of [1, 2, 3]) {
          const loaded = await Model.find(id)
          await Model.create({ id: id + 10, day: loaded!.day } as never)
        }

        expect((await adapter.query<{ id: number, day: string }>(
          `SELECT id, to_char(day, 'YYYY-MM-DD') AS day FROM ${table} WHERE id > 10 ORDER BY id`,
        )).rows).toEqual([
          { id: 11, day: '2011-12-29' },
          { id: 12, day: '2011-12-30' },
          { id: 13, day: '2011-12-31' },
        ])

        const Casted = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'day'], casts: { day: 'date' } })
        for (const id of [1, 2, 3]) {
          const loaded = await Casted.find(id)
          await Casted.create({ id: id + 20, day: loaded!.day } as never)
        }

        expect((await adapter.query<{ id: number, day: string }>(
          `SELECT id, to_char(day, 'YYYY-MM-DD') AS day FROM ${table} WHERE id > 20 ORDER BY id`,
        )).rows).toEqual([
          { id: 21, day: '2011-12-29' },
          { id: 22, day: '2011-12-30' },
          { id: 23, day: '2011-12-31' },
        ])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })
})
