import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { DriverAdapter } from '@holo-js/db'
import { createPostgresAdapter } from '../src'

const runLivePostgres = process.env.HOLO_POSTGRES_INTEGRATION === '1' ? it : it.skip

describe('@holo-js/db-postgres', () => {
  it('supports direct clients without creating a pool', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'insert into logs values ($1) returning id') {
        return {
          rows: [{ id: 9 }],
          rowCount: 1,
        }
      }

      return {
        rows: [{ sql }],
        rowCount: 1,
      }
    })
    const adapter = createPostgresAdapter({
      client: {
        query,
        end: vi.fn(async () => {}),
      },
    })
    const canonicalAdapter: DriverAdapter = adapter

    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ sql: 'select 1' }],
      rowCount: 1,
    })
    await expect(adapter.execute('insert into logs values ($1) returning id', ['value'])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 9,
    })

    await adapter.beginTransaction()
    await adapter.commit()
    expect(query).toHaveBeenNthCalledWith(3, 'BEGIN')
    expect(query).toHaveBeenNthCalledWith(4, 'COMMIT')
    void canonicalAdapter
  })

  runLivePostgres('runs queries against a local Postgres server through the public adapter', async () => {
    const tableName = `holo_real_usage_postgres_${randomUUID().replaceAll('-', '_')}`
    const adapter = createPostgresAdapter({
      config: {
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        database: 'postgres',
      },
    })

    try {
      await adapter.execute(`create table ${tableName} (id serial primary key, name text not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values ($1) returning id`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = $1`,
        [inserted.lastInsertId],
      )

      expect(inserted.affectedRows).toBe(1)
      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.execute(`drop table if exists ${tableName}`)
      await adapter.disconnect()
    }
  }, 30_000)
})
