import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { DB, type Entity, belongsToMany, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

const storedTokyoText = {
  postgres: '2026-03-04T19:00:00.123+09:00',
  mysql: '2026-03-04 19:00:00.123',
} as const

const createdAt = new Date('2026-03-04T10:00:00.123Z')

function useTokyoAppInNewYorkProcess(): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone: 'Asia/Tokyo' } } as never)
  process.env.TZ = 'America/New_York'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(createdAt)
  onTestFinished(() => {
    vi.useRealTimers()
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

async function createTextTimestampTables(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { users: `text_ts_users_${suffix}`, roles: `text_ts_roles_${suffix}`, memberships: `text_ts_memberships_${suffix}` }
  onTestFinished(async () => {
    for (const name of Object.values(names)) await schema.dropTable(name)
  })
  await schema.createTable(names.users, (table) => {
    table.id()
    table.string('name')
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
  const users = defineGeneratedTable(names.users, { id: column.id(), name: column.string(), created_at: column.text().nullable(), updated_at: column.text().nullable() })
  const roles = defineGeneratedTable(names.roles, { id: column.id(), name: column.string() })
  const memberships = defineGeneratedTable(names.memberships, { user_id: column.integer(), role_id: column.integer(), created_at: column.text().nullable(), updated_at: column.text().nullable() })
  const Role = defineModel(roles, { fillable: ['name'], timestamps: false })
  const User = defineModel(users, { fillable: ['name'], relations: { roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id').withTimestamps() } })
  return { names, Role, User }
}

describe.each(drivers)('timestamps stored in TEXT columns on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('stores model timestamps as app.timezone text that reads back and compares as the same instant', async () => {
    useTokyoAppInNewYorkProcess()
    const { names, User } = await createTextTimestampTables(driver)

    const user = await User.create({ name: 'Ada' })

    expect(await DB.table(names.users).where('id', user.id).value('created_at')).toBe(storedTokyoText[driver])
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

    expect(await DB.table(names.memberships).value('created_at')).toBe(storedTokyoText[driver])
    const [loaded] = (await User.with('roles').findOrFail(user.id)).getRelation<Entity[]>('roles')
    const pivot = loaded?.getRelation<Record<string, unknown>>('pivot')
    expect(pivot?.created_at).toEqual(createdAt)
    expect(pivot?.updated_at).toEqual(createdAt)
  })
})
