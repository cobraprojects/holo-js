import { describe, expect, it, vi } from 'vitest'
import {
  ConfigurationError,
  DatabaseError,
  HydrationError,
  column,
  createDatabase,
  createMigrationService,
  defineMigration,
  type DatabaseLogger,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { assertMigrationName } from '../src/migrations/defineMigration'

type MigrationRecord = {
  id: number
  name: string
  batch: number
  migrated_at: string | Date
}

type MigrationState = {
  tables: string[]
  records: MigrationRecord[]
}

class MigrationAdapter implements DriverAdapter {
  connected = false
  readonly executed: Array<{ sql: string, bindings: readonly unknown[] }> = []
  readonly queried: Array<{ sql: string, bindings: readonly unknown[] }> = []
  private snapshots: MigrationState[] = []

  constructor(readonly state: MigrationState) {}

  async initialize(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  async query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    this.queried.push({ sql, bindings })

    if (sql.includes('sqlite_master')) {
      return {
        rows: this.state.tables.map(name => ({ name })) as unknown as TRow[],
        rowCount: this.state.tables.length }
    }

    if (sql === 'SELECT * FROM "_holo_migrations" ORDER BY "batch" ASC, "id" ASC') {
      return {
        rows: [...this.state.records].sort((left, right) => (
          left.batch - right.batch || left.id - right.id
        )) as unknown as TRow[],
        rowCount: this.state.records.length }
    }

    return { rows: [] as TRow[], rowCount: 0 }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    this.executed.push({ sql, bindings })

    const createTable = sql.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/)
    if (createTable) {
      if (!this.state.tables.includes(createTable[1]!)) {
        this.state.tables.push(createTable[1]!)
      }
      return { affectedRows: 1 }
    }

    const dropTable = sql.match(/^DROP TABLE IF EXISTS "([^"]+)"/)
    if (dropTable) {
      this.state.tables = this.state.tables.filter(name => name !== dropTable[1]!)
      return { affectedRows: 1 }
    }

    if (sql === 'INSERT INTO "_holo_migrations" ("name", "batch", "migrated_at") VALUES (?1, ?2, ?3)') {
      this.state.records.push({
        id: this.state.records.length + 1,
        name: String(bindings[0]),
        batch: Number(bindings[1]),
        migrated_at: String(bindings[2]) })
      return { affectedRows: 1, lastInsertId: this.state.records.length }
    }

    if (sql === 'DELETE FROM "_holo_migrations" WHERE "name" = ?1') {
      const before = this.state.records.length
      this.state.records = this.state.records.filter(record => record.name !== bindings[0])
      return { affectedRows: before - this.state.records.length }
    }

    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {
    this.snapshots.push({
      tables: [...this.state.tables],
      records: this.state.records.map(record => ({ ...record })) })
  }

  async commit(): Promise<void> {
    this.snapshots.pop()
  }

  async rollback(): Promise<void> {
    const snapshot = this.snapshots.pop()
    if (!snapshot) {
      return
    }

    this.state.tables = [...snapshot.tables]
    this.state.records = snapshot.records.map(record => ({ ...record }))
  }
}

function createDialect(): Dialect {
  return {
    name: 'sqlite',
    capabilities: {
      returning: false,
      savepoints: false,
      concurrentQueries: true,
      workerThreadExecution: false,
      lockForUpdate: false,
      sharedLock: false,
      jsonValueQuery: true,
      jsonContains: false,
      jsonLength: false,
      schemaQualifiedIdentifiers: false,
      nativeUpsert: false,
      ddlAlterSupport: false,
      introspection: true },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return `?${index}`
    } }
}

