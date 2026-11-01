import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { DB, column, configureDB, createConnectionManager, createDialect, resetDB } from '../src'
import { defineTable } from './support/internal'

function useDialect(name: 'mysql' | 'postgres' | 'sqlite'): void {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect(name) } },
  }))
}

async function seedUsers(): Promise<void> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)')
  await adapter.execute(`INSERT INTO users VALUES
    (1, 'Mohamed', 'mo@example.com'),
    (2, 'mona', 'mona@example.com'),
    (3, 'Amina', 'amina@example.org')`)
}

async function seedOrders(): Promise<ReturnType<typeof createSQLiteAdapter>> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  await adapter.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, note TEXT, total INTEGER, paid INTEGER, created_at TEXT)')
  await adapter.execute(`INSERT INTO orders VALUES
    (1, 'paid', 'gift', 100, 100, '2025-01-15 09:30:00'),
    (2, 'pending', NULL, 250, 0, '2025-02-20 18:45:00'),
    (3, 'refunded', 'refunded', 75, 75, '2024-12-31 23:59:00'),
    (4, 'paid', 'rush', 500, 400, '2025-03-01 07:00:00')`)
  return adapter
}

const events = defineTable('events', {
  id: column.id(),
  startsAt: column.timestamp(),
  endsAt: column.timestamp(),
})

async function seedEvents(): Promise<void> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  await adapter.execute('CREATE TABLE events (id INTEGER PRIMARY KEY, startsAt TEXT, endsAt TEXT)')
  await DB.table(events).insert([
    { id: 1, startsAt: new Date('2025-02-19T08:00:00Z'), endsAt: new Date('2025-02-19T09:00:00Z') },
    { id: 2, startsAt: new Date('2025-02-20T09:00:00Z'), endsAt: new Date('2025-02-20T12:00:00Z') },
    { id: 3, startsAt: new Date('2025-02-20T15:00:00Z'), endsAt: new Date('2025-02-21T10:00:00Z') },
    { id: 4, startsAt: new Date('2025-02-22T08:00:00Z'), endsAt: new Date('2025-02-22T09:00:00Z') },
  ])
}

const profiles = defineTable('profiles', {
  id: column.id(),
  settings: column.json<{ tags?: string[], theme?: { mode: string | null } }>(),
})

async function seedProfiles(): Promise<void> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  await adapter.execute('CREATE TABLE profiles (id INTEGER PRIMARY KEY, settings TEXT)')
  await DB.table(profiles).insert([
    { id: 1, settings: { tags: ['admin', 'staff'], theme: { mode: 'dark' } } },
    { id: 2, settings: { tags: ['staff'], theme: { mode: null } } },
    { id: 3, settings: { tags: [] } },
  ])
}

