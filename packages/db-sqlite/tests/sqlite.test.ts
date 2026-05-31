import { describe, expect, it } from 'vitest'
import {
  createDatabase,
  createDialect,
  createMigrationService,
  defineMigration,
} from '@holo-js/db'
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

  it('reports SQLite open failures with the configured database path', async () => {
    const adapter = createSQLiteAdapter({
      filename: '/tmp/missing/database.sqlite',
      createDatabase() {
        throw new Error('cannot open database file')
      },
    })

    await expect(adapter.initialize()).rejects.toThrow(
      'Unable to open SQLite database "/tmp/missing/database.sqlite": cannot open database file',
    )
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

  it('runs migration tracking against a real in-memory SQLite database', async () => {
    const adapter = createSQLiteAdapter()
    const migration = defineMigration({
      name: '2026_05_31_000001_create_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
          table.string('email')
          table.timestamp('created_at').nullable()
        })
      },
      async down({ schema }) {
        await schema.dropTable('users')
      },
    })
    const db = createDatabase({
      connectionName: 'main',
      adapter,
      dialect: createDialect('sqlite'),
    })
    const migrator = createMigrationService(db, [migration])

    try {
      await expect(migrator.migrate()).resolves.toEqual([migration])

      const tracked = await adapter.query<{ name: string }>(
        'select name from "_holo_migrations" where name = ?',
        [migration.name],
      )

      expect(tracked.rows).toEqual([{ name: migration.name }])
    } finally {
      await adapter.disconnect()
    }
  })
})
