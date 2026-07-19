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
    await adapter.beginTransaction({ mode: 'immediate' })
    await adapter.beginTransaction({ mode: 'exclusive' })
    await expect(adapter.beginTransaction({ mode: 'invalid' as never })).rejects.toThrow('Unsupported SQLite transaction mode "invalid".')
    await adapter.createSavepoint?.('nested')
    await expect(adapter.createSavepoint?.('not-valid;')).rejects.toThrow('Invalid savepoint name "not-valid;".')
    await adapter.rollbackToSavepoint?.('nested')
    await adapter.releaseSavepoint?.('nested')
    await adapter.rollback()
    await adapter.commit()

    expect(executed).toEqual([
      'BEGIN',
      'BEGIN IMMEDIATE',
      'BEGIN EXCLUSIVE',
      'SAVEPOINT nested',
      'ROLLBACK TO SAVEPOINT nested',
      'RELEASE SAVEPOINT nested',
      'ROLLBACK',
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

  it('rebuilds SQLite tables for column changes without losing data, indexes, triggers, or foreign keys', async () => {
    const adapter = createSQLiteAdapter()
    const createTables = defineMigration({
      name: '2026_05_31_000001_create_accounts',
      async up({ schema }) {
        await schema.createTable('accounts', (table) => {
          table.id()
          table.string('email').unique()
        })
        await schema.createTable('profiles', (table) => {
          table.id()
          table.foreignId('account_id').constrained('accounts')
        })
        await schema.createTable('account_audit', (table) => {
          table.id()
          table.string('email')
        })
      },
    })
    const changeEmail = defineMigration({
      name: '2026_05_31_000002_change_account_email',
      async up({ schema }) {
        await schema.table('accounts', (table) => {
          table.string('email').nullable().default('unknown').change()
        })
      },
    })
    const db = createDatabase({
      connectionName: 'main',
      adapter,
      dialect: createDialect('sqlite'),
    })
    const migrator = createMigrationService(db, [createTables])

    try {
      await adapter.execute('PRAGMA foreign_keys = ON')
      await migrator.migrate()
      await adapter.execute('INSERT INTO accounts (id, email) VALUES (?, ?)', [1, 'ava@example.com'])
      await adapter.execute('INSERT INTO profiles (id, account_id) VALUES (?, ?)', [1, 1])
      await adapter.execute('CREATE INDEX accounts_email_lookup ON accounts (email)')
      await adapter.execute(`CREATE TRIGGER accounts_audit_insert AFTER INSERT ON accounts
        BEGIN INSERT INTO account_audit (email) VALUES (NEW.email); END`)

      migrator.register(changeEmail)
      await expect(migrator.migrate()).resolves.toEqual([changeEmail])

      const accounts = await adapter.query<{ id: number, email: string | null }>('SELECT id, email FROM accounts ORDER BY id')
      const profiles = await adapter.query<{ id: number, account_id: number }>('SELECT id, account_id FROM profiles ORDER BY id')
      const columns = await adapter.query<{ name: string, notnull: number, dflt_value: string | null }>('PRAGMA table_info("accounts")')
      const indexes = await adapter.query<{ name: string }>('PRAGMA index_list("accounts")')
      const triggers = await adapter.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'accounts'")
      const violations = await adapter.query('PRAGMA foreign_key_check')
      const foreignKeyState = await adapter.query<{ foreign_keys: number }>('PRAGMA foreign_keys')

      expect(accounts.rows).toEqual([{ id: 1, email: 'ava@example.com' }])
      expect(profiles.rows).toEqual([{ id: 1, account_id: 1 }])
      expect(columns.rows.find(column => column.name === 'email')).toMatchObject({
        notnull: 0,
        dflt_value: "'unknown'",
      })
      expect(indexes.rows.map(index => index.name)).toContain('accounts_email_lookup')
      expect(triggers.rows).toEqual([{ name: 'accounts_audit_insert' }])
      expect(violations.rows).toEqual([])
      expect(foreignKeyState.rows).toEqual([{ foreign_keys: 1 }])

      await adapter.execute('INSERT INTO accounts (id, email) VALUES (?, ?)', [2, 'new@example.com'])
      const audit = await adapter.query<{ email: string }>('SELECT email FROM account_audit ORDER BY id')
      expect(audit.rows).toEqual([{ email: 'new@example.com' }])
    } finally {
      await adapter.disconnect()
    }
  })
})