describe('where clauses', () => {
  beforeEach(() => {
    resetDB()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetConfigRuntime()
  })

  it('filters with like patterns case-insensitively by default', async () => {
    await seedUsers()

    expect(await DB.table('users').whereLike('name', 'mo%').orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await DB.table('users').whereNotLike('name', 'mo%').pluck('id')).toEqual([3])
    expect(await DB.table('users').where('id', 3).orWhereNotLike('email', '%.org').orderBy('id').pluck('id')).toEqual([1, 2, 3])
    expect(await DB.table('users').where('id', 3).orWhereLike('name', 'MONA').orderBy('id').pluck('id')).toEqual([2, 3])
  })

  it('filters with case-sensitive like patterns', async () => {
    await seedUsers()

    expect(await DB.table('users').whereLike('name', 'Mo%', true).pluck('id')).toEqual([1])
    expect(await DB.table('users').whereNotLike('name', 'Mo%', true).orderBy('id').pluck('id')).toEqual([2, 3])
    expect(await DB.table('users').whereLike('email', 'mo_@example.com', true).pluck('id')).toEqual([])
    expect(await DB.table('users').whereLike('email', 'mo@%.com', true).pluck('id')).toEqual([1])
  })

  it('compiles like predicates for each dialect', () => {
    useDialect('postgres')
    expect(DB.table('users').whereLike('name', 'mo%').orWhereNotLike('name', 'Am%', true).toSQL().sql)
      .toBe('SELECT * FROM "users" WHERE "name"::text ILIKE $1 OR "name"::text NOT LIKE $2')

    useDialect('mysql')
    expect(DB.table('users').whereNotLike('name', 'mo%').orWhereLike('name', 'Am%', true).toSQL().sql)
      .toBe('SELECT * FROM `users` WHERE `name` NOT LIKE ? OR `name` LIKE BINARY ?')

    useDialect('sqlite')
    expect(DB.table('users').whereLike('name', 'a*b?[c]_%', true).toSQL())
      .toMatchObject({ sql: 'SELECT * FROM "users" WHERE "name" GLOB ?', bindings: ['a[*]b[?][[]c]?*'] })
  })

  it('adds or variants for every basic where clause', async () => {
    await seedOrders()
    const orders = () => DB.table('orders').where('id', 1)

    expect(await orders().orWhereIn('status', ['refunded']).orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereNotIn('status', ['paid', 'refunded']).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await orders().orWhereBetween('total', [200, 300]).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await orders().orWhereNotBetween('total', [80, 600]).orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereColumn('total', '>', 'paid').orderBy('id').pluck('id')).toEqual([1, 2, 4])
    expect(await orders().orWhereColumn('note', 'status').orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await DB.table('orders').whereColumn('total', 'paid').orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereDate('created_at', '2024-12-31').orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereMonth('created_at', 2).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await orders().orWhereDay('created_at', '>=', 20).orderBy('id').pluck('id')).toEqual([1, 2, 3])
    expect(await orders().orWhereYear('created_at', '<', 2025).orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereTime('created_at', '07:00:00').orderBy('id').pluck('id')).toEqual([1, 4])
    expect(await orders().orWhereAny(['status', 'note'], 'rush').orderBy('id').pluck('id')).toEqual([1, 4])
    expect(await orders().orWhereAll(['status', 'note'], 'refunded').orderBy('id').pluck('id')).toEqual([1, 3])
    expect(await orders().orWhereNone(['status', 'note'], 'like', '%u%').orderBy('id').pluck('id')).toEqual([1])
  })

  it('filters by subqueries passed to whereIn and whereNotIn', async () => {
    await seedOrders()
    const paidIds = DB.table('orders').select('id').where('status', 'paid')

    expect(await DB.table('orders').whereIn('id', paidIds).orderBy('id').pluck('id')).toEqual([1, 4])
    expect(await DB.table('orders').whereNotIn('id', paidIds).orderBy('id').pluck('id')).toEqual([2, 3])
    expect(await DB.table('orders').where('id', 2).orWhereIn('id', paidIds).orderBy('id').pluck('id')).toEqual([1, 2, 4])
    expect(await DB.table('orders').where('id', 1).orWhereNotIn('id', paidIds).orderBy('id').pluck('id')).toEqual([1, 2, 3])
  })

  it('compares columns and values against ranges bounded by other columns', async () => {
    await seedOrders()
    const orders = () => DB.table('orders')

    expect(await orders().whereBetweenColumns('paid', ['id', 'total']).orderBy('id').pluck('id')).toEqual([1, 3, 4])
    expect(await orders().whereNotBetweenColumns('paid', ['id', 'total']).pluck('id')).toEqual([2])
    expect(await orders().where('id', 1).orWhereBetweenColumns('id', ['paid', 'total']).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await orders().where('id', 2).orWhereNotBetweenColumns('total', ['paid', 'total']).orderBy('id').pluck('id')).toEqual([2])
    expect(await orders().whereValueBetween(90, ['paid', 'total']).orderBy('id').pluck('id')).toEqual([2])
    expect(await orders().whereValueNotBetween(90, ['paid', 'total']).orderBy('id').pluck('id')).toEqual([1, 3, 4])
    expect(await orders().where('id', 1).orWhereValueBetween(450, ['paid', 'total']).orderBy('id').pluck('id')).toEqual([1, 4])
    expect(await orders().where('id', 1).orWhereValueNotBetween(0, ['paid', 'total']).orderBy('id').pluck('id')).toEqual([1, 3, 4])
  })

  it('filters columns relative to the current time and date', async () => {
    await seedEvents()
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-02-20T12:00:00Z') })
    const query = () => DB.table(events).orderBy('id')

    expect(await query().wherePast('endsAt').pluck('id')).toEqual([1])
    expect(await query().whereNowOrPast('endsAt').pluck('id')).toEqual([1, 2])
    expect(await query().whereFuture('startsAt').pluck('id')).toEqual([3, 4])
    expect(await query().whereNowOrFuture(['startsAt', 'endsAt']).pluck('id')).toEqual([3, 4])
    expect(await query().where('id', 1).orWherePast('startsAt').pluck('id')).toEqual([1, 2])
    expect(await query().where('id', 1).orWhereNowOrPast('endsAt').pluck('id')).toEqual([1, 2])
    expect(await query().where('id', 1).orWhereFuture('startsAt').pluck('id')).toEqual([1, 3, 4])
    expect(await query().where('id', 1).orWhereNowOrFuture('endsAt').pluck('id')).toEqual([1, 2, 3, 4])

    expect(await query().whereToday('startsAt').pluck('id')).toEqual([2, 3])
    expect(await query().whereToday(['startsAt', 'endsAt']).pluck('id')).toEqual([2])
    expect(await query().whereBeforeToday('startsAt').pluck('id')).toEqual([1])
    expect(await query().whereAfterToday('endsAt').pluck('id')).toEqual([3, 4])
    expect(await query().whereTodayOrBefore('startsAt').pluck('id')).toEqual([1, 2, 3])
    expect(await query().whereTodayOrAfter('startsAt').pluck('id')).toEqual([2, 3, 4])
    expect(await query().where('id', 4).orWhereToday('endsAt').pluck('id')).toEqual([2, 4])
    expect(await query().where('id', 4).orWhereBeforeToday('endsAt').pluck('id')).toEqual([1, 4])
    expect(await query().where('id', 1).orWhereAfterToday('startsAt').pluck('id')).toEqual([1, 4])
    expect(await query().where('id', 4).orWhereTodayOrBefore('endsAt').pluck('id')).toEqual([1, 2, 4])
    expect(await query().where('id', 1).orWhereTodayOrAfter('endsAt').pluck('id')).toEqual([1, 2, 3, 4])
  })

  it('filters json columns by missing values and key presence', async () => {
    await seedProfiles()
    const query = () => DB.table(profiles).orderBy('id')

    expect(await query().whereJsonDoesntContain('settings->tags', 'admin').pluck('id')).toEqual([2, 3])
    expect(await query().where('id', 1).orWhereJsonDoesntContain('settings->tags', 'staff').pluck('id')).toEqual([1, 3])
    expect(await query().whereJsonContainsKey('settings->theme->mode').pluck('id')).toEqual([1, 2])
    expect(await query().where('id', 3).orWhereJsonContainsKey('settings->theme').pluck('id')).toEqual([1, 2, 3])
    expect(await query().whereJsonDoesntContainKey('settings->theme').pluck('id')).toEqual([3])
    expect(await query().where('id', 1).orWhereJsonDoesntContainKey('settings->theme->mode').pluck('id')).toEqual([1, 3])
  })

  it('compiles json key presence for each dialect', () => {
    useDialect('mysql')
    expect(DB.table(profiles).whereJsonContainsKey('settings->theme').toSQL().sql)
      .toBe('SELECT * FROM `profiles` WHERE IFNULL(JSON_CONTAINS_PATH(`settings`, \'one\', \'$.theme\'), 0)')

    useDialect('postgres')
    expect(DB.table(profiles).whereJsonDoesntContainKey('settings->theme').toSQL().sql)
      .toBe('SELECT * FROM "profiles" WHERE NOT (jsonb_extract_path(("settings")::jsonb, \'theme\') IS NOT NULL)')
  })

  it('combines having clauses with or, null checks, and ranges', async () => {
    await seedOrders()
    const byStatus = () => DB.table('orders').select('status').groupBy('status').orderBy('status')

    expect(await byStatus().having('count(*)', 2).orHaving('sum(total)', '<', 100).pluck('status')).toEqual(['paid', 'refunded'])
    expect(await byStatus().havingNull('max(note)').pluck('status')).toEqual(['pending'])
    expect(await byStatus().havingNotNull('max(note)').pluck('status')).toEqual(['paid', 'refunded'])
    expect(await byStatus().having('count(*)', 2).orHavingNull('max(note)').pluck('status')).toEqual(['paid', 'pending'])
    expect(await byStatus().having('count(*)', 2).orHavingNotNull('min(note)').pluck('status')).toEqual(['paid', 'refunded'])
    expect(await byStatus().havingNotBetween('sum(total)', [100, 300]).pluck('status')).toEqual(['paid', 'refunded'])
    expect(await byStatus().having('count(*)', 2).orHavingBetween('sum(total)', [200, 300]).pluck('status')).toEqual(['paid', 'pending'])
    expect(await byStatus().having('count(*)', 2).orHavingNotBetween('sum(total)', [50, 300]).pluck('status')).toEqual(['paid'])
  })

  it('orders descending with orderByDesc', async () => {
    await seedOrders()

    expect(await DB.table('orders').orderByDesc('total').pluck('id')).toEqual([4, 2, 1, 3])
  })

  it('compares relative times against native SQLite timestamps', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE alarms (id INTEGER PRIMARY KEY, rings_at TEXT)')
    await adapter.execute(`INSERT INTO alarms VALUES (1, datetime('now', '+1 hour')), (2, datetime('now', '-1 hour'))`)

    expect(await DB.table('alarms').wherePast('rings_at').pluck('id')).toEqual([2])
    expect(await DB.table('alarms').whereFuture('rings_at').pluck('id')).toEqual([1])
  })

  it('bounds today by midnight in the application timezone', async () => {
    await seedEvents()
    configureConfigRuntime({ app: { timezone: 'Asia/Tokyo' } } as never)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-02-20T03:00:00Z') })
    await DB.table(events).insert([
      { id: 5, startsAt: new Date('2025-02-19T15:30:00Z'), endsAt: new Date('2025-02-19T15:30:00Z') },
      { id: 6, startsAt: new Date('2025-02-19T14:30:00Z'), endsAt: new Date('2025-02-19T14:30:00Z') },
    ])
    const query = () => DB.table(events).where('id', '>', 4).orderBy('id')

    expect(await query().whereToday('startsAt').pluck('id')).toEqual([5])
    expect(await query().whereBeforeToday('startsAt').pluck('id')).toEqual([6])
    expect(await query().whereTodayOrAfter('startsAt').pluck('id')).toEqual([5])
  })

  it('starts today at the first midnight when the clock repeats midnight', async () => {
    await seedEvents()
    configureConfigRuntime({ app: { timezone: 'America/Havana' } } as never)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-11-02T12:00:00Z') })
    await DB.table(events).insert([
      { id: 5, startsAt: new Date('2025-11-02T04:30:00Z'), endsAt: new Date('2025-11-02T04:30:00Z') },
      { id: 6, startsAt: new Date('2025-11-02T03:30:00Z'), endsAt: new Date('2025-11-02T03:30:00Z') },
    ])
    const query = () => DB.table(events).where('id', '>', 4).orderBy('id')

    expect(await query().whereToday('startsAt').pluck('id')).toEqual([5])
    expect(await query().whereBeforeToday('startsAt').pluck('id')).toEqual([6])
  })

  it('compares qualified date columns by calendar date', async () => {
    const adapter = await seedOrders()
    const holidays = defineTable('holidays', { id: column.id(), day: column.date() })
    await adapter.execute('CREATE TABLE holidays (id INTEGER PRIMARY KEY, day TEXT)')
    await adapter.execute(`INSERT INTO holidays VALUES (1, '2025-02-20'), (2, '2025-02-19')`)
    configureConfigRuntime({ app: { timezone: 'America/New_York' } } as never)
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2025-02-20T17:00:00Z') })

    expect(await DB.table(holidays).whereToday('holidays.day').pluck('id')).toEqual([1])
    expect(await DB.table(holidays).whereBeforeToday('holidays.day').pluck('id')).toEqual([2])
    expect(await DB.table(holidays).wherePast('day').pluck('id')).toEqual([2])
    expect(await DB.table(holidays).whereNowOrFuture('day').pluck('id')).toEqual([1])
  })

  it('matches like patterns inside JSON paths', async () => {
    await seedProfiles()
    await DB.table(profiles).insert({ id: 4, settings: { theme: { mode: 'Dark' } } })

    expect(await DB.table(profiles).whereLike('settings->theme->mode', 'da%').orderBy('id').pluck('id')).toEqual([1, 4])
    expect(await DB.table(profiles).whereLike('settings->theme->mode', 'Da%', true).pluck('id')).toEqual([4])
    expect(await DB.table(profiles).whereNotLike('settings->theme->mode', 'da%').orderBy('id').pluck('id')).toEqual([])

    useDialect('postgres')
    expect(DB.table(profiles).whereLike('settings->theme->mode', 'da%').toSQL().sql)
      .toBe('SELECT * FROM "profiles" WHERE (("settings")::jsonb #>> \'{"theme","mode"}\')::text ILIKE $1')
    useDialect('mysql')
    expect(DB.table(profiles).whereNotLike('settings->theme', 'da%', true).toSQL().sql)
      .toBe('SELECT * FROM `profiles` WHERE JSON_UNQUOTE(JSON_EXTRACT(`settings`, \'$.theme\')) NOT LIKE BINARY ?')
    expect(DB.table(profiles).whereLike('settings->theme', 'da%').toSQL().sql)
      .toBe('SELECT * FROM `profiles` WHERE LOWER(JSON_UNQUOTE(JSON_EXTRACT(`settings`, \'$.theme\'))) LIKE LOWER(?)')
  })

  it('treats equality with null as an IS NULL check', async () => {
    await seedOrders()

    expect(await DB.table('orders').where('note', null).pluck('id')).toEqual([2])
    expect(await DB.table('orders').where('note', '!=', null).orderBy('id').pluck('id')).toEqual([1, 3, 4])
    expect(await DB.table('orders').where('id', 1).orWhere('note', null).orderBy('id').pluck('id')).toEqual([1, 2])
  })

  it('rejects JSON paths rooted at qualified non-JSON columns', () => {
    useDialect('sqlite')
    const people = defineTable('people', { id: column.id(), name: column.string() })

    expect(() => DB.table(people).whereLike('people.name->first', 'a%')).toThrow('whereLike() requires "people.name" to be a JSON column.')
  })
})
