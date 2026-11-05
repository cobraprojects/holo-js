import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { mysqlDatabaseDriverFactory } from '../src'
import { mysqlTestConnection, testConnectionUrl } from '../../../tests/support/real-database'

function structuredConnection() {
  const { user, ...connection } = mysqlTestConnection()
  return { ...connection, username: user }
}

function connectionUrl(query = '') {
  return `${testConnectionUrl('mysql', mysqlTestConnection())}${query}`
}

async function openNumbersTable(connection: Parameters<typeof mysqlDatabaseDriverFactory.create>[0]) {
  const adapter = mysqlDatabaseDriverFactory.create(connection)
  const table = `big_numbers_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    try { await adapter.execute(`DROP TABLE IF EXISTS ${table}`) } finally { await adapter.disconnect() }
  })
  await adapter.execute(`CREATE TABLE ${table} (id BIGINT AUTO_INCREMENT PRIMARY KEY, safe BIGINT, price DECIMAL(20, 2), wide DECIMAL(30, 0), payload JSON)`)
  return { adapter, table }
}

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql big numbers against a live server', () => {
  it('returns a BIGINT beyond the safe integer range as its exact text, and parses DECIMAL and JSON as before', async () => {
    const { adapter, table } = await openNumbersTable(structuredConnection())
    const inserted = await adapter.execute(`INSERT INTO ${table} (id, safe, price, wide) VALUES (9007199254740993, 42, 12.50, 123456789012345678901234567890)`)
    await adapter.execute(`UPDATE ${table} SET payload = CAST('{"big":9007199254740993}' AS JSON)`)

    const raw = await adapter.query(`SELECT id, safe, price, wide, payload FROM ${table}`)
    const prepared = await adapter.query(`SELECT id, safe, price, wide, payload FROM ${table} WHERE safe = ?`, [42])

    expect(String(inserted.lastInsertId)).toBe('9007199254740993')
    expect(raw.rows).toEqual([{ id: '9007199254740993', safe: 42, price: '12.50', wide: '123456789012345678901234567890', payload: JSON.parse('{"big":9007199254740993}') as unknown }])
    expect(prepared.rows).toEqual(raw.rows)
  }, 30_000)

  it('returns exact text for a connection configured by URL', async () => {
    const { adapter, table } = await openNumbersTable({ url: connectionUrl() })
    await adapter.execute(`INSERT INTO ${table} (id, safe) VALUES (-9007199254740993, -42)`)

    const result = await adapter.query(`SELECT id, safe FROM ${table}`)

    expect(result.rows).toEqual([{ id: '-9007199254740993', safe: -42 }])
  }, 30_000)

  it('lets supportBigNumbers in the URL win over the default', async () => {
    const { adapter, table } = await openNumbersTable({ url: connectionUrl('?supportBigNumbers=false') })
    await adapter.execute(`INSERT INTO ${table} (id) VALUES (9007199254740993)`)

    const result = await adapter.query(`SELECT id FROM ${table}`)

    expect(result.rows).toEqual([{ id: 9007199254740992 }])
  }, 30_000)

  it('returns JSON as text when the URL sets jsonStrings', async () => {
    const { adapter, table } = await openNumbersTable({ url: connectionUrl('?jsonStrings=true') })
    await adapter.execute(`INSERT INTO ${table} (payload) VALUES (CAST('{"big":9007199254740993}' AS JSON))`)

    const result = await adapter.query(`SELECT payload FROM ${table}`)

    expect(result.rows).toEqual([{ payload: '{"big": 9007199254740993}' }])
  }, 30_000)
})
