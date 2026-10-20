import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
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
