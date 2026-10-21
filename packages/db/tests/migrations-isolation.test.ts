import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  createDatabase, createDialect, createMigrationService, defineMigration, TableQueryBuilder,
  type DatabaseContext, type MigrationDefinition,
} from '../src'

const connections: DatabaseContext[] = []
let directory: string
let filename: string

function connect(): DatabaseContext {
  const db = createDatabase({ adapter: createSQLiteAdapter({ filename }), dialect: createDialect('sqlite') })
  connections.push(db)
  return db
}

type LockRival = {
  owner: string
  staysHeld?: boolean
}

function connectWithLockRivals(rivals: LockRival[]): DatabaseContext {
  const db = connect()
  const executeCompiled = db.executeCompiled.bind(db)
  db.executeCompiled = async (statement, options) => {
    const rival = /^insert into "?_holo_migration_locks"?/i.test(statement.sql) ? rivals.shift() : undefined
    if (!rival) {
      return executeCompiled(statement, options)
    }

    await executeCompiled({
      sql: 'insert into "_holo_migration_locks" ("name", "owner", "expires_at") values (?, ?, ?)',
      bindings: ['migrations', rival.owner, new Date(Date.now() + 60 * 1000).toISOString()],
    })
    try {
      return await executeCompiled(statement, options)
    } finally {
      if (!rival.staysHeld) {
        await executeCompiled({
          sql: 'delete from "_holo_migration_locks" where "owner" = ?',
          bindings: [rival.owner],
        })
      }
    }
  }
  return db
}

function signal() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function tableMigration(name: string, tableName: string): MigrationDefinition {
  return defineMigration({
    name,
    async up({ schema }) {
      await schema.createTable(tableName, table => {
        table.id()
      })
    },
    async down({ schema }) {
      await schema.dropTable(tableName)
    },
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'holo-migration-isolation-'))
  filename = join(directory, 'app.sqlite')
})

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(connections.splice(0).map(connection => connection.disconnect()))
  await rm(directory, { recursive: true, force: true })
})

