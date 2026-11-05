import { describe, expect, it, onTestFinished } from 'vitest'
import { createMySQLAdapter } from '../src'
import { mysqlTestConnection } from '../../../tests/support/real-database'

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql prepared statement cache', () => {
  it('bounds the prepared statements a connection keeps, so distinct IN list sizes cannot exhaust the server', async () => {
    const adapter = createMySQLAdapter({ config: { ...mysqlTestConnection(), connectionLimit: 1 } })
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
