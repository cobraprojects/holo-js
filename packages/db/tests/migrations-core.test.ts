import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  ConfigurationError, DatabaseError, HydrationError, TableQueryBuilder,
  createDatabase, createDialect, createMigrationService, createSchemaService, defineMigration,
  type DatabaseContext, type DatabaseLogger,
} from '../src'

const connections: DatabaseContext[] = []

function createConnection(logger?: DatabaseLogger): DatabaseContext {
  const db = createDatabase({ adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite'), logger })
  connections.push(db)
  return db
}

function tableMigration(name: string, tableName: string) {
  return defineMigration({
    name,
    async up({ schema }) {
      await schema.createTable(tableName, table => {
        table.id()
        table.string('value')
      })
    },
    async down({ schema }) {
      await schema.dropTable(tableName)
    },
  })
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.disconnect()))
})

describe('native migration workflows', () => {
  it('orders migrations, tracks batches, skips completed work, and rolls back selected batches', async () => {
    const db = createConnection()
    const schema = createSchemaService(db)
    const first = tableMigration('2026_01_01_000001_first', 'first_records')
    const second = tableMigration('2026_01_01_000002_second', 'second_records')
    const migrator = createMigrationService(db, [second, first])
    expect(await migrator.status()).toEqual([
      { name: first.name, status: 'pending' },
      { name: second.name, status: 'pending' },
    ])
    expect((await migrator.migrate({ step: 1 })).map(migration => migration.name)).toEqual([first.name])
    expect(await schema.hasTable('first_records')).toBe(true)
    expect(await schema.hasTable('second_records')).toBe(false)
    await migrator.migrate()
    await expect(migrator.migrate()).resolves.toEqual([])
    expect(await migrator.status()).toEqual([
      expect.objectContaining({ name: first.name, status: 'ran', batch: 1, migratedAt: expect.any(Date) }),
      expect.objectContaining({ name: second.name, status: 'ran', batch: 2, migratedAt: expect.any(Date) }),
    ])
    expect(await migrator.planSquash('initial schema')).toEqual({
      archiveName: 'initial_schema', includedMigrations: [first.name, second.name], fromBatch: 1, toBatch: 2, ranCount: 2,
    })
    await expect(migrator.rollback({ batch: 99 })).resolves.toEqual([])
    expect((await migrator.rollback({ batch: 1 })).map(migration => migration.name)).toEqual([first.name])
    expect(await schema.hasTable('first_records')).toBe(false)
    expect(await schema.hasTable('second_records')).toBe(true)
    expect(await migrator.hasRan(first.name!)).toBe(false)
    expect(await migrator.hasRan(second.name!)).toBe(true)
    await migrator.rollback({ step: 1 })
    expect(await schema.hasTable('second_records')).toBe(false)
  })

  it('rolls back schema and data when a migration fails and permits retry', async () => {
    const db = createConnection()
    const schema = createSchemaService(db)
    let abort = true
    const migration = defineMigration({
      name: '2026_01_01_000001_atomic',
      async up({ schema, db }) {
        await schema.createTable('atomic_records', table => {
          table.id()
          table.string('value')
        })
        await new TableQueryBuilder('atomic_records', db).insert({ value: 'persisted only on success' })
        if (abort) throw new Error('migration aborted')
      },
    })
    const migrator = createMigrationService(db, [migration])
    await expect(migrator.migrate()).rejects.toThrow('migration aborted')
    expect(await schema.hasTable('atomic_records')).toBe(false)
    expect(await migrator.hasRan(migration.name!)).toBe(false)
    abort = false
    await migrator.migrate()
    expect(await new TableQueryBuilder('atomic_records', db).get()).toEqual([{ id: 1, value: 'persisted only on success' }])
    expect(await migrator.hasRan(migration.name!)).toBe(true)
  })

  it('preserves tracking and data when rollback fails', async () => {
    const db = createConnection()
    const migration = defineMigration({
      name: '2026_01_01_000001_rollback_failure',
      async up({ schema, db }) {
        await schema.createTable('retained_records', table => { table.string('value') })
        await new TableQueryBuilder('retained_records', db).insert({ value: 'retained' })
      },
      async down({ db }) {
        await new TableQueryBuilder('retained_records', db).delete()
        throw new Error('rollback aborted')
      },
    })
    const migrator = createMigrationService(db, [migration])
    await migrator.migrate()
    await expect(migrator.rollback()).rejects.toThrow('rollback aborted')
    expect(await migrator.hasRan(migration.name!)).toBe(true)
    expect(await new TableQueryBuilder('retained_records', db).get()).toEqual([{ value: 'retained' }])
  })

  it('preserves unavailable migrations and supports migrations without down handlers', async () => {
    const db = createConnection()
    const migration = tableMigration('2026_01_01_000001_available', 'available_records')
    const irreversible = defineMigration({
      name: '2026_01_01_000002_irreversible',
      async up({ schema }) { await schema.createTable('irreversible_records', table => { table.id() }) },
    })
    const migrator = createMigrationService(db, [migration, irreversible])
    await migrator.migrate()
    await new TableQueryBuilder('_holo_migrations', db).insert({
      name: '2026_01_01_000003_unavailable', batch: 1, migrated_at: new Date().toISOString(),
    })
    await expect(migrator.rollback({ step: 1 })).resolves.toEqual([])
    expect((await migrator.rollback({ step: 2 })).map(migration => migration.name)).toEqual([irreversible.name])
    expect(await createSchemaService(db).hasTable('irreversible_records')).toBe(true)
    expect(await migrator.hasRan('2026_01_01_000003_unavailable')).toBe(true)
    expect(await migrator.hasRan(migration.name!)).toBe(true)
  })

  it('rejects corrupted native tracking metadata and preserves database errors', async () => {
    const db = createConnection()
    const migration = tableMigration('2026_01_01_000001_valid', 'valid_records')
    const migrator = createMigrationService(db, [migration])
    await migrator.migrate()
    await new TableQueryBuilder('_holo_migrations', db).update({ migrated_at: 'not-a-date' })
    await expect(migrator.status()).rejects.toThrow(HydrationError)
    const broken = createConnection()
    await createSchemaService(broken).createTable('_holo_migrations', table => { table.string('incorrect_column') })
    await expect(createMigrationService(broken).migrate()).rejects.toThrow('no such column')
  })

  it('rejects duplicate registration and overlapping operations on the same native connection', async () => {
    const db = createConnection()
    const migration = defineMigration({
      name: '2026_01_01_000001_delayed',
      async up({ schema }) {
        await setTimeout(20)
        await schema.createTable('delayed_records', table => { table.id() })
      },
    })
    const migrator = createMigrationService(db, [migration])
    expect(() => migrator.register(migration)).toThrow(DatabaseError)
    expect(() => defineMigration({ name: 'invalid', async up() {} })).toThrow(ConfigurationError)
    expect(() => createMigrationService(db, [defineMigration({ async up() {} })])).toThrow('resolved migration name')
    const running = migrator.migrate()
    await expect(createMigrationService(db).rollback()).rejects.toThrow(DatabaseError)
    await running
    expect(await createSchemaService(db).hasTable('delayed_records')).toBe(true)
    await expect(migrator.planSquash(' ')).rejects.toThrow('non-empty string')
  })

  it('reports successful and failed migration lifecycles through configured logging', async () => {
    const starts: string[] = []
    const successes: string[] = []
    const failures: string[] = []
    const db = createConnection({
      onMigrationStart: entry => { starts.push(`${entry.action}:${entry.migrationName}`) },
      onMigrationSuccess: entry => { successes.push(`${entry.action}:${entry.migrationName}`) },
      onMigrationError: entry => { failures.push(`${entry.action}:${entry.migrationName}`) },
    })
    const migration = tableMigration('2026_01_01_000001_logged', 'logged_records')
    const migrator = createMigrationService(db, [migration])
    await migrator.migrate()
    await migrator.rollback()
    const failing = defineMigration({ name: '2026_01_01_000002_failure', async up() { throw new Error('failed') } })
    await expect(createMigrationService(db, [failing]).migrate()).rejects.toThrow('failed')
    expect(starts).toEqual([`up:${migration.name}`, `down:${migration.name}`, `up:${failing.name}`])
    expect(successes).toEqual([`up:${migration.name}`, `down:${migration.name}`])
    expect(failures).toEqual([`up:${failing.name}`])
  })
})
