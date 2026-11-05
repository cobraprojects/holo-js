import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DatabaseError,
  TableQueryBuilder,
  createDatabase,
  createDialect,
  createMigrationService,
  defineMigration,
} from '@holo-js/db'
import { createSQLiteAdapter } from '../src'

describe('@holo-js/db-sqlite', () => {
  it('completes concurrent write transactions from separate connections to the same file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-writers-'))
    const filename = join(directory, 'database.sqlite')
    const adapters = [createSQLiteAdapter({ filename }), createSQLiteAdapter({ filename })]
    const connections = adapters.map(adapter => createDatabase({ adapter, dialect: createDialect('sqlite') }))
    try {
      await adapters[0]!.ensureDatabaseExists()
      await adapters[0]!.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)')
      await Promise.all([
        ...connections.map((connection, index) => connection.writeTransaction(async tx => {
          await new TableQueryBuilder('records', tx).insert({ id: index + 1 })
          await new Promise(resolve => setTimeout(resolve, 10))
        })),
        adapters[1]!.execute('INSERT INTO records VALUES (?)', [3]),
      ])
      expect((await adapters[0]!.query('SELECT id FROM records ORDER BY id')).rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    } finally {
      await Promise.all(adapters.map(adapter => adapter.disconnect()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it('commits writes while another native connection holds a read snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-concurrency-'))
    const filename = join(directory, 'database.sqlite')
    const reader = createSQLiteAdapter({ filename })
    const writer = createSQLiteAdapter({ filename })
    try {
      await writer.ensureDatabaseExists()
      await writer.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
      await writer.execute('INSERT INTO records VALUES (?, ?)', [1, 'before'])
      await reader.beginTransaction()
      expect((await reader.query('SELECT value FROM records')).rows).toEqual([{ value: 'before' }])
      await writer.beginTransaction({ mode: 'immediate' })
      await writer.execute('UPDATE records SET value = ? WHERE id = ?', ['after', 1])
      await expect(writer.commit()).resolves.toBeUndefined()
      expect((await reader.query('SELECT value FROM records')).rows).toEqual([{ value: 'before' }])
      await reader.commit()
      expect((await reader.query('SELECT value FROM records')).rows).toEqual([{ value: 'after' }])
    } finally {
      await Promise.all([reader.disconnect(), writer.disconnect()])
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it('converts stored UTC datetime text to app-timezone wall-clock text on injected and opened databases', async () => {
    const adapters = [createSQLiteAdapter({ database: new Database(':memory:') }), createSQLiteAdapter({ filename: ':memory:' })]
    for (const adapter of adapters) {
      try {
        await adapter.execute('CREATE TABLE events (at TEXT)')
        await adapter.execute('INSERT INTO events (at) VALUES (?), (?), (NULL)', ['2026-11-04 20:30:00', '2026-12-31 16:00:00.5'])
        expect((await adapter.query(
          'SELECT holo_wall_clock((julianday(at) - 2440587.5) * 86400000.0, ?) AS local FROM events',
          ['Asia/Tokyo'],
        )).rows).toEqual([{ local: '2026-11-05 05:30:00.000' }, { local: '2027-01-01 01:00:00.500' }, { local: null }])
      } finally {
        await adapter.disconnect()
      }
    }
  })

  it('names the function() requirement when an injected database cannot register holo_wall_clock', async () => {
    const real = new Database(':memory:')
    const adapter = createSQLiteAdapter({ database: { prepare: sql => real.prepare(sql), exec: sql => real.exec(sql), close: () => real.close() } })
    try {
      await adapter.execute('CREATE TABLE events (at TEXT)')
      await expect(adapter.query('SELECT holo_wall_clock((julianday(at) - 2440587.5) * 86400000.0, ?) AS local FROM events', ['Asia/Tokyo']))
        .rejects.toMatchObject({ code: 'CAPABILITY_ERROR', message: expect.stringContaining('function()') })
      await expect(adapter.query('SELECT at FROM events')).resolves.toMatchObject({ rows: [] })
    } finally {
      await adapter.disconnect()
    }
  })

  it('uses a real injected database for bound writes and rollback in each transaction mode', async () => {
    const adapter = createSQLiteAdapter({ database: new Database(':memory:') })
    try {
      await adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
      for (const mode of ['deferred', 'immediate', 'exclusive'] as const) {
        await adapter.beginTransaction({ mode })
        await adapter.execute('INSERT INTO records (value) VALUES (?)', ["a'; DROP TABLE records; --"])
        await adapter.createSavepoint('nested')
        await adapter.execute('DELETE FROM records')
        await adapter.rollbackToSavepoint('nested')
        await adapter.releaseSavepoint('nested')
        expect((await adapter.query('SELECT value FROM records')).rows).toEqual([{ value: "a'; DROP TABLE records; --" }])
        await adapter.rollback()
        expect((await adapter.query('SELECT * FROM records')).rows).toEqual([])
      }
      await expect(adapter.createSavepoint('not-valid;')).rejects.toThrow('Invalid savepoint name')
    } finally {
      await adapter.disconnect()
    }
  })

  it('opens a missing database lazily and fails the first query without creating the file or directory', async () => {
    const directory = join(tmpdir(), `holo-missing-${randomUUID()}`)
    const filename = join(directory, 'database.sqlite')
    const adapter = createSQLiteAdapter({ filename })

    await expect(adapter.initialize()).resolves.toBeUndefined()
    await expect(adapter.query('SELECT 1')).rejects.toThrow(
      `Database file at path "${filename}" does not exist. Run "holo migrate" to create it.`,
    )
    expect(existsSync(directory)).toBe(false)
  })

  it('does not create a missing database file inside an existing directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-no-file-'))
    const filename = join(directory, 'database.sqlite')
    const adapter = createSQLiteAdapter({ filename })
    try {
      await adapter.initialize()
      await expect(adapter.execute('CREATE TABLE records (id INTEGER PRIMARY KEY)')).rejects.toThrow('does not exist')
      await expect(adapter.databaseExists()).resolves.toBe(false)
      expect(existsSync(filename)).toBe(false)
    } finally {
      await adapter.disconnect()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates a missing database file when migrations run', async () => {
    const directory = join(tmpdir(), `holo-sqlite-migrate-${randomUUID()}`)
    const filename = join(directory, 'database.sqlite')
    const adapter = createSQLiteAdapter({ filename })
    const db = createDatabase({ connectionName: 'main', adapter, dialect: createDialect('sqlite') })
    const migration = defineMigration({
      name: '2026_05_31_000001_create_records',
      async up({ schema }) {
        await schema.createTable('records', (table) => {
          table.id()
        })
      },
    })
    try {
      await expect(createMigrationService(db, [migration]).migrate()).resolves.toEqual([migration])
      expect(existsSync(filename)).toBe(true)
      expect((await adapter.query('SELECT name FROM "_holo_migrations"')).rows).toEqual([{ name: migration.name }])
    } finally {
      await adapter.disconnect()
      await rm(directory, { recursive: true, force: true })
    }
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

  it('reports migration foreign-key violations as database errors', async () => {
    const adapter = createSQLiteAdapter()

    try {
      await adapter.execute('PRAGMA foreign_keys = OFF')
      await adapter.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
      await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))')
      await adapter.execute('INSERT INTO children (id, parent_id) VALUES (?, ?)', [1, 999])

      const error = await adapter.validateMigrationTransaction().catch(error => error)
      expect(error).toBeInstanceOf(DatabaseError)
      expect(error).toMatchObject({
        code: 'SQLITE_MIGRATION_FOREIGN_KEY_VIOLATION',
        message: 'SQLite migration left 1 foreign key violation.',
      })
    } finally {
      await adapter.disconnect()
    }
  })

  it.each([false, true])('preserves allocated identifiers during column changes when the table is empty: %s', async (empty) => {
    const adapter = createSQLiteAdapter()
    const db = createDatabase({ connectionName: 'main', adapter, dialect: createDialect('sqlite') })
    const createTable = defineMigration({
      name: '2026_10_11_000001_create_items',
      async up({ schema }) {
        await schema.createTable('items', (table) => {
          table.id()
          table.string('name')
        })
      },
    })
    const changeName = defineMigration({
      name: '2026_10_11_000002_change_item_name',
      async up({ schema }) {
        await schema.table('items', (table) => {
          table.string('name').nullable().change()
        })
      },
    })
    const migrator = createMigrationService(db, [createTable])
    const items = new TableQueryBuilder('items', db)
    try {
      await migrator.migrate()
      await items.insert([{ id: 1, name: 'kept' }, { id: 100, name: 'removed' }])
      await (empty ? items : items.where('id', 100)).delete()
      migrator.register(changeName)
      await migrator.migrate()
      await items.insert({ name: 'new' })
      expect(await items.where('name', 'new').value('id')).toBe(101)
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
