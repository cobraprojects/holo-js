import { describe, expect, it, onTestFinished } from 'vitest'
import { mysqlDatabaseDriverFactory } from '../src'

const liveMySQLHost = process.env.HOLO_MYSQL_HOST ?? '127.0.0.1'
const liveMySQLPort = Number(process.env.HOLO_MYSQL_PORT ?? 3306)
const liveMySQLUser = process.env.HOLO_MYSQL_USER ?? 'root'
const liveMySQLPassword = process.env.HOLO_MYSQL_PASSWORD ?? ''
const liveMySQLDatabase = process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
const liveMySQLUrl = `mysql://${encodeURIComponent(liveMySQLUser)}:${encodeURIComponent(liveMySQLPassword)}@${liveMySQLHost}:${liveMySQLPort}/${encodeURIComponent(liveMySQLDatabase)}`

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql connection options against a live server', () => {
  it('verifies the server certificate when ssl is true for a URL', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl, ssl: true })
    onTestFinished(() => adapter.disconnect())

    await expect(adapter.query('SHOW STATUS LIKE \'Ssl_cipher\'')).rejects.toThrow(/certificate/)
  }, 30_000)

  it('negotiates TLS when a URL and ssl are configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl, ssl: { rejectUnauthorized: false } })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('lets the URL ssl parameter win over a stricter configured ssl object', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: `${liveMySQLUrl}?ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}`, ssl: { rejectUnauthorized: true } })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('negotiates TLS from an ssl parameter in the URL alone', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: `${liveMySQLUrl}?ssl=${encodeURIComponent('{"rejectUnauthorized":false}')}` })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).not.toBe('')
  }, 30_000)

  it('keeps a URL without ssl on a plaintext connection', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl })
    onTestFinished(() => adapter.disconnect())

    const result = await adapter.query<{ Value: string }>('SHOW STATUS LIKE \'Ssl_cipher\'')

    expect(result.rows[0]?.Value).toBe('')
  }, 30_000)
})
