import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DB, type Entity, belongsToMany, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

const storedText = {
  postgres: '2026-03-04 10:00:00.123+00:00',
  mysql: '2026-03-04 19:00:00.123',
} as const

const createdAt = new Date('2026-03-04T10:00:00.123Z')

function useAppTimezone(appTimezone: string, processTimezone: string, now: Date): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: appTimezone } } as never)
  process.env.TZ = processTimezone
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  onTestFinished(() => {
    vi.useRealTimers()
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

function useTokyoAppInNewYorkProcess(): void {
  useAppTimezone('Asia/Tokyo', 'America/New_York', createdAt)
}

async function createTextTimestampTables(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { users: `text_ts_users_${suffix}`, roles: `text_ts_roles_${suffix}`, memberships: `text_ts_memberships_${suffix}` }
  onTestFinished(async () => {
    for (const name of Object.values(names)) await schema.dropTable(name)
  })
  await schema.createTable(names.users, (table) => {
    table.id()
    table.string('name')
    table.text('at').nullable()
    table.timestamp('native_at').nullable()
    table.text('created_at').nullable()
    table.text('updated_at').nullable()
  })
  await schema.createTable(names.roles, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(names.memberships, (table) => {
    table.integer('user_id')
    table.integer('role_id')
    table.text('created_at').nullable()
    table.text('updated_at').nullable()
  })
  const users = defineGeneratedTable(names.users, { id: column.id(), name: column.string(), at: column.text().nullable(), native_at: column.timestamp().nullable(), created_at: column.text().nullable(), updated_at: column.text().nullable() })
  const roles = defineGeneratedTable(names.roles, { id: column.id(), name: column.string() })
  const memberships = defineGeneratedTable(names.memberships, { user_id: column.integer(), role_id: column.integer(), created_at: column.text().nullable(), updated_at: column.text().nullable() })
  const Role = defineModel(roles, { fillable: ['name'], timestamps: false })
  const User = defineModel(users, { fillable: ['name', 'at', 'native_at'], casts: { at: 'datetime' }, relations: { roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id').withTimestamps() } })
  return { db, names, Role, User }
}

describe.each(drivers)('timestamps stored in TEXT columns on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('stores model timestamps as dialect text that reads back and compares as the same instant', async () => {
    useTokyoAppInNewYorkProcess()
    const { names, User } = await createTextTimestampTables(driver)

    const user = await User.create({ name: 'Ada' })

    expect(await DB.table(names.users).where('id', user.id).value('created_at')).toBe(storedText[driver])
    expect((await User.findOrFail(user.id)).created_at).toEqual(createdAt)
    expect(await User.where('created_at', '<', new Date('2026-03-04T11:00:00.000Z')).count()).toBe(1)
    expect(await User.where('created_at', '>', new Date('2026-03-04T05:00:00.000Z')).count()).toBe(1)
  })

  it('reads offset-free timestamp text in app.timezone', async () => {
    useTokyoAppInNewYorkProcess()
    const { names, User } = await createTextTimestampTables(driver)
    const user = await User.create({ name: 'Ada' })

    await DB.table(names.users).where('id', user.id).update({ created_at: '2026-03-04 19:00:00.123' })

    expect((await User.findOrFail(user.id)).created_at).toEqual(createdAt)
  })

  it('round-trips withTimestamps pivot text through eager loading', async () => {
    useTokyoAppInNewYorkProcess()
    const { names, Role, User } = await createTextTimestampTables(driver)
    const user = await User.create({ name: 'Ada' })
    const role = await Role.create({ name: 'admin' })

    await user.attach('roles', role.id)

    expect(await DB.table(names.memberships).value('created_at')).toBe(storedText[driver])
    const [loaded] = (await User.with('roles').findOrFail(user.id)).getRelation<Entity[]>('roles')
    const pivot = loaded?.getRelation<Record<string, unknown>>('pivot')
    expect(pivot?.created_at).toEqual(createdAt)
    expect(pivot?.updated_at).toEqual(createdAt)
  })
})

const beforeFallBack = new Date('2024-11-03T05:45:00.000Z')
const afterFallBack = new Date('2024-11-03T06:15:00.000Z')

describe.runIf(drivers.includes('postgres' as never))('Postgres TEXT timestamps across a DST fall-back', () => {
  afterEach(() => {
    resetDB()
  })

  it('orders a TEXT date-cast column chronologically and stores it as UTC text', async () => {
    useAppTimezone('America/New_York', 'Asia/Tokyo', afterFallBack)
    const { names, User } = await createTextTimestampTables('postgres')

    const later = await User.create({ name: 'later', at: afterFallBack })
    const earlier = await User.create({ name: 'earlier', at: beforeFallBack })

    expect(await DB.table(names.users).where('id', earlier.id).value('at')).toBe('2024-11-03 05:45:00.000+00:00')
    expect((await User.orderBy('at').get()).map(user => user.id)).toEqual([earlier.id, later.id])
    expect((await User.findOrFail(earlier.id)).at).toEqual(beforeFallBack)
  })

  it('compares a TEXT column with Date predicates as instants', async () => {
    useAppTimezone('America/New_York', 'Asia/Tokyo', afterFallBack)
    const { User } = await createTextTimestampTables('postgres')
    const earlier = await User.create({ name: 'earlier', at: beforeFallBack })
    const later = await User.create({ name: 'later', at: afterFallBack })

    expect((await User.where('at', beforeFallBack).get()).map(user => user.id)).toEqual([earlier.id])
    expect((await User.where('at', '>', new Date('2024-11-03T06:00:00.000Z')).get()).map(user => user.id)).toEqual([later.id])
    expect((await User.where('at', '<', new Date('2024-11-03T06:00:00.000Z')).get()).map(user => user.id)).toEqual([earlier.id])
  })

  it('orders TEXT pivot timestamps chronologically', async () => {
    useAppTimezone('America/New_York', 'Asia/Tokyo', afterFallBack)
    const { names, Role, User } = await createTextTimestampTables('postgres')
    const user = await User.create({ name: 'Ada' })
    const first = await Role.create({ name: 'first' })
    const second = await Role.create({ name: 'second' })

    vi.setSystemTime(beforeFallBack)
    await user.attach('roles', first.id)
    vi.setSystemTime(afterFallBack)
    await user.attach('roles', second.id)

    expect(await DB.table(names.memberships).orderBy('created_at').pluck('role_id')).toEqual([first.id, second.id])
  })

  it('keeps writing timestamp without time zone columns as app.timezone wall clock', async () => {
    useAppTimezone('America/New_York', 'Asia/Tokyo', afterFallBack)
    const { db, names, User } = await createTextTimestampTables('postgres')
    const instant = new Date('2024-11-03T12:30:00.000Z')

    const user = await User.create({ name: 'Ada', native_at: instant })

    const stored = await db.queryCompiled<{ wall: string }>({ sql: `SELECT native_at::text AS wall FROM ${names.users} WHERE id = $1`, bindings: [user.id] })
    expect(stored.rows[0]?.wall).toBe('2024-11-03 07:30:00')
    expect((await User.findOrFail(user.id)).native_at).toEqual(instant)
    expect(await User.where('native_at', instant).count()).toBe(1)
  })
})
