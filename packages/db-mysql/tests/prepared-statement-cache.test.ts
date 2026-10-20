import { describe, expect, it, onTestFinished } from 'vitest'
import { createMySQLAdapter } from '../src'

const liveMySQLConfig = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD ?? '',
  database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
}

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql prepared statement cache', () => {
  it('bounds the prepared statements a connection keeps, so distinct IN list sizes cannot exhaust the server', async () => {
    const adapter = createMySQLAdapter({ config: { ...liveMySQLConfig, connectionLimit: 1 } })
    onTestFinished(() => adapter.disconnect())
    const statusOf = async () => Number((await adapter.query<{ Value: string }>('SHOW GLOBAL STATUS LIKE \'Prepared_stmt_count\'')).rows[0]!.Value)
    const before = await statusOf()

    for (let size = 1; size <= 600; size += 1) {
      await adapter.query(
        `SELECT 1 AS found WHERE 1 IN (${Array.from({ length: size }, () => '?').join(', ')})`,
        Array.from({ length: size }, (_, index) => index),
      )
    }

    expect(await statusOf() - before).toBeLessThan(400)
  }, 60_000)
})
