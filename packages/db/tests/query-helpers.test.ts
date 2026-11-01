import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { DB, MySQLQueryCompiler, createDatabase, PostgresQueryCompiler, SQLiteQueryCompiler, configureDB, createConnectionManager, createDialect, createSelectQueryPlan, createTableSource, resetDB } from '../src'
import { createInsertUsingQueryPlan, createTruncateQueryPlan, withPredicate } from '../src/query/ast'

async function seedOrders(): Promise<ReturnType<typeof createSQLiteAdapter>> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  await adapter.initialize()
  onTestFinished(() => adapter.disconnect())
  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: { default: { adapter, dialect: createDialect('sqlite') } },
  }))
  await adapter.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT, total INTEGER)')
  await adapter.execute(`INSERT INTO orders VALUES
    (1, 'paid', 100),
    (2, 'pending', 250),
    (3, 'refunded', 75),
    (4, 'paid', 500)`)
  return adapter
}

async function collect<TRow>(rows: AsyncIterable<TRow>): Promise<TRow[]> {
  const collected: TRow[] = []
  for await (const row of rows) collected.push(row)
  return collected
}

describe('query builder helpers', () => {
  beforeEach(() => {
    resetDB()
  })

  it('visits rows one at a time across chunks', async () => {
    await seedOrders()
    const visited: Array<[unknown, number]> = []

    await DB.table('orders').orderBy('id').each((row, index) => {
      visited.push([row.id, index])
    }, 3)
    expect(visited).toEqual([[1, 0], [2, 1], [3, 2], [4, 0]])

    const stoppedAt: unknown[] = []
    await DB.table('orders').eachById((row) => {
      stoppedAt.push(row.id)
      return row.id !== 2
    }, 2)
    expect(stoppedAt).toEqual([1, 2])
  })

  it('streams rows ordered by id', async () => {
    await seedOrders()

    expect((await collect(DB.table('orders').lazyById(3))).map(row => row.id)).toEqual([1, 2, 3, 4])
    expect((await collect(DB.table('orders').lazyByIdDesc(3))).map(row => row.id)).toEqual([4, 3, 2, 1])
    expect((await collect(DB.table('orders').where('status', 'paid').lazyByIdDesc(1, 'total'))).map(row => row.id)).toEqual([4, 1])
  })

  it('reads joined values, averages, and existence fallbacks', async () => {
    await seedOrders()

    expect(await DB.table('orders').orderBy('id').implode('status', ', ')).toBe('paid, pending, refunded, paid')
    expect(await DB.table('orders').where('status', 'paid').implode('total')).toBe('100500')
    expect(await DB.table('orders').where('status', 'paid').average('total')).toBe(300)
    expect(await DB.table('orders').where('status', 'paid').existsOr(() => 'none')).toBe(true)
    expect(await DB.table('orders').where('status', 'void').existsOr(() => 'none')).toBe('none')
    expect(await DB.table('orders').where('status', 'void').doesntExistOr(async () => 'some')).toBe(true)
    expect(await DB.table('orders').where('status', 'paid').doesntExistOr(async () => 'some')).toBe('some')
  })

  it('adjusts several numeric columns at once', async () => {
    const adapter = await seedOrders()
    await adapter.execute('ALTER TABLE orders ADD COLUMN refunds INTEGER NOT NULL DEFAULT 0')

    await DB.table('orders').where('id', 1).incrementEach({ total: 10, refunds: 2 }, { status: 'adjusted' })
    await DB.table('orders').where('id', 4).decrementEach({ total: 100, refunds: 1 })

    expect(await DB.table('orders').whereIn('id', [1, 4]).orderBy('id').select('id', 'status', 'total', 'refunds').get()).toEqual([
      { id: 1, status: 'adjusted', total: 110, refunds: 2 },
      { id: 4, status: 'paid', total: 400, refunds: -1 },
    ])
  })

  it('updates a matching row or inserts a new one', async () => {
    await seedOrders()

    expect(await DB.table('orders').updateOrInsert({ id: 2 }, { status: 'paid' })).toBe(true)
    expect(await DB.table('orders').updateOrInsert({ id: 9 }, { status: 'new', total: 1 })).toBe(true)
    expect(await DB.table('orders').updateOrInsert({ id: 9, status: 'new' })).toBe(true)

    expect(await DB.table('orders').whereIn('id', [2, 9]).orderBy('id').get()).toEqual([
      { id: 2, status: 'paid', total: 250 },
      { id: 9, status: 'new', total: 1 },
    ])
  })

  it('updates rows matched by null attributes instead of inserting duplicates', async () => {
    await seedOrders()
    await DB.table('orders').insert({ id: 5, status: null, total: 0 })

    expect(await DB.table('orders').updateOrInsert({ status: null }, { total: 9 })).toBe(true)

    expect(await DB.table('orders').whereNull('status').get()).toEqual([{ id: 5, status: null, total: 9 }])
  })

  it('inserts rows selected by another query', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE archived_orders (id INTEGER PRIMARY KEY, total INTEGER)')

    const result = await DB.table('archived_orders').insertUsing(['id', 'total'], DB.table('orders').select('id', 'total').where('status', 'paid'))

    expect(result.affectedRows).toBe(2)
    expect(await DB.table('archived_orders').orderBy('id').get()).toEqual([{ id: 1, total: 100 }, { id: 4, total: 500 }])

    const ignored = await DB.table('archived_orders').insertOrIgnoreUsing(['id', 'total'], DB.table('orders').select('id', 'total').whereIn('id', [1, 2]))

    expect(ignored.affectedRows).toBe(1)
    expect(await DB.table('archived_orders').orderBy('id').pluck('id')).toEqual([1, 2, 4])
  })

  it('ignores placeholder characters inside comments and quoted strings when inlining bindings', () => {
    const sqlite = new SQLiteQueryCompiler(identifier => `"${identifier}"`, () => '?')
    const postgres = new PostgresQueryCompiler(identifier => `"${identifier}"`, index => `$${index}`)

    expect(sqlite.substituteBindings("SELECT /* ? */ ? AS value, '?' AS mark -- ?\n", [42])).toBe("SELECT /* ? */ 42 AS value, '?' AS mark -- ?\n")
    expect(postgres.substituteBindings('SELECT $tag$ $1 $tag$, $2, $1', ['a', 'b'])).toBe("SELECT $tag$ $1 $tag$, 'b', 'a'")
  })

  it('filters relative to now on tables without column definitions', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE reminders (id INTEGER PRIMARY KEY, remind_at TEXT)')
    await adapter.execute(`INSERT INTO reminders VALUES (1, '2000-01-01T00:00:00.000Z'), (2, '2999-01-01T00:00:00.000Z')`)

    expect(await DB.table('reminders').wherePast('remind_at').pluck('id')).toEqual([1])
    expect(await DB.table('reminders').whereFuture('remind_at').pluck('id')).toEqual([2])
  })

  it('renders MySQL date bindings in the application timezone', () => {
    configureConfigRuntime({ app: { timezone: 'Asia/Tokyo' } } as never)
    onTestFinished(() => resetConfigRuntime())
    const mysql = new MySQLQueryCompiler(identifier => `\`${identifier}\``, () => '?')

    expect(mysql.substituteBindings('SELECT ?', [new Date('2026-01-01T12:00:00Z')])).toBe("SELECT '2026-01-01 21:00:00.000'")
  })

  it('rejects inserting rows selected with unsafe raw SQL when the security policy disallows it', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE archived_orders (id INTEGER PRIMARY KEY, total INTEGER)')

    await expect(DB.table('archived_orders').insertUsing(['id', 'total'], DB.table('orders').select('id', 'total').unsafeWhere('1 = 1', [])))
      .rejects.toThrow('Unsafe raw SQL is disabled by the active security policy')
    expect(await DB.table('archived_orders').count()).toBe(0)
  })

  it('restarts auto-increment ids after truncating a SQLite table', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT)')
    await DB.table('tickets').insert([{ title: 'first' }, { title: 'second' }])

    await DB.table('TICKETS').truncate()
    await DB.table('tickets').insert({ title: 'fresh' })

    expect(await DB.table('tickets').pluck('id')).toEqual([1])
  })

  it('refuses to truncate inside a transaction on MySQL', async () => {
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('mysql') } },
    }))

    const message = 'truncate() cannot run inside a transaction on "mysql" because the database commits the transaction; use delete() instead.'
    const prebuilt = DB.table('orders')

    await expect(DB.transaction(async tx => tx.table('orders').truncate())).rejects.toThrow(message)
    await expect(DB.transaction(async () => prebuilt.truncate())).rejects.toThrow(message)

    let releaseAfterCommit: () => Promise<void> = async () => {}
    await DB.transaction(async () => {
      releaseAfterCommit = () => prebuilt.truncate()
    })
    await expect(releaseAfterCommit()).resolves.toBeUndefined()
  })

  it('rejects inserting from a query on another connection', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    onTestFinished(() => adapter.disconnect())
    const other = createSQLiteAdapter({ filename: ':memory:' })
    onTestFinished(() => other.disconnect())
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: {
        default: { adapter, dialect: createDialect('sqlite') },
        reporting: { adapter: other, dialect: createDialect('sqlite') },
      },
    }))

    await expect(DB.table('archive').insertUsing(['id'], DB.connection('reporting').table('orders').select('id')))
      .rejects.toThrow('insertUsing() needs a source query on the same database connection as "default".')

    const separate = createDatabase({ adapter: other, dialect: createDialect('sqlite') })
    await expect(DB.table('archive').insertUsing(['id'], separate.table('orders').select('id')))
      .rejects.toThrow('insertUsing() needs a source query on the same database connection as "default".')
  })

  it('refuses to truncate a table that other tables reference', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE order_lines (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE)')
    await adapter.execute('INSERT INTO order_lines VALUES (1, 1)')

    await expect(DB.table('orders').truncate()).rejects.toThrow('Cannot truncate "orders" because "order_lines" reference it with foreign keys.')
    expect(await DB.table('orders').count()).toBe(4)
    expect(await DB.table('order_lines').count()).toBe(1)
  })

  it('compares a date value against a range bounded by columns', async () => {
    const adapter = await seedOrders()
    await adapter.execute('CREATE TABLE promotions (id INTEGER PRIMARY KEY, starts_at TEXT, ends_at TEXT)')
    await adapter.execute(`INSERT INTO promotions VALUES (1, '2026-01-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'), (2, '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')`)

    expect(await DB.table('promotions').whereValueBetween(new Date('2026-06-01T00:00:00Z'), ['starts_at', 'ends_at']).pluck('id')).toEqual([1])
  })

  it('truncates a table', async () => {
    await seedOrders()

    await DB.table('orders').truncate()

    expect(await DB.table('orders').count()).toBe(0)
  })

  it('compiles truncate and insert using statements for each dialect', () => {
    const postgres = new PostgresQueryCompiler(identifier => `"${identifier}"`, index => `$${index}`)
    const mysql = new MySQLQueryCompiler(identifier => `\`${identifier}\``, () => '?')
    const sqlite = new SQLiteQueryCompiler(identifier => `"${identifier}"`, () => '?')
    const orders = createTableSource('orders')
    const paidOrders = withPredicate(createSelectQueryPlan(createTableSource('orders')), { kind: 'comparison', column: 'status', operator: '=', value: 'paid' })

    expect(postgres.compile(createTruncateQueryPlan(orders)).sql).toBe('TRUNCATE "orders" RESTART IDENTITY')
    expect(mysql.compile(createTruncateQueryPlan(orders)).sql).toBe('TRUNCATE TABLE `orders`')
    expect(sqlite.compile(createTruncateQueryPlan(orders)).sql).toBe('DELETE FROM "orders"')
    expect(postgres.compile(createInsertUsingQueryPlan(createTableSource('archive'), ['id'], paidOrders))).toMatchObject({
      sql: 'INSERT INTO "archive" ("id") SELECT * FROM "orders" WHERE "status" = $1',
      bindings: ['paid'],
    })
    expect(postgres.compile(createInsertUsingQueryPlan(createTableSource('archive'), ['id'], paidOrders, { ignoreConflicts: true })).sql)
      .toBe('INSERT INTO "archive" ("id") SELECT * FROM "orders" WHERE "status" = $1 ON CONFLICT DO NOTHING')
    expect(mysql.compile(createInsertUsingQueryPlan(createTableSource('archive'), ['id'], paidOrders, { ignoreConflicts: true })).sql)
      .toBe('INSERT IGNORE INTO `archive` (`id`) SELECT * FROM `orders` WHERE `status` = ?')
  })

  it('renders queries with their bindings inlined for debugging', async () => {
    await seedOrders()

    expect(DB.table('orders').where('status', "it's ?").whereIn('id', [1, 2]).whereNull('total').toRawSql())
      .toBe(`SELECT * FROM "orders" WHERE "status" = 'it''s ?' AND "id" IN (1, 2) AND "total" IS NULL`)

    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('postgres') } },
    }))
    const ids = Array.from({ length: 10 }, (_, index) => index + 1)

    expect(DB.table('orders').whereIn('id', ids).where('paid', true).where('settings->theme', 'dark').toRawSql())
      .toBe('SELECT * FROM "orders" WHERE "id" IN (1, 2, 3, 4, 5, 6, 7, 8, 9, 10) AND "paid" = true AND jsonb_extract_path(("settings")::jsonb, \'theme\') = \'"dark"\'::jsonb')
  })
})
