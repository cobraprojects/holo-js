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
})
