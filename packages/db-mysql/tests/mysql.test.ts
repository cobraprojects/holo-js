import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMySQLAdapter } from '../src'

describe('@holo-js/db-mysql', () => {
  it('supports direct clients without creating a pool', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'insert into logs values (?)') {
        return [{
          affectedRows: 1,
          insertId: 13,
        }, undefined] as const
      }

      return [[{ sql }], undefined] as const
    })
    const adapter = createMySQLAdapter({
      client: {
        query,
        end: vi.fn(async () => {}),
      },
    })

    await expect(adapter.query('select 1')).resolves.toEqual({
      rows: [{ sql: 'select 1' }],
      rowCount: 1,
    })
    await expect(adapter.execute('insert into logs values (?)', ['value'])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 13,
    })

    await adapter.beginTransaction()
    await adapter.rollback()
    expect(query).toHaveBeenNthCalledWith(3, 'START TRANSACTION', [])
    expect(query).toHaveBeenNthCalledWith(4, 'ROLLBACK', [])
  })

  it('runs queries against a local MySQL server through the public adapter', async () => {
    const tableName = `holo_real_usage_mysql_${randomUUID().replaceAll('-', '_')}`
    const adapter = createMySQLAdapter({
      config: {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        database: 'mysql',
      },
    })

    try {
      await adapter.execute(`create table ${tableName} (id int auto_increment primary key, name varchar(255) not null)`)
      const inserted = await adapter.execute(
        `insert into ${tableName} (name) values (?)`,
        ['real-user'],
      )
      const selected = await adapter.query<{ name: string }>(
        `select name from ${tableName} where id = ?`,
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
