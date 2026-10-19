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
        vi.setSystemTime(new Date('2026-10-19T10:14:00Z'))
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

    vi.setSystemTime(new Date('2026-10-19T10:20:00Z'))

    await expect(createMigrationService(connect(), [first]).migrateIsolated())
      .resolves.toEqual({ kind: 'skipped' })
    release.open()
    await expect(run).resolves.toMatchObject({ kind: 'ran' })
  })

  it('keeps the plain migrate API returning executed migrations', async () => {
    const migrator = createMigrationService(connect(), [tableMigration('2026_01_01_000001_plain', 'plain_records')])

    await expect(migrator.migrate()).resolves.toEqual([expect.objectContaining({ name: '2026_01_01_000001_plain' })])
  })
})
