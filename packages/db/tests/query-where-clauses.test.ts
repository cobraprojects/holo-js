import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { DB, configureDB, createConnectionManager, createDialect, resetDB } from '../src'

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

async function seedOrders(): Promise<void> {
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
}

describe('where clauses', () => {
  beforeEach(() => {
    resetDB()
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
})
