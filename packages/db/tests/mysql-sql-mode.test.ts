import { randomUUID } from 'node:crypto'
import { createPool } from 'mysql2/promise'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createMySQLAdapter, type MySQLPoolLike } from '@holo-js/db-mysql'
import { createDatabase, createDialect, createSchemaService, SchemaError } from '../src'

const sqlModes = {
  'the server default': undefined,
  'NO_BACKSLASH_ESCAPES': 'STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES',
} as const

function openMySQLWithSqlMode(sqlMode: string | undefined) {
  const pool = createPool({
    host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
    user: process.env.HOLO_MYSQL_USER ?? 'root',
    password: process.env.HOLO_MYSQL_PASSWORD ?? '',
    database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
    timezone: 'Z',
    connectionLimit: 4,
  })
  if (sqlMode) {
    pool.on('connection', (connection) => {
      connection.query('SET SESSION sql_mode = ?', [sqlMode])
    })
  }
  const adapter = createMySQLAdapter({ pool: pool as unknown as MySQLPoolLike })
  const db = createDatabase({ connectionName: 'default', adapter, dialect: createDialect('mysql') })
  const schema = createSchemaService(db)
  onTestFinished(() => db.disconnect())
  return { db, schema }
}

describe.each(Object.entries(sqlModes))('MySQL literals under %s', (_label, sqlMode) => {
  it('stores a string default containing backslashes and quotes exactly as written', async () => {
    const { db, schema } = openMySQLWithSqlMode(sqlMode)
    const name = `holo_mysql_default_${randomUUID().replaceAll('-', '')}`
    const payload = `a\\'b\\c`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.string('note').default(payload)
    })
    await db.table(name).insert({ id: 1 })
    expect(await db.table(name).select('note').get()).toEqual([{ note: payload }])
  })

  it('stores enum values that contain quotes exactly as written', async () => {
    const { db, schema } = openMySQLWithSqlMode(sqlMode)
    const name = `holo_mysql_enum_${randomUUID().replaceAll('-', '')}`
    const values = ['it\'s', 'plain']
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.enum('state', values)
    })
    await db.table(name).insert([{ id: 1, state: values[0] }, { id: 2, state: values[1] }])
    expect(await db.table(name).select('state').orderBy('id').get()).toEqual([{ state: values[0] }, { state: values[1] }])
  })

  it('rejects enum values with a backslash in every SQL mode', async () => {
    const { schema } = openMySQLWithSqlMode(sqlMode)
    const name = `holo_mysql_enum_bs_${randomUUID().replaceAll('-', '')}`
    await expect(schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.enum('state', ['a\\b'])
    })).rejects.toThrow(SchemaError)
  })

  it('binds hostile string values as data, not SQL, in every SQL mode', async () => {
    const { db, schema } = openMySQLWithSqlMode(sqlMode)
    const name = `holo_mysql_bind_${randomUUID().replaceAll('-', '')}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    await db.table(name).insert([{ id: 1, name: 'safe' }, { id: 2, name: 'other' }])
    expect(await db.table(name).select('id').where('name', '\' OR 1=1 -- ').get()).toEqual([])
    expect(await db.table(name).select('id').where('name', 'it\'s').get()).toEqual([])
  })

  it('matches JSON keys that contain a backslash exactly', async () => {
    const { db, schema } = openMySQLWithSqlMode(sqlMode)
    const name = `holo_mysql_json_${randomUUID().replaceAll('-', '')}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.json('settings')
    })
    await db.table(name).insert({ id: 1, settings: { 'a\\b': 7 } })
    expect(await db.table(name).whereJson('settings->a\\b', 7).select('id').get()).toEqual([{ id: 1 }])
  })
})
