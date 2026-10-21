import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { createDatabase, createDialect } from '../src'

const liveMySQLConfig = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD ?? '',
  database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
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

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('MySQL date and timestamp values in app.timezone', () => {
  it('reads and writes DATE, DATETIME, and TIMESTAMP values in app.timezone, not the process timezone', async () => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('mysql') })
      const source = `holo_tz_${randomUUID().replaceAll('-', '')}`
      const copy = `${source}_copy`
      try {
        await adapter.execute(`CREATE TABLE ${source} (id INT PRIMARY KEY, day DATE NOT NULL, at DATETIME(3) NOT NULL, instant TIMESTAMP(3) NOT NULL, missing DATETIME(3) NULL)`)
        await adapter.execute(`CREATE TABLE ${copy} (id INT PRIMARY KEY, day DATE NOT NULL, at DATETIME(3) NOT NULL, instant TIMESTAMP(3) NOT NULL)`)
        await adapter.execute(`INSERT INTO ${source} VALUES (1, '2024-03-15', '2024-03-15 10:00:00', '2024-03-15 10:00:00', NULL)`)

        const expected = {
          day: new Date('2024-03-14T15:00:00Z'),
          at: new Date('2024-03-15T01:00:00Z'),
          instant: new Date('2024-03-15T01:00:00Z'),
          missing: null,
        }
        const [unbound] = (await db.queryCompiled({ sql: `SELECT day, at, instant, missing FROM ${source}`, bindings: [] })).rows
        expect(unbound).toEqual(expected)
        const [bound] = (await db.queryCompiled({ sql: `SELECT day, at, instant, missing FROM ${source} WHERE id = ?`, bindings: [1] })).rows
        expect(bound).toEqual(expected)

        await db.executeCompiled({
          sql: `INSERT INTO ${copy} (id, day, at, instant) VALUES (?, ?, ?, ?)`,
          bindings: [2, bound!.day, bound!.at, bound!.instant],
        })
        expect((await adapter.query<{ day: string, at: string, instant: number }>(
          `SELECT DATE_FORMAT(day, '%Y-%m-%d') AS day, DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS at, CAST(UNIX_TIMESTAMP(instant) AS SIGNED) AS instant FROM ${copy} WHERE id = 2`,
        )).rows).toEqual([{ day: '2024-03-15', at: '2024-03-15 10:00:00', instant: 1710464400 }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${source}`)
        await adapter.execute(`DROP TABLE IF EXISTS ${copy}`)
        await db.disconnect()
      }
    })
  })

  it('keeps a TIMESTAMP as the same instant across a daylight saving change in app.timezone', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('mysql') })
      const table = `holo_dst_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, instant TIMESTAMP(3) NOT NULL)`)
        const summer = new Date('2024-07-01T16:00:00Z')
        const winter = new Date('2024-01-15T17:00:00Z')
        await db.executeCompiled({ sql: `INSERT INTO ${table} (id, instant) VALUES (?, ?), (?, ?)`, bindings: [1, summer, 2, winter] })

        expect((await db.queryCompiled({ sql: `SELECT id, instant FROM ${table} ORDER BY id`, bindings: [] })).rows)
          .toEqual([{ id: 1, instant: summer }, { id: 2, instant: winter }])
        expect((await adapter.query<{ seconds: number }>(`SELECT CAST(UNIX_TIMESTAMP(instant) AS SIGNED) AS seconds FROM ${table} WHERE id = 1`)).rows)
          .toEqual([{ seconds: summer.getTime() / 1000 }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })

  it('returns MySQL zero dates as their stored text instead of a shifted Date', async () => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 1 } })
      const table = `holo_zero_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute('SET SESSION sql_mode = \'\'')
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, day DATE NULL, at DATETIME(3) NULL)`)
        await adapter.execute(`INSERT INTO ${table} VALUES (1, '0000-00-00', '0000-00-00 00:00:00'), (2, '2024-01-00', '2024-00-15 10:00:00')`)
        const rows = (await adapter.query<{ id: number, day: unknown, at: string }>(`SELECT id, day, at FROM ${table} ORDER BY id`)).rows
        expect(rows.map(row => ({ ...row, at: row.at.replace(/\.0+$/, '') })))
          .toEqual([
            { id: 1, day: '0000-00-00', at: '0000-00-00 00:00:00' },
            { id: 2, day: '2024-01-00', at: '2024-00-15 10:00:00' },
          ])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('fails queries instead of running in the server time zone when MySQL does not know app.timezone', async () => {
    configureConfigRuntime({ app: { timezone: 'Not/AZone' } } as never)
    const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 1 } })
    try {
      await expect(adapter.query('SELECT 1')).rejects.toThrow()
    } finally {
      resetConfigRuntime()
      await adapter.disconnect()
    }
  })

  it('refuses dateStrings, which would bypass app.timezone date handling', async () => {
    const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, dateStrings: true } })
    try {
      await expect(adapter.query('SELECT 1')).rejects.toThrow(/dateStrings/)
    } finally {
      await adapter.disconnect()
    }
  })

  it('keeps a configured typeCast for columns Holo does not read', async () => {
    const adapter = createMySQLAdapter({ config: {
      ...liveMySQLConfig,
      connectionLimit: 1,
      typeCast: (field, next) => (field.type === 'LONGLONG' ? 'custom' : next()),
    } })
    try {
      expect((await adapter.query<{ value: unknown }>('SELECT CAST(1 AS SIGNED) AS value')).rows)
        .toEqual([{ value: 'custom' }])
    } finally {
      await adapter.disconnect()
    }
  })

  it('pins the session time zone to app.timezone on every pooled connection', async () => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      try {
        const held = 'SELECT @@session.time_zone AS zone, SLEEP(0.1) AS held'
        const zones = await Promise.all([adapter.query<{ zone: string }>(held), adapter.query<{ zone: string }>(held)])
        expect(zones.map(result => result.rows.map(row => row.zone))).toEqual([['Asia/Tokyo'], ['Asia/Tokyo']])
      } finally {
        await adapter.disconnect()
      }
    })
  })
})
