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

  it('runs queries against a real in-memory SQLite database through the public adapter', async () => {
    const adapter = createSQLiteAdapter()

    try {
      await adapter.execute('create table users (id integer primary key autoincrement, name text not null)')
      const inserted = await adapter.execute('insert into users (name) values (?)', ['real-user'])
      const selected = await adapter.query<{ name: string }>('select name from users where id = ?', [inserted.lastInsertId])

      expect(inserted.affectedRows).toBe(1)
      expect(selected.rows).toEqual([{ name: 'real-user' }])
    } finally {
      await adapter.disconnect()
    }
  })
})
