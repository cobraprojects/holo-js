import { describe, expect, it, onTestFinished } from 'vitest'
import { mysqlDatabaseDriverFactory } from '../src'
import { mysqlTestConnection, testConnectionUrl } from '../../../tests/support/real-database'

function liveMySQLUrl() {
  return testConnectionUrl('mysql', mysqlTestConnection()).toString()
}

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql connection options against a live server', () => {
  it('verifies the server certificate when ssl is true for a URL', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl(), ssl: true })
    onTestFinished(() => adapter.disconnect())

    await expect(adapter.query('SHOW STATUS LIKE \'Ssl_cipher\'')).rejects.toThrow(/certificate/)
  }, 30_000)

  it('negotiates TLS when a URL and ssl are configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl(), ssl: { rejectUnauthorized: false } })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('lets the URL ssl parameter win over a stricter configured ssl object', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: `${liveMySQLUrl()}?ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}`, ssl: { rejectUnauthorized: true } })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('negotiates TLS from an ssl parameter in the URL alone', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: `${liveMySQLUrl()}?ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}` })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('keeps a URL without ssl on a plaintext connection', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl() })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).toBe('')
  }, 30_000)
})
