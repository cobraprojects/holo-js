import { describe, expect, it, onTestFinished, vi } from 'vitest'
import mysql from 'mysql2/promise'
import { mysqlDatabaseDriverFactory } from '../src'

vi.mock('mysql2/promise', async (importOriginal) => {
  const actual = await importOriginal<{ default: typeof mysql }>()
  return {
    ...actual,
    default: { ...actual.default, createPool: vi.fn(actual.default.createPool) },
  }
})

const appUrl = 'mysql://root@127.0.0.1:3306/app'
const liveMySQLHost = process.env.HOLO_MYSQL_HOST ?? '127.0.0.1'
const liveMySQLPort = Number(process.env.HOLO_MYSQL_PORT ?? 3306)
const liveMySQLUser = process.env.HOLO_MYSQL_USER ?? 'root'
const liveMySQLPassword = process.env.HOLO_MYSQL_PASSWORD ?? ''
const liveMySQLDatabase = process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
const liveMySQLUrl = `mysql://${encodeURIComponent(liveMySQLUser)}:${encodeURIComponent(liveMySQLPassword)}@${liveMySQLHost}:${liveMySQLPort}/${encodeURIComponent(liveMySQLDatabase)}`

function lastPoolConfig(): Record<string, unknown> {
  const config = vi.mocked(mysql.createPool).mock.lastCall?.[0]
  if (!config) throw new Error('createPool was not called')
  return config as unknown as Record<string, unknown>
}

describe('@holo-js/db-mysql connection options', () => {
  it('passes ssl: true to the pool when a URL is configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: appUrl, ssl: true })
    onTestFinished(() => adapter.disconnect())

    await adapter.initialize()

    expect(lastPoolConfig()).toMatchObject({ uri: appUrl, ssl: {} })
  })

  it('passes a configured ssl object to the pool when a URL is configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: appUrl, ssl: { rejectUnauthorized: false } })
    onTestFinished(() => adapter.disconnect())

    await adapter.initialize()

    expect(lastPoolConfig()).toMatchObject({ uri: appUrl, ssl: { rejectUnauthorized: false } })
  })

  it('keeps the ssl parameter from a URL when ssl is false', async () => {
    const url = 'mysql://root@127.0.0.1:3306/app?ssl=Amazon%20RDS'
    const adapter = mysqlDatabaseDriverFactory.create({ url, ssl: false })
    onTestFinished(() => adapter.disconnect())

    await adapter.initialize()

    expect(lastPoolConfig()).toMatchObject({ uri: url, ssl: 'Amazon RDS' })
  })

  it('uses the ssl parameter from a URL when no ssl is configured', async () => {
    const url = 'mysql://root@127.0.0.1:3306/app?ssl=Amazon%20RDS'
    const adapter = mysqlDatabaseDriverFactory.create({ url })
    onTestFinished(() => adapter.disconnect())

    await adapter.initialize()

    expect(lastPoolConfig()).toMatchObject({ uri: url, ssl: 'Amazon RDS' })
  })

  it('leaves ssl unset for a URL without ssl configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: appUrl })
    onTestFinished(() => adapter.disconnect())

    await adapter.initialize()

    expect(lastPoolConfig()).toMatchObject({ uri: appUrl })
    expect(lastPoolConfig()).not.toHaveProperty('ssl')
  })
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql connection options against a live server', () => {
  it('negotiates TLS when a URL and ssl are configured', async () => {
    const adapter = mysqlDatabaseDriverFactory.create({ url: liveMySQLUrl, ssl: { rejectUnauthorized: false } })
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
