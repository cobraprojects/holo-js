import { describe, expect, it, onTestFinished } from 'vitest'
import { createMySQLAdapter } from '../src'
import { mysqlTestConnection } from '../../../tests/support/real-database'

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql bindings', () => {
  it('binds undefined as NULL in statements with bindings, as the query path always did', async () => {
    const adapter = createMySQLAdapter({ config: mysqlTestConnection() })
    onTestFinished(() => adapter.disconnect())
    expect((await adapter.query<{ value: unknown }>('SELECT ? AS value', [undefined])).rows).toEqual([{ value: null }])
    expect((await adapter.query<{ value: unknown }>('SELECT ? AS value', ['kept'])).rows).toEqual([{ value: 'kept' }])
  })
})
