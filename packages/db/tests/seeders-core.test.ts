import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  DB,
  DatabaseError,
  SecurityError,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSchemaService,
  createSeederService,
  defineModel,
  defineSeeder,
  resetDB,
  type DatabaseLogger,
 } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'

function createTestAdapter(): ReturnType<typeof createSQLiteAdapter> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  return adapter
}

describe('seeder service slice', () => {
  beforeEach(() => {
    resetDB()
  })

  it('registers seeders, preserves registration order, filters by name, and rejects unknown names', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

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
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

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
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    const seeders = createSeederService(db, [defineSeeder({
      name: 'root',
      async run({ schema, call }) {
        await schema.createTable('temp', (table) => {
          table.id()
        })
        await call('missing')
      } })])

    await expect(seeders.seed({ only: ['root'] })).rejects.toThrow('Seeder "missing" is not registered.')
    expect(await createSchemaService(db).hasTable('temp')).toBe(false)
  })

  it('runs each seeder in a transaction and rolls back failed seeders', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

    const seeders = createSeederService(db, [defineSeeder({
      name: 'failing',
      async run({ schema }) {
        await schema.createTable('temp', (table) => {
          table.id()
        })
        throw new Error('boom')
      } })])

    await expect(seeders.seed()).rejects.toThrow('boom')
    expect(await createSchemaService(db).hasTable('temp')).toBe(false)
  })

  it('can mute model events while seeding', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite') })

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
    expect(await db.table('users').get()).toHaveLength(1)

    await seeders.seed({ quietly: true })
    expect(createdCalls).toBe(1)
    expect(await db.table('users').get()).toHaveLength(2)
    expect(await DB.table(users).orderBy('id').get()).toHaveLength(2)
  })

  it('reuses the active seeder transaction for model writes and nested seeder calls', async () => {
    const adapter = createTestAdapter()
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite'),
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

    expect(await db.table('users').get()).toEqual([{ id: 1, name: 'Nested Seeder User' }])
  })

  it('rolls back nested seeder model writes when their parent fails', async () => {
    const db = createDatabase({ connectionName: 'default', adapter: createTestAdapter(), dialect: createDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createSchemaService(db).createTable('users', table => { table.id(); table.string('name') })
    const User = defineModelFromTable(defineTable('users', { id: column.id(), name: column.string() }), { fillable: ['name'] })
    const seeders = createSeederService(db, [
      defineSeeder({ name: 'users', async run() { await User.create({ name: 'Nested' }) } }),
      defineSeeder({ name: 'root', async run({ call }) { await call('users'); throw new Error('parent failed') } }),
    ])
    await expect(seeders.seed({ only: ['root'] })).rejects.toThrow('parent failed')
    expect(await User.count()).toBe(0)
    await seeders.seed({ only: ['users'] })
    expect(await db.table('users').get()).toEqual([{ id: 1, name: 'Nested' }])
  })

  it('emits seeder lifecycle logs and blocks production seeding without force', async () => {
    const adapter = createTestAdapter()
    const starts: Parameters<NonNullable<DatabaseLogger['onSeederStart']>>[0][] = []
    const successes: Parameters<NonNullable<DatabaseLogger['onSeederSuccess']>>[0][] = []
    const failures: Parameters<NonNullable<DatabaseLogger['onSeederError']>>[0][] = []
    const logger: DatabaseLogger = {
      onSeederStart: event => { starts.push(event) },
      onSeederSuccess: event => { successes.push(event) },
      onSeederError: event => { failures.push(event) },
    }
    const db = createDatabase({
      connectionName: 'default',
      adapter,
      dialect: createDialect('sqlite'),
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
    expect(starts).toEqual([])

    await seeders.seed({ only: ['users'], environment: 'production', force: true, quietly: true })
    await expect(seeders.seed({ only: ['failing'], environment: 'development' })).rejects.toThrow('boom')

    expect(starts).toContainEqual(expect.objectContaining({
      connectionName: 'default',
      seederName: 'users',
      quietly: true,
      environment: 'production' }))
    expect(successes).toContainEqual(expect.objectContaining({
      seederName: 'users',
      durationMs: expect.any(Number) }))
    expect(failures).toContainEqual(expect.objectContaining({
      seederName: 'failing',
      environment: 'development',
      durationMs: expect.any(Number),
      error: expect.any(Error) }))
  })
})