describe('migration service slice', () => {
  it('registers migrations, reports status, migrates in order, and rolls back the latest batch', async () => {
    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const createUsers = defineMigration({
      name: '2026_01_01_000001_create_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
          table.string('name')
        })
      },
      async down({ schema }) {
        await schema.dropTable('users')
      } })
    const createPosts = defineMigration({
      name: '2026_01_01_000002_create_posts',
      async up({ schema }) {
        await schema.createTable('posts', (table) => {
          table.id()
          table.string('title')
        })
      },
      async down({ schema }) {
        await schema.dropTable('posts')
      } })

    const migrator = createMigrationService(db, [createUsers, createPosts])

    expect(migrator.getMigrations().map(migration => migration.name)).toEqual([
      createUsers.name,
      createPosts.name,
    ])
    expect(migrator.getMigration(createUsers.name)).toBe(createUsers)
    expect(await migrator.hasRan(createUsers.name)).toBe(false)
    expect(await migrator.status()).toEqual([
      { name: createUsers.name, status: 'pending' },
      { name: createPosts.name, status: 'pending' },
    ])

    const ranFirst = await migrator.migrate({ step: 1 })
    expect(ranFirst.map(migration => migration.name)).toEqual([createUsers.name])
    expect(adapter.state.tables).toContain('_holo_migrations')
    expect(adapter.state.tables).toContain('users')
    expect(adapter.state.tables).not.toContain('posts')
    expect(await migrator.hasRan(createUsers.name)).toBe(true)
    expect((await migrator.status())[0]).toMatchObject({
      name: createUsers.name,
      status: 'ran',
      batch: 1 })

    const ranSecond = await migrator.migrate()
    expect(ranSecond.map(migration => migration.name)).toEqual([createPosts.name])
    expect(adapter.state.tables).toContain('posts')
    expect(adapter.state.records).toHaveLength(2)
    expect((await migrator.migrate())).toEqual([])

    const rolledBack = await migrator.rollback()
    expect(rolledBack.map(migration => migration.name)).toEqual([createPosts.name])
    expect(adapter.state.tables).toContain('users')
    expect(adapter.state.tables).not.toContain('posts')
    expect(adapter.state.records).toHaveLength(1)

    adapter.state.records[0]!.migrated_at = new Date()
    await expect(migrator.status()).resolves.toEqual([
      expect.objectContaining({
        name: createUsers.name,
        status: 'ran',
        batch: 1,
        migratedAt: expect.any(Date) }),
      expect.objectContaining({
        name: createPosts.name,
        status: 'pending' }),
    ])
  })

  it('builds deterministic squash plans for ran migrations and rejects empty archive names', async () => {
    const adapter = new MigrationAdapter({
      tables: ['_holo_migrations'],
      records: [
        {
          id: 1,
          name: '2026_01_01_000001_create_users',
          batch: 1,
          migrated_at: '2026-01-01T00:00:00.000Z' },
        {
          id: 2,
          name: '2026_01_01_000002_create_posts',
          batch: 3,
          migrated_at: '2026-01-02T00:00:00.000Z' },
      ] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })
    const migrator = createMigrationService(db)

    await expect(migrator.planSquash('  initial schema archive  ')).resolves.toEqual({
      archiveName: 'initial_schema_archive',
      includedMigrations: [
        '2026_01_01_000001_create_users',
        '2026_01_01_000002_create_posts',
      ],
      fromBatch: 1,
      toBatch: 3,
      ranCount: 2 })
    await expect(migrator.planSquash()).resolves.toEqual({
      archiveName: 'schema',
      includedMigrations: [
        '2026_01_01_000001_create_users',
        '2026_01_01_000002_create_posts',
      ],
      fromBatch: 1,
      toBatch: 3,
      ranCount: 2 })
    await expect(migrator.planSquash('   ')).rejects.toThrow(
      'Migration squash archive name must be a non-empty string.',
    )

    const emptyMigrator = createMigrationService(createDatabase({
      connectionName: 'default',
      adapter: new MigrationAdapter({
        tables: [],
        records: [] }),
      dialect: createDialect() }))
    await expect(emptyMigrator.planSquash('initial')).resolves.toEqual({
      archiveName: 'initial',
      includedMigrations: [],
      fromBatch: undefined,
      toBatch: undefined,
      ranCount: 0 })
  })

  it('supports rollback step limits, missing registered migrations, and migrations without down handlers', async () => {
    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const createAlpha = defineMigration({
      name: '2026_01_01_000001_alpha',
      async up({ schema }) {
        await schema.createTable('alpha', (table) => {
          table.id()
        })
      },
      async down({ schema }) {
        await schema.dropTable('alpha')
      } })
    const createBeta = defineMigration({
      name: '2026_01_01_000002_beta',
      async up({ schema }) {
        await schema.createTable('beta', (table) => {
          table.id()
        })
      } })

    const migrator = createMigrationService(db)
    migrator.register(createAlpha).register(createBeta)

    await migrator.migrate({ step: 1 })
    await migrator.migrate()
    adapter.state.records.push({
      id: 99,
      name: '2026_01_01_000003_ghost',
      batch: 2,
      migrated_at: new Date() })

    const rolledBack = await migrator.rollback({ step: 2 })
    expect(rolledBack.map(migration => migration.name)).toEqual(['2026_01_01_000002_beta'])
    expect(adapter.state.tables).toContain('beta')
    expect(adapter.state.records.some(record => record.name === '2026_01_01_000003_ghost')).toBe(true)
    expect(adapter.state.records.some(record => record.name === '2026_01_01_000002_beta')).toBe(false)
  })

  it('fails closed when migration tracking contains malformed migrated_at timestamps', async () => {
    const adapter = new MigrationAdapter({
      tables: ['_holo_migrations'],
      records: [{
        id: 1,
        name: '2026_01_01_000001_alpha',
        batch: 1,
        migrated_at: 'not-a-date' }] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const migrator = createMigrationService(db)
    migrator.register(defineMigration({
      name: '2026_01_01_000001_alpha',
      async up() {} }))

    await expect(migrator.status()).rejects.toThrow(
      'Migration tracking contains an invalid migrated-at timestamp.',
    )
  })

  it('supports rolling back an explicit batch', async () => {
    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const createAlpha = defineMigration({
      name: '2026_01_01_000001_alpha',
      async up({ schema }) {
        await schema.createTable('alpha', (table) => {
          table.id()
        })
      },
      async down({ schema }) {
        await schema.dropTable('alpha')
      } })
    const createBeta = defineMigration({
      name: '2026_01_01_000002_beta',
      async up({ schema }) {
        await schema.createTable('beta', (table) => {
          table.id()
        })
      },
      async down({ schema }) {
        await schema.dropTable('beta')
      } })

    const migrator = createMigrationService(db, [createAlpha, createBeta])
    await migrator.migrate({ step: 1 })
    await migrator.migrate()

    await expect(migrator.rollback({ batch: 99 })).resolves.toEqual([])

    const rolledBack = await migrator.rollback({ batch: 1 })
    expect(rolledBack.map(migration => migration.name)).toEqual(['2026_01_01_000001_alpha'])
    expect(adapter.state.tables).not.toContain('alpha')
    expect(adapter.state.tables).toContain('beta')
    expect(adapter.state.records.some(record => record.name === '2026_01_01_000001_alpha')).toBe(false)
    expect(adapter.state.records.some(record => record.name === '2026_01_01_000002_beta')).toBe(true)
  })

  it('rolls back failed migrations and rejects duplicates and invalid tracking metadata', async () => {
    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const failing = defineMigration({
      name: '2026_01_01_000001_failing',
      async up({ schema }) {
        await schema.createTable('temp', (table) => {
          table.id()
        })
        throw new Error('boom')
      },
      async down({ schema }) {
        await schema.dropTable('temp')
      } })

    const migrator = createMigrationService(db, [failing])
    await expect(migrator.migrate()).rejects.toThrow('boom')
    expect(adapter.state.tables).not.toContain('temp')
    expect(adapter.state.records).toEqual([])
    expect(await migrator.rollback()).toEqual([])

    expect(() => migrator.register(failing)).toThrow(DatabaseError)

    adapter.state.tables.push('_holo_migrations')
    adapter.state.records.push({
      id: 1,
      name: '2026_01_01_000001_failing',
      batch: 1,
      migrated_at: 'not-a-date' })
    await expect(migrator.status()).rejects.toThrow(HydrationError)
  })

  it('rejects invalid migration names, sorts migrations by name, and prevents overlapping runs', async () => {
    expect(() => defineMigration({
      async up() {} })).not.toThrow()

    expect(() => defineMigration({
      name: 'create_users',
      async up() {} })).toThrow(ConfigurationError)

    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })
    const namelessMigration = defineMigration({
      async up() {} })

    const executed: string[] = []
    let release = () => {}
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })

    const second = defineMigration({
      name: '2026_01_01_000002_second',
      async up() {
        executed.push('second')
      } })
    const first = defineMigration({
      name: '2026_01_01_000001_first',
      async up() {
        executed.push('first')
      } })
    const slow = defineMigration({
      name: '2026_01_01_000003_slow',
      async up() {
        await blocker
        executed.push('slow')
      } })

    const migrator = createMigrationService(db, [second, slow, first])

    expect(() => createMigrationService(db, [namelessMigration])).toThrow(
      'Migration registration requires a resolved migration name.',
    )
    expect(assertMigrationName('2026_01_01_000001_valid_name')).toBe('2026_01_01_000001_valid_name')
    expect(() => assertMigrationName('invalid_name')).toThrow(ConfigurationError)
    expect(migrator.getExecutionPolicy()).toEqual({
      mode: 'exclusive',
      scope: 'adapter',
      allowsConcurrentMigrations: false })
    expect(migrator.getMigrations().map(migration => migration.name)).toEqual([
      '2026_01_01_000001_first',
      '2026_01_01_000002_second',
      '2026_01_01_000003_slow',
    ])

    const running = migrator.migrate()
    await expect(migrator.rollback()).rejects.toThrow(DatabaseError)
    release()
    await expect(running).resolves.toHaveLength(3)
    expect(executed).toEqual(['first', 'second', 'slow'])
  })

  it('emits migration lifecycle logs for success and failure paths', async () => {
    const adapter = new MigrationAdapter({
      tables: [],
      records: [] })
    const logger: DatabaseLogger = {
      onMigrationStart: vi.fn(),
      onMigrationSuccess: vi.fn(),
      onMigrationError: vi.fn() }
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect(),
      logger })

    const createUsers = defineMigration({
      name: '2026_01_01_000001_create_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
        })
      },
      async down({ schema }) {
        await schema.dropTable('users')
      } })

    const failing = defineMigration({
      name: '2026_01_01_000002_failing_users',
      async up({ schema }) {
        await schema.createTable('users', (table) => {
          table.id()
        })
        throw new Error('boom')
      } })

    const migrator = createMigrationService(db, [createUsers])
    await migrator.migrate()
    await migrator.rollback()

    const failingMigrator = createMigrationService(db, [failing])
    await expect(failingMigrator.migrate()).rejects.toThrow('boom')

    expect(logger.onMigrationStart).toHaveBeenCalledWith(expect.objectContaining({
      connectionName: 'default',
      migrationName: '2026_01_01_000001_create_users',
      action: 'up',
      batch: 1 }))
    expect(logger.onMigrationStart).toHaveBeenCalledWith(expect.objectContaining({
      connectionName: 'default',
      migrationName: '2026_01_01_000001_create_users',
      action: 'down',
      batch: 1 }))
    expect(logger.onMigrationSuccess).toHaveBeenCalledWith(expect.objectContaining({
      migrationName: '2026_01_01_000001_create_users',
      action: 'up',
      durationMs: expect.any(Number) }))
    expect(logger.onMigrationSuccess).toHaveBeenCalledWith(expect.objectContaining({
      migrationName: '2026_01_01_000001_create_users',
      action: 'down',
      durationMs: expect.any(Number) }))
    expect(logger.onMigrationError).toHaveBeenCalledWith(expect.objectContaining({
      migrationName: '2026_01_01_000002_failing_users',
      action: 'up',
      durationMs: expect.any(Number),
      error: expect.any(Error) }))
  })

  it('emits migration error logs when rollback fails', async () => {
    const adapter = new MigrationAdapter({
      tables: ['_holo_migrations'],
      records: [{
        id: 1,
        name: '2026_01_01_000001_broken_down',
        batch: 1,
        migrated_at: new Date().toISOString() }] })
    const logger: DatabaseLogger = {
      onMigrationStart: vi.fn(),
      onMigrationSuccess: vi.fn(),
      onMigrationError: vi.fn() }
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect(),
      logger })

    const brokenDown = defineMigration({
      name: '2026_01_01_000001_broken_down',
      async up() {},
      async down() {
        throw new Error('down failed')
      } })

    const migrator = createMigrationService(db, [brokenDown])
    await expect(migrator.rollback()).rejects.toThrow('down failed')

    expect(logger.onMigrationStart).toHaveBeenCalledWith(expect.objectContaining({
      migrationName: '2026_01_01_000001_broken_down',
      action: 'down',
      batch: 1 }))
    expect(logger.onMigrationSuccess).not.toHaveBeenCalled()
    expect(logger.onMigrationError).toHaveBeenCalledWith(expect.objectContaining({
      migrationName: '2026_01_01_000001_broken_down',
      action: 'down',
      durationMs: expect.any(Number),
      error: expect.any(Error) }))
  })
})
