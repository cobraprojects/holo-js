import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsToMany, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

function useAppTimezone(timeZone: string): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: timeZone } } as never)
  process.env.TZ = 'Asia/Tokyo'
  onTestFinished(() => {
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

async function openAnalyticsConnection(driver: Driver) {
  const { db: analytics } = await openDatabase(driver, { connectionName: 'analytics' })
  const defaultAdapter = createSQLiteAdapter({ filename: ':memory:' })
  await defaultAdapter.initialize()
  onTestFinished(() => defaultAdapter.disconnect())
  const defaultConnection = createDatabase({ connectionName: 'default', adapter: defaultAdapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: defaultConnection, analytics } }))
  const schema = createSchemaService(analytics)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const created: string[] = []
  onTestFinished(async () => {
    for (const name of created.reverse()) await schema.dropTable(name)
  })
  return {
    schema,
    async createTable(prefix: string, build: Parameters<typeof schema.createTable>[1]): Promise<string> {
      const name = `${prefix}_${suffix}`
      await schema.createTable(name, build)
      created.push(name)
      return name
    },
  }
}

function expectRecent(value: unknown): void {
  expect(value).toBeInstanceOf(Date)
  expect(Math.abs((value as Date).getTime() - Date.now())).toBeLessThan(60_000)
}

function storedInstant(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value))
}

describe.each(drivers)('an untyped model on a %s connection', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('stores dates, datetimes, timestamps and soft deletes the same way a typed model does', async () => {
    useAppTimezone('America/New_York')
    const { createTable } = await openAnalyticsConnection(driver)
    const name = await createTable('events', (table) => {
      table.id()
      table.string('label')
      table.date('day').nullable()
      table.datetime('at').nullable()
      table.timestamps()
      table.timestamp('deleted_at').nullable()
    })
    const typedTable = defineGeneratedTable(name, {
      id: column.id(),
      label: column.string(),
      day: column.date().nullable(),
      at: column.datetime().nullable(),
      created_at: column.timestamp().nullable(),
      updated_at: column.timestamp().nullable(),
      deleted_at: column.timestamp().nullable(),
    })
    const Typed = defineModel(typedTable, { connectionName: 'analytics', name: 'TypedEvent', fillable: ['label', 'day', 'at'], softDeletes: true })
    const Untyped = defineModel(name, { connectionName: 'analytics', name: 'UntypedEvent', fillable: ['label', 'day', 'at'], softDeletes: true, casts: { day: 'date', at: 'datetime' } })
    const at = new Date('2026-11-15T03:30:00Z')
    const day = new Date('2026-11-14T12:00:00Z')

    await Typed.create({ label: 'typed', day, at })
    const untyped = await Untyped.create({ label: 'untyped', day, at })
    const stored = await DB.table(name, 'analytics').orderBy('id').get()
    const found = await Untyped.findOrFail(untyped.get('id'))

    expect(stored[1]?.at).toEqual(stored[0]?.at)
    expect(stored[1]?.day).toEqual(stored[0]?.day)
    expect(found.get('at')).toEqual(at)
    expectRecent(found.get('created_at'))
    expectRecent(found.get('updated_at'))
    expect(await Untyped.where('at', at).count()).toBe(2)

    const later = new Date('2026-12-01T18:45:00Z')
    await found.update({ at: later })
    expect((await Untyped.findOrFail(untyped.get('id'))).get('at')).toEqual(later)
    expect(await Untyped.where('at', later).count()).toBe(1)

    await found.delete()
    expect(await Untyped.find(untyped.get('id'))).toBeUndefined()
    expectRecent((await Untyped.withTrashed().findOrFail(untyped.get('id'))).get('deleted_at'))

    await Untyped.where('label', 'typed').delete()
    expect(await Untyped.count()).toBe(0)
    expectRecent((await Untyped.withTrashed().where('label', 'typed').firstOrFail()).get('deleted_at'))

    await found.restore()
    expect((await Untyped.findOrFail(untyped.get('id'))).get('deleted_at')).toBeNull()
  })
  it('writes pivot timestamps as the instant of the attach', async () => {
    useAppTimezone('America/New_York')
    const { createTable } = await openAnalyticsConnection(driver)
    const users = await createTable('users', (table) => {
      table.id()
      table.string('name')
    })
    const roles = await createTable('roles', (table) => {
      table.id()
      table.string('name')
    })
    const memberships = await createTable('memberships', (table) => {
      table.integer('user_id')
      table.integer('role_id')
      table.timestamps()
    })
    const Role = defineModel(roles, { connectionName: 'analytics', name: 'Role', fillable: ['name'], timestamps: false })
    const User = defineModel(users, {
      connectionName: 'analytics',
      name: 'User',
      fillable: ['name'],
      timestamps: false,
      relations: { roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id').withTimestamps() },
    })
    const user = await User.create({ name: 'Ada' })
    const role = await Role.create({ name: 'admin' })

    await user.attach('roles', role.get('id'))
    const [stored] = await DB.table(memberships, 'analytics').get()

    expectRecent(storedInstant(stored?.created_at))
    expectRecent(storedInstant(stored?.updated_at))
  })
})
