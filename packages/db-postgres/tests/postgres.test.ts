import { describe, expect, it, vi } from 'vitest'
import { createPostgresAdapter } from '../src'

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
  })
})
