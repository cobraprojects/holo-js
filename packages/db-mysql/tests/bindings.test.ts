import { describe, expect, it, onTestFinished } from 'vitest'
import { createMySQLAdapter } from '../src'

const liveMySQLConfig = {
  host: process.env.HOLO_MYSQL_HOST ?? '127.0.0.1',
  port: Number(process.env.HOLO_MYSQL_PORT ?? 3306),
  user: process.env.HOLO_MYSQL_USER ?? 'root',
  password: process.env.HOLO_MYSQL_PASSWORD ?? '',
  database: process.env.HOLO_MYSQL_DATABASE ?? 'mysql',
}

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('@holo-js/db-mysql bindings', () => {
  it('binds undefined as NULL in statements with bindings, as the query path always did', async () => {
    const adapter = createMySQLAdapter({ config: liveMySQLConfig })
    onTestFinished(() => adapter.disconnect())
    expect((await adapter.query<{ value: unknown }>('SELECT ? AS value', [undefined])).rows).toEqual([{ value: null }])
    expect((await adapter.query<{ value: unknown }>('SELECT ? AS value', ['kept'])).rows).toEqual([{ value: 'kept' }])
  })
})
