import { describe, expect, it } from 'vitest'
import { createSQLiteAdapter } from '../src'

describe('@holo-js/db-sqlite', () => {
  it('supports querying and transactions against an injected database', async () => {
    const executed: string[] = []
    const adapter = createSQLiteAdapter({
      database: {
        prepare(sql: string) {
          return {
            all(...bindings: readonly unknown[]) {
              return [{ sql, bindingsCount: bindings.length }]
            },
            run(...bindings: readonly unknown[]) {
              return {
                changes: bindings.length,
                lastInsertRowid: 7,
              }
            },
          }
        },
        exec(sql: string) {
          executed.push(sql)
        },
        close() {},
      },
    })

    await expect(adapter.query('select 1', [1])).resolves.toEqual({
      rows: [{ sql: 'select 1', bindingsCount: 1 }],
      rowCount: 1,
    })
    await expect(adapter.execute('insert into test values (?)', ['value'])).resolves.toEqual({
      affectedRows: 1,
      lastInsertId: 7,
    })

    await adapter.beginTransaction()
    await adapter.createSavepoint?.('nested')
    await adapter.rollbackToSavepoint?.('nested')
    await adapter.releaseSavepoint?.('nested')
    await adapter.commit()

    expect(executed).toEqual([
      'BEGIN',
      'SAVEPOINT nested',
      'ROLLBACK TO SAVEPOINT nested',
      'RELEASE SAVEPOINT nested',
      'COMMIT',
    ])
  })
})
