import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'

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

  it('saves an unchanged TIMESTAMP from the repeated fall-back hour back to the instant it was stored at', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('mysql') })
      const table = `holo_fallback_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, instant TIMESTAMP(3) NOT NULL)`)
        const firstOccurrence = new Date('2024-11-03T05:30:00Z')
        await db.executeCompiled({ sql: `INSERT INTO ${table} (id, instant) VALUES (?, ?)`, bindings: [1, firstOccurrence] })

        const [read] = (await db.queryCompiled({ sql: `SELECT instant FROM ${table} WHERE id = ?`, bindings: [1] })).rows
        expect(read!.instant).toEqual(firstOccurrence)

        await db.executeCompiled({ sql: `UPDATE ${table} SET instant = ? WHERE id = ?`, bindings: [read!.instant, 1] })
        expect((await adapter.query<{ seconds: number }>(`SELECT CAST(UNIX_TIMESTAMP(instant) AS SIGNED) AS seconds FROM ${table} WHERE id = 1`)).rows)
          .toEqual([{ seconds: firstOccurrence.getTime() / 1000 }])
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })

  it('reads a TIMESTAMP stored at the later repeated-hour instant one hour early, because the wall-clock text is the same for both', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 1 } })
      const table = `holo_fallback_later_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, instant TIMESTAMP(3) NOT NULL)`)
        await adapter.execute(`INSERT INTO ${table} VALUES (1, '2024-11-03 01:30:00.000-05:00')`)
        expect((await adapter.query<{ seconds: number }>(`SELECT CAST(UNIX_TIMESTAMP(instant) AS SIGNED) AS seconds FROM ${table} WHERE id = 1`)).rows)
          .toEqual([{ seconds: 1730615400 }])
        const [read] = (await adapter.query<{ instant: Date }>(`SELECT instant FROM ${table} WHERE id = 1`)).rows
        expect(read!.instant).toEqual(new Date('2024-11-03T05:30:00Z'))
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('writes Date values through a typed model in app.timezone, not as UTC wall-clock text', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const table = `holo_model_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, at DATETIME(3) NOT NULL, instant TIMESTAMP(3) NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.datetime(), instant: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'at', 'instant'] })
        const value = new Date('2026-11-15T12:00:00Z')
        await Model.create({ id: 1, at: value, instant: value })

        expect((await adapter.query<{ at: string, seconds: number }>(
          `SELECT DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS at, CAST(UNIX_TIMESTAMP(instant) AS SIGNED) AS seconds FROM ${table} WHERE id = 1`,
        )).rows).toEqual([{ at: '2026-11-15 07:00:00', seconds: value.getTime() / 1000 }])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('rejects zoned text with an impossible calendar value instead of writing a different instant', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const table = `holo_mysql_invalid_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, at DATETIME(3) NOT NULL, instant TIMESTAMP(3) NOT NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.datetime(), instant: column.timestamp() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'at', 'instant'] })

        await expect(Model.create({ id: 1, at: '2025-02-30T03:04:05Z', instant: '2025-02-30T03:04:05Z' } as never)).rejects.toThrow()
        expect((await adapter.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)).rows).toEqual([{ count: 0 }])
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
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

  it.each([
    {
      label: 'dateStrings: true',
      config: { ...liveMySQLConfig, connectionLimit: 1, dateStrings: true },
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'dateStrings in the connection URL',
      config: { uri: `mysql://${liveMySQLConfig.user}@${liveMySQLConfig.host}:${liveMySQLConfig.port}/${liveMySQLConfig.database}?dateStrings=true`, connectionLimit: 1 },
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'typeCast: false',
      config: { ...liveMySQLConfig, connectionLimit: 1, typeCast: false },
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'dateStrings for DATETIME only',
      config: { ...liveMySQLConfig, connectionLimit: 1, dateStrings: ['DATETIME' as const] },
      stored: { day: new Date('2024-03-14T15:00:00Z'), at: '2024-03-15 10:00:00', instant: new Date('2024-03-15T01:00:00Z') },
    },
  ])('returns app.timezone wall-clock values and round-trips them with $label', async ({ config, stored: expected }) => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createMySQLAdapter({ config })
      const db = createDatabase({ adapter, dialect: createDialect('mysql') })
      const table = `holo_opt_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, day DATE NOT NULL, at DATETIME NOT NULL, instant TIMESTAMP NOT NULL)`)
        await adapter.execute(`INSERT INTO ${table} VALUES (1, '2024-03-15', '2024-03-15 10:00:00', '2024-03-15 10:00:00')`)
        const [stored] = (await adapter.query(`SELECT day, at, instant FROM ${table} WHERE id = ?`, [1])).rows
        expect(stored).toEqual(expected)

        const instant = new Date('2024-03-15T01:00:00Z')
        await db.executeCompiled({ sql: `INSERT INTO ${table} (id, day, at, instant) VALUES (?, ?, ?, ?)`, bindings: [2, instant, instant, instant] })
        const [bound] = (await adapter.query(`SELECT day, at, instant FROM ${table} WHERE id = ?`, [2])).rows
        expect(bound).toEqual(expected)

        await db.executeCompiled({ sql: `INSERT INTO ${table} (id, day, at, instant) VALUES (?, ?, ?, ?)`, bindings: [3, stored!.day, stored!.at, stored!.instant] })
        const [roundTrip] = (await adapter.query(`SELECT day, at, instant FROM ${table} WHERE id = ?`, [3])).rows
        expect(roundTrip).toEqual(expected)
      } finally {
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })

  it('leaves other columns as the driver returns them when typeCast is false', async () => {
    const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 1, typeCast: false } })
    try {
      expect((await adapter.query<{ n: unknown, one: unknown }>('SELECT NULL AS n, CAST(1 AS SIGNED) AS one')).rows)
        .toEqual([{ n: null, one: Buffer.from('1') }])
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

  it('round-trips a DATE on a day the app timezone skipped entirely, by calendar day', async () => {
    await withAppTimezone('Pacific/Apia', async () => {
      const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 2 } })
      const db = createDatabase({ adapter, dialect: createDialect('mysql') })
      const table = `holo_tz_gap_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, day DATE NOT NULL)`)
        await adapter.execute(`INSERT INTO ${table} (id, day) VALUES (1, '2011-12-29'), (2, '2011-12-30'), (3, '2011-12-31')`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), day: column.date() })
        const Model = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'day'] })

        expect((await adapter.query<{ day: unknown }>(`SELECT day FROM ${table} ORDER BY id`)).rows.map(row => row.day))
          .toEqual([new Date('2011-12-29T10:00:00Z'), '2011-12-30', new Date('2011-12-30T10:00:00Z')])

        for (const id of [1, 2, 3]) {
          const loaded = await Model.find(id)
          await Model.create({ id: id + 10, day: loaded!.day } as never)
        }

        expect((await adapter.query<{ id: number, day: string }>(
          `SELECT id, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM ${table} WHERE id > 10 ORDER BY id`,
        )).rows).toEqual([
          { id: 11, day: '2011-12-29' },
          { id: 12, day: '2011-12-30' },
          { id: 13, day: '2011-12-31' },
        ])

        for (const [cast, base] of [['date', 20], ['timestamp', 30]] as const) {
          const Casted = defineModel(typed, { primaryKey: 'id', timestamps: false, fillable: ['id', 'day'], casts: { day: cast } })
          for (const id of [1, 2, 3]) {
            const loaded = await Casted.find(id)
            await Casted.create({ id: id + base, day: loaded!.day } as never)
          }

          expect((await adapter.query<{ id: number, day: string }>(
            `SELECT id, DATE_FORMAT(day, '%Y-%m-%d') AS day FROM ${table} WHERE id > ${base} AND id <= ${base + 3} ORDER BY id`,
          )).rows).toEqual([
            { id: base + 1, day: '2011-12-29' },
            { id: base + 2, day: '2011-12-30' },
            { id: base + 3, day: '2011-12-31' },
          ])
        }
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await db.disconnect()
      }
    })
  })
})
