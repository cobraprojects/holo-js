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
})
