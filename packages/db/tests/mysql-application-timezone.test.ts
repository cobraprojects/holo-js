import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createMySQLAdapter } from '@holo-js/db-mysql'
import { DB, column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
import { mysqlTestConnection, testConnectionUrl } from './support/database'

function dateStringsUrl() {
  const url = testConnectionUrl('mysql', mysqlTestConnection())
  url.searchParams.set('dateStrings', 'true')
  return url.toString()
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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

  it('truncates sub-second timestamps instead of rounding them into the future', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
      const table = `holo_subsecond_${randomUUID().replaceAll('-', '')}`
      const now = new Date('2026-11-15T17:00:00.900Z')
      vi.useFakeTimers({ toFake: ['Date'], now })
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, at DATETIME NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.datetime().nullable(), created_at: column.timestamp().nullable(), updated_at: column.timestamp().nullable() })
        const Model = defineModel(typed, { primaryKey: 'id', fillable: ['id', 'at'] })
        await Model.create({ id: 1 })
        await Model.create({ id: 2, at: '2026-11-15T17:00:00.900Z' } as never)
        await DB.table(table).insert({ id: 3, at: now })
        await Model.create({ id: 4, at: '2026-11-15T12:00:00.900' } as never)
        await Model.create({ id: 5, at: '2026-11-15 12:00:00.900' } as never)

        expect((await adapter.query<{ id: number, at: string | null, created_at: string | null }>(
          `SELECT id, DATE_FORMAT(at, '%Y-%m-%d %H:%i:%s') AS at, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at FROM ${table} ORDER BY id`,
        )).rows).toEqual([
          { id: 1, at: null, created_at: '2026-11-15 12:00:00' },
          { id: 2, at: '2026-11-15 12:00:00', created_at: '2026-11-15 12:00:00' },
          { id: 3, at: '2026-11-15 12:00:00', created_at: null },
          { id: 4, at: '2026-11-15 12:00:00', created_at: '2026-11-15 12:00:00' },
          { id: 5, at: '2026-11-15 12:00:00', created_at: '2026-11-15 12:00:00' },
        ])
        expect(await DB.table(table).where('created_at', '<=', now).orderBy('id').pluck('id')).toEqual([1, 2, 4, 5])
        expect(await DB.table(table).where('at', '<=', now).orderBy('id').pluck('id')).toEqual([2, 3, 4, 5])
      } finally {
        vi.useRealTimers()
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('holds the stored whole-second values on the model after a MySQL write', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
      const table = `holo_subsecond_model_${randomUUID().replaceAll('-', '')}`
      const created = new Date('2026-11-15T17:00:00.900Z')
      const updated = new Date('2026-11-15T17:00:05.400Z')
      const deleted = new Date('2026-11-15T17:00:09.700Z')
      vi.useFakeTimers({ toFake: ['Date'], now: created })
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, at DATETIME NULL, created_at TIMESTAMP NULL, updated_at TIMESTAMP NULL, deleted_at TIMESTAMP NULL)`)
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') } } }))
        const typed = defineGeneratedTable(table, { id: column.integer(), at: column.datetime().nullable(), created_at: column.timestamp().nullable(), updated_at: column.timestamp().nullable(), deleted_at: column.timestamp().nullable() })
        const Model = defineModel(typed, { primaryKey: 'id', fillable: ['id', 'at'], softDeletes: true })
        const wholeSecond = (value: Date) => new Date(Math.floor(value.getTime() / 1000) * 1000)
        const instantOf = (value: unknown) => new Date(value as string | Date)

        const model = await Model.create({ id: 1, at: created })
        expect(model.get('created_at')).toEqual(wholeSecond(created))
        expect(model.get('updated_at')).toEqual(wholeSecond(created))
        expect(model.get('at')).toEqual(wholeSecond(created))

        vi.setSystemTime(updated)
        model.fill({ at: '2026-11-15T17:00:05.400Z' } as never)
        await model.save()
        expect(model.get('updated_at')).toEqual(wholeSecond(updated))
        expect(model.get('at')).toEqual(wholeSecond(updated))

        vi.setSystemTime(deleted)
        await model.delete()
        expect(instantOf(model.get('deleted_at'))).toEqual(wholeSecond(deleted))
        expect(model.get('updated_at')).toEqual(wholeSecond(deleted))

        const stored = await Model.withTrashed().findOrFail(1)
        for (const key of ['at', 'created_at', 'updated_at', 'deleted_at'] as const) {
          expect(instantOf(model.get(key))).toEqual(stored.get(key))
        }
      } finally {
        vi.useRealTimers()
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('holds the stored whole-second Date on an untyped model after a MySQL write', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
      const table = `holo_subsecond_untyped_${randomUUID().replaceAll('-', '')}`
      try {
        await adapter.execute(`CREATE TABLE ${table} (id INT PRIMARY KEY, at DATETIME NULL)`)
        const analytics = createDatabase({ connectionName: 'analytics', adapter, dialect: createDialect('mysql') })
        configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: { adapter, dialect: createDialect('mysql') }, analytics } }))
        const Model = defineModel(table, { connectionName: 'analytics', timestamps: false, fillable: ['id', 'at'] })

        const model = await Model.create({ id: 1, at: new Date('2026-11-15T17:00:00.900Z') })
        expect(model.get('at')).toEqual(new Date('2026-11-15T17:00:00.000Z'))

        model.fill({ at: new Date('2026-11-15T17:00:05.400Z') })
        await model.save()
        expect(model.get('at')).toEqual(new Date('2026-11-15T17:00:05.000Z'))
        expect((await Model.findOrFail(1)).get('at')).toEqual(model.get('at'))
      } finally {
        resetDB()
        await adapter.execute(`DROP TABLE IF EXISTS ${table}`)
        await adapter.disconnect()
      }
    })
  })

  it('rejects zoned text with an impossible calendar value instead of writing a different instant', async () => {
    await withAppTimezone('America/New_York', async () => {
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
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
    const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
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
      options: { dateStrings: true },
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'dateStrings in the connection URL',
      viaUrl: true,
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'typeCast: false',
      options: { typeCast: false },
      stored: { day: '2024-03-15', at: '2024-03-15 10:00:00', instant: '2024-03-15 10:00:00' },
    },
    {
      label: 'dateStrings for DATETIME only',
      options: { dateStrings: ['DATETIME' as const] },
      stored: { day: new Date('2024-03-14T15:00:00Z'), at: '2024-03-15 10:00:00', instant: new Date('2024-03-15T01:00:00Z') },
    },
  ])('returns app.timezone wall-clock values and round-trips them with $label', async ({ options, viaUrl, stored: expected }) => {
    await withAppTimezone('Asia/Tokyo', async () => {
      const adapter = createMySQLAdapter({ config: viaUrl
        ? { uri: dateStringsUrl(), connectionLimit: 1 }
        : { ...mysqlTestConnection(), connectionLimit: 1, ...options } })
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
    const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1, typeCast: false } })
    try {
      expect((await adapter.query<{ n: unknown, one: unknown }>('SELECT NULL AS n, CAST(1 AS SIGNED) AS one')).rows)
        .toEqual([{ n: null, one: Buffer.from('1') }])
    } finally {
      await adapter.disconnect()
    }
  })

  it('keeps a configured typeCast for columns Holo does not read', async () => {
    const adapter = createMySQLAdapter({ config: {
      ...mysqlTestConnection(),
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
      const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 2 } })
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
