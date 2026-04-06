import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DB,
  DatabaseError,
  SecurityError,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createSchemaService,
  createSeederService,
  defineModel,
  defineSeeder,
  resetDB,
  type DatabaseLogger,
  type Dialect,
  type DriverAdapter,
  type DriverExecutionResult,
  type DriverQueryResult } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

type Row = Record<string, unknown>
type TableStore = Record<string, Row[]>
type CounterStore = Record<string, number>

function cloneRow(row: Row): Row {
  return { ...row }
}

class InMemorySeederAdapter implements DriverAdapter {
  connected = false
  beginCalls = 0
  private readonly snapshots: Array<{ tables: string[], records: TableStore, counters: CounterStore }> = []

  constructor(
    readonly tables: string[] = [],
    readonly records: TableStore = {},
    readonly counters: CounterStore = {},
  ) {}

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
    _bindings: readonly unknown[] = [],
  ): Promise<DriverQueryResult<TRow>> {
    if (sql.includes('sqlite_master')) {
      return {
        rows: this.tables.map(name => ({ name })) as unknown as TRow[],
        rowCount: this.tables.length }
    }

    const selectMatch = sql.match(/^SELECT \* FROM "([^"]+)"(?: ORDER BY "([^"]+)" (ASC|DESC))?$/)
    if (selectMatch) {
      const [, tableName, orderColumn, direction] = selectMatch
      const rows = (this.records[tableName!] ?? []).map(cloneRow)

      if (orderColumn) {
        rows.sort((left, right) => {
          const a = left[orderColumn]
          const b = right[orderColumn]
          if (a === b) return 0
          if (direction === 'DESC') return a! > b! ? -1 : 1
          return a! < b! ? -1 : 1
        })
      }

      return {
        rows: rows as TRow[],
        rowCount: rows.length }
    }

    return { rows: [] as TRow[], rowCount: 0 }
  }

  async execute(
    sql: string,
    bindings: readonly unknown[] = [],
  ): Promise<DriverExecutionResult> {
    const createTable = sql.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)"/)
    if (createTable) {
      if (!this.tables.includes(createTable[1]!)) {
        this.tables.push(createTable[1]!)
      }
      this.records[createTable[1]!] ??= []
      return { affectedRows: 1 }
    }

    const dropTable = sql.match(/^DROP TABLE IF EXISTS "([^"]+)"/)
    if (dropTable) {
      const tableName = dropTable[1]!
      const index = this.tables.indexOf(tableName)
      if (index >= 0) {
        this.tables.splice(index, 1)
      }
      delete this.records[tableName]
      delete this.counters[tableName]
      return { affectedRows: 1 }
    }

    const insertMatch = sql.match(/^INSERT INTO "([^"]+)" \((.+)\) VALUES (.+)$/)
    if (insertMatch) {
      const [, tableName, rawColumns] = insertMatch
      const columns = rawColumns!.split(', ').map(column => column.replaceAll('"', ''))
      const rowCount = (sql.match(/\(/g) ?? []).length - 1
      const rows = this.records[tableName!] ?? (this.records[tableName!] = [])
      let bindingIndex = 0
      let lastInsertId: number | undefined

      for (let index = 0; index < rowCount; index += 1) {
        const row = Object.fromEntries(columns.map(column => [column, bindings[bindingIndex++]]))
        if (!('id' in row)) {
          this.counters[tableName!] = (this.counters[tableName!] ?? 0) + 1
          row.id = this.counters[tableName!]
          lastInsertId = row.id as number
        }
        rows.push(row)
      }

      return { affectedRows: rowCount, lastInsertId }
    }

    return { affectedRows: 0 }
  }

  async beginTransaction(): Promise<void> {
    this.beginCalls += 1
    this.snapshots.push({
      tables: [...this.tables],
      records: Object.fromEntries(
        Object.entries(this.records).map(([table, rows]) => [table, rows.map(cloneRow)]),
      ),
      counters: { ...this.counters } })
  }

  async commit(): Promise<void> {
    this.snapshots.pop()
  }

  async rollback(): Promise<void> {
    const snapshot = this.snapshots.pop()
    if (!snapshot) {
      return
    }

    this.tables.splice(0, this.tables.length, ...snapshot.tables)

    for (const key of Object.keys(this.records)) {
      delete this.records[key]
    }
    Object.assign(this.records, snapshot.records)

    for (const key of Object.keys(this.counters)) {
      delete this.counters[key]
    }
    Object.assign(this.counters, snapshot.counters)
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

describe('seeder service slice', () => {
  beforeEach(() => {
    resetDB()
  })

  it('registers seeders, preserves registration order, filters by name, and rejects unknown names', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const calls: string[] = []
    const alpha = defineSeeder({
      name: 'alpha',
      async run({ db: connection }) {
        calls.push(`alpha:${connection.getConnectionName()}`)
      } })
    const beta = defineSeeder({
      name: 'beta',
      async run({ db: connection }) {
        calls.push(`beta:${connection.getConnectionName()}`)
      } })

    const seeders = createSeederService(db, [alpha])
    seeders.register(beta)

    expect(seeders.getSeeders().map(seeder => seeder.name)).toEqual(['alpha', 'beta'])
    expect(seeders.getSeeder('alpha')).toStrictEqual(alpha)

    const filtered = await seeders.seed({ only: ['beta'] })
    expect(filtered.map(seeder => seeder.name)).toEqual(['beta'])
    expect(calls).toEqual(['beta:default'])

    calls.length = 0
    const all = await seeders.seed({ only: ['beta', 'alpha'] })
    expect(all.map(seeder => seeder.name)).toEqual(['alpha', 'beta'])
    expect(calls).toEqual(['alpha:default', 'beta:default'])

    await expect(seeders.seed({ only: ['missing'] })).rejects.toThrow(DatabaseError)
    expect(() => seeders.register(alpha)).toThrow('Seeder "alpha" is already registered.')
  })

  it('allows seeders to call other registered seeders in order', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const calls: string[] = []
    const seeders = createSeederService(db, [
      defineSeeder({
        name: 'users',
        async run() {
          calls.push('users')
        } }),
      defineSeeder({
        name: 'roles',
        async run() {
          calls.push('roles')
        } }),
      defineSeeder({
        name: 'root',
        async run({ call }) {
          calls.push('root:start')
          await call('roles', 'users')
          calls.push('root:end')
        } }),
    ])

    const executed = await seeders.seed({ only: ['root'] })
    expect(executed.map(seeder => seeder.name)).toEqual(['root'])
    expect(calls).toEqual([
      'root:start',
      'users',
      'roles',
      'root:end',
    ])
  })

  it('fails closed when nested seeder calls reference unknown seeders and rolls back prior work', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const seeders = createSeederService(db, [defineSeeder({
      name: 'root',
      async run({ schema, call }) {
        await schema.createTable('temp', (table) => {
          table.id()
        })
        await call('missing')
      } })])

    await expect(seeders.seed({ only: ['root'] })).rejects.toThrow('Seeder "missing" is not registered.')
    expect(adapter.tables).not.toContain('temp')
    expect(adapter.records.temp).toBeUndefined()
  })

  it('runs each seeder in a transaction and rolls back failed seeders', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    const seeders = createSeederService(db, [defineSeeder({
      name: 'failing',
      async run({ schema }) {
        await schema.createTable('temp', (table) => {
          table.id()
        })
        throw new Error('boom')
      } })])

    await expect(seeders.seed()).rejects.toThrow('boom')
    expect(adapter.tables).not.toContain('temp')
    expect(adapter.records.temp).toBeUndefined()
  })

  it('can mute model events while seeding', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect() })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db } }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string() })

    await createSchemaService(db).createTable('users', (table) => {
      table.id()
      table.string('name')
    })

    let createdCalls = 0
    const User = defineModelFromTable(users, {
      fillable: ['name'],
      events: {
        created: [() => {
          createdCalls += 1
        }] } })

    const seeders = createSeederService(db, [defineSeeder({
      name: 'users',
      async run() {
        await User.create({ name: 'Amina' })
      } })])

    await seeders.seed()
    expect(createdCalls).toBe(1)
    expect(adapter.records.users).toHaveLength(1)

    await seeders.seed({ quietly: true })
    expect(createdCalls).toBe(1)
    expect(adapter.records.users).toHaveLength(2)
    expect(await DB.table(users).orderBy('id').get()).toHaveLength(2)
  })

  it('reuses the active seeder transaction for model writes and nested seeder calls', async () => {
    const adapter = new InMemorySeederAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect(),
    })

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: db },
    }))

    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
    })

    await createSchemaService(db).createTable('users', (table) => {
      table.id()
      table.string('name')
    })

    const User = defineModelFromTable(users, {
      fillable: ['name'],
    })

    const seeders = createSeederService(db, [
      defineSeeder({
        name: 'users',
        async run() {
          await User.create({ name: 'Nested Seeder User' })
        },
      }),
      defineSeeder({
        name: 'root',
        async run({ call }) {
          await call('users')
        },
      }),
    ])

    await seeders.seed({ only: ['root'] })

    expect(adapter.beginCalls).toBe(1)
    expect(adapter.records.users).toHaveLength(1)
    expect(adapter.records.users?.[0]?.name).toBe('Nested Seeder User')
  })

  it('emits seeder lifecycle logs and blocks production seeding without force', async () => {
    const adapter = new InMemorySeederAdapter()
    const logger: DatabaseLogger = {
      onSeederStart: vi.fn(),
      onSeederSuccess: vi.fn(),
      onSeederError: vi.fn() }
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect(),
      logger })

    const users = defineSeeder({
      name: 'users',
      async run() {} })
    const failing = defineSeeder({
      name: 'failing',
      async run() {
        throw new Error('boom')
      } })

    const seeders = createSeederService(db, [users, failing])

    await expect(seeders.seed({ only: ['users'], environment: 'production' })).rejects.toThrow(
      'Seeding in production requires force: true.',
    )
    expect(logger.onSeederStart).not.toHaveBeenCalled()

    await seeders.seed({ only: ['users'], environment: 'production', force: true, quietly: true })
    await expect(seeders.seed({ only: ['failing'], environment: 'development' })).rejects.toThrow('boom')

    expect(logger.onSeederStart).toHaveBeenCalledWith(expect.objectContaining({
      connectionName: 'default',
      seederName: 'users',
      quietly: true,
      environment: 'production' }))
    expect(logger.onSeederSuccess).toHaveBeenCalledWith(expect.objectContaining({
      seederName: 'users',
      durationMs: expect.any(Number) }))
    expect(logger.onSeederError).toHaveBeenCalledWith(expect.objectContaining({
      seederName: 'failing',
      environment: 'development',
      durationMs: expect.any(Number),
      error: expect.any(Error) }))
  })
})