describe('isolated migration runs', () => {
  it('skips a run while another runner holds the isolation lock, then runs once it finishes', async () => {
    const started = signal()
    const release = signal()
    const blocking = defineMigration({
      name: '2026_01_01_000001_blocking',
      async up({ schema }) {
        started.open()
        await release.promise
        await schema.createTable('blocking_records', table => {
          table.id()
        })
      },
    })
    const later = tableMigration('2026_01_01_000002_later', 'later_records')
    const firstRun = createMigrationService(connect(), [blocking, later]).migrateIsolated()
    await started.promise

    const secondRunner = createMigrationService(connect(), [blocking, later])
    await expect(secondRunner.migrateIsolated()).resolves.toEqual({ kind: 'skipped' })

    release.open()
    await expect(firstRun).resolves.toEqual({
      kind: 'ran',
      executed: [expect.objectContaining({ name: blocking.name }), expect.objectContaining({ name: later.name })],
    })
    await expect(secondRunner.migrateIsolated()).resolves.toEqual({ kind: 'ran', executed: [] })
  })

  it('releases the isolation lock when a migration fails', async () => {
    const failing = defineMigration({
      name: '2026_01_01_000001_failing',
      async up() {
        throw new Error('migration failed')
      },
    })
    const migrator = createMigrationService(connect(), [failing])

    await expect(migrator.migrateIsolated()).rejects.toThrow('migration failed')
    await expect(migrator.migrateIsolated()).rejects.toThrow('migration failed')
  })

  it('takes over a lock whose lease has expired after a runner stopped without releasing it', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-19T10:00:00Z') })
    await createMigrationService(connect()).migrateIsolated()
    await new TableQueryBuilder('_holo_migration_locks', connect()).insert({
      name: 'migrations',
      owner: 'stopped-runner',
      expires_at: '2026-10-19T10:15:00.000Z',
    })
    const takeover = tableMigration('2026_01_01_000001_takeover', 'takeover_records')

    await expect(createMigrationService(connect(), [takeover]).migrateIsolated())
      .resolves.toEqual({ kind: 'skipped' })

    vi.setSystemTime(new Date('2026-10-19T10:30:00Z'))

    await expect(createMigrationService(connect(), [takeover]).migrateIsolated())
      .resolves.toMatchObject({ kind: 'ran', executed: [expect.objectContaining({ name: takeover.name })] })
  })

  it('keeps the lease alive between migrations so a long run is not taken over', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-19T10:00:00Z') })
    const started = signal()
    const release = signal()
    const first = defineMigration({
      name: '2026_01_01_000001_first',
      async up({ schema }) {
        await schema.createTable('first_records', table => {
          table.id()
        })
        vi.setSystemTime(new Date('2026-10-19T10:50:00Z'))
      },
    })
    const second = defineMigration({
      name: '2026_01_01_000002_second',
      async up() {
        started.open()
        await release.promise
      },
    })
    const run = createMigrationService(connect(), [first, second]).migrateIsolated()
    await started.promise

    vi.setSystemTime(new Date('2026-10-19T11:30:00Z'))

    await expect(createMigrationService(connect(), [first]).migrateIsolated())
      .resolves.toEqual({ kind: 'skipped' })
    release.open()
    await expect(run).resolves.toMatchObject({ kind: 'ran' })
  })

  it('rethrows a unique violation on the lock insert that no held lock explains instead of skipping pending migrations', async () => {
    const db = connect()
    await createMigrationService(db, []).migrateIsolated()
    await db.executeCompiled({
      sql: "CREATE TRIGGER reject_lock_insert BEFORE INSERT ON _holo_migration_locks BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: _holo_migration_locks.id'); END",
      bindings: [],
    })
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    try {
      await expect(createMigrationService(db, [migration]).migrateIsolated())
        .rejects.toThrow('UNIQUE constraint failed: _holo_migration_locks.id')
    } finally {
      await db.executeCompiled({ sql: 'DROP TRIGGER reject_lock_insert', bindings: [] })
    }
    expect(await createMigrationService(db, [migration]).migrateIsolated())
      .toMatchObject({ kind: 'ran', executed: [expect.objectContaining({ name: migration.name })] })
  })

  it('skips a run whose lock insert collides with a lock that is still held', async () => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const db = connectWithLockRivals([{ owner: 'runner-a', staysHeld: true }])

    await expect(createMigrationService(db, [migration]).migrateIsolated()).resolves.toEqual({ kind: 'skipped' })
  })

  it('takes the lock when ownership hands off between runners on consecutive lock inserts', async () => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const db = connectWithLockRivals([{ owner: 'runner-a' }, { owner: 'runner-c' }])

    await expect(createMigrationService(db, [migration]).migrateIsolated()).resolves.toEqual({
      kind: 'ran',
      executed: [expect.objectContaining({ name: migration.name })],
    })
  })

  it.each([
    'UNIQUE constraint failed: _holo_migration_locks.id',
    "Duplicate entry '7' for key 'audit.name'",
  ])('rethrows the unrelated unique violation %s on the lock insert at once instead of retrying it away', async (violation) => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const db = connect()
    const executeCompiled = db.executeCompiled.bind(db)
    let clashed = false
    db.executeCompiled = async (statement, options) => {
      if (!clashed && /^insert into "?_holo_migration_locks"?/i.test(statement.sql)) {
        clashed = true
        throw new Error(violation)
      }
      return executeCompiled(statement, options)
    }

    await expect(createMigrationService(db, [migration]).migrateIsolated()).rejects.toThrow(violation)
  })

  it('rethrows a primary-key clash on the lock insert even while another runner holds the lock', async () => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const db = connect()
    const executeCompiled = db.executeCompiled.bind(db)
    let clashed = false
    db.executeCompiled = async (statement, options) => {
      if (!clashed && /^insert into "?_holo_migration_locks"?/i.test(statement.sql)) {
        clashed = true
        await executeCompiled({
          sql: 'insert into "_holo_migration_locks" ("name", "owner", "expires_at") values (?, ?, ?)',
          bindings: ['migrations', 'runner-a', new Date(Date.now() + 60 * 1000).toISOString()],
        })
        throw new Error('UNIQUE constraint failed: _holo_migration_locks.id')
      }
      return executeCompiled(statement, options)
    }

    await expect(createMigrationService(db, [migration]).migrateIsolated())
      .rejects.toThrow('UNIQUE constraint failed: _holo_migration_locks.id')
  })

  it('gives up after a bounded number of handoffs and rethrows the unique violation', async () => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const handoffs = 20
    const rivals = Array.from({ length: handoffs }, (_, index) => ({ owner: `runner-${index}` }))
    const db = connectWithLockRivals(rivals)

    await expect(createMigrationService(db, [migration]).migrateIsolated())
      .rejects.toThrow('UNIQUE constraint failed: _holo_migration_locks.name')
    expect(rivals.length).toBeLessThan(handoffs)
  })

  it('lets two concurrent first runs on a fresh database both finish, applying each migration once', async () => {
    const migration = tableMigration('2026_01_01_000001_first', 'first_records')
    const runners = [
      createMigrationService(connect(), [migration]),
      createMigrationService(connect(), [migration]),
    ]

    const results = await Promise.all(runners.map(runner => runner.migrateIsolated()))

    const executed = results.flatMap(result => result.kind === 'ran' ? result.executed : [])
    expect(executed.map(migration => migration.name)).toEqual([migration.name])
    expect(results.map(result => result.kind).sort()).toEqual(['ran', expect.stringMatching(/^(ran|skipped)$/)])
  })

  it('keeps the plain migrate API returning executed migrations', async () => {
    const migrator = createMigrationService(connect(), [tableMigration('2026_01_01_000001_plain', 'plain_records')])

    await expect(migrator.migrate()).resolves.toEqual([expect.objectContaining({ name: '2026_01_01_000001_plain' })])
  })
})
