import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { column, DB, resetDB } from '../src'
import { mysqlTestConnection, openDatabase } from './support/database'
import { defineModelFromTable, defineTable } from './support/internal'

const drivers = [
  'sqlite' as const,
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

async function createProducts(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const name = `products_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('price')
    table.string('label')
    table.json('meta').nullable()
  })
  await DB.table(name).insert([
    { id: 1, price: 10, label: 'first', meta: JSON.stringify({ color: 'red' }) },
    { id: 2, price: 20, label: 'second', meta: JSON.stringify({ color: 'blue' }) },
  ])
  const read = async () => (await DB.table(name).orderBy('id').get()).map(row => ({
    price: Number(row.price),
    label: row.label,
    color: (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta)?.color,
  }))
  return { name, read }
}

describe.each(drivers)('writes with a table-qualified column or alias on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('writes a column qualified with the query table', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).where('id', 1).update({ [`${name}.price`]: 15, label: 'updated' })

    expect(await read()).toEqual([
      { price: 15, label: 'updated', color: 'red' },
      { price: 20, label: 'second', color: 'blue' },
    ])
  })

  it('writes a column qualified with the query table alias', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(`${name} as p`).where('id', 2).update({ 'p.price': 25, 'p.label': 'aliased' })

    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'red' },
      { price: 25, label: 'aliased', color: 'blue' },
    ])
  })

  it('writes a JSON path under a qualified column', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).where('id', 1).update({ [`${name}.meta->color`]: 'green' })

    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'green' },
      { price: 20, label: 'second', color: 'blue' },
    ])
  })

  it.skipIf(driver === 'sqlite')('writes a column qualified with the bare name of a schema-qualified table', async () => {
    const { name, read } = await createProducts(driver)
    const schemaName = driver === 'postgres' ? 'public' : mysqlTestConnection().database

    await DB.table(`${schemaName}.${name}`).where('id', 1).update({ [`${name}.price`]: 11 })
    await DB.table(`${schemaName}.${name}`).where('id', 2).update({ [`${schemaName}.${name}.price`]: 22 })

    expect(await read()).toEqual([
      { price: 11, label: 'first', color: 'red' },
      { price: 22, label: 'second', color: 'blue' },
    ])
  })

  it('treats a qualified increment extra value the same as its bare name', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).where('id', 1).increment('price', 1, { price: 100, [`${name}.label`]: 'bare' })
    await DB.table(name).where('id', 2).increment('price', 1, { [`${name}.price`]: 100, [`${name}.label`]: 'qualified' })

    expect(await read()).toEqual([
      { price: 11, label: 'bare', color: 'red' },
      { price: 21, label: 'qualified', color: 'blue' },
    ])
  })

  it('updates through a query that filters on the table alias', async () => {
    const { name, read } = await createProducts(driver)

    const result = await DB.table(`${name} as p`).where('p.id', 2).update({ 'p.price': 26, label: 'filtered' })

    expect(result.affectedRows).toBe(1)
    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'red' },
      { price: 26, label: 'filtered', color: 'blue' },
    ])
  })

  it('increments through a query that filters on the table alias', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(`${name} as p`).where('p.id', 1).increment('p.price', 4)
    await DB.table(`${name} as p`).where('p.price', '>', 15).orderBy('p.id').limit(1).decrement('price', 3)

    expect(await read()).toEqual([
      { price: 14, label: 'first', color: 'red' },
      { price: 17, label: 'second', color: 'blue' },
    ])
  })

  it('deletes through a query that filters on the table alias', async () => {
    const { name, read } = await createProducts(driver)

    const result = await DB.table(`${name} as p`).where('p.id', 1).delete()

    expect(result.affectedRows).toBe(1)
    expect(await read()).toEqual([
      { price: 20, label: 'second', color: 'blue' },
    ])
  })

  it('upserts with update columns qualified with the query table or its alias', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).upsert([{ id: 1, price: 31, label: 'own' }], ['id'], [`${name}.price`, `${name}.label`])
    await DB.table(`${name} as p`).upsert([{ id: 2, price: 32, label: 'aliased' }], ['id'], ['p.price', 'label'])

    expect(await read()).toEqual([
      { price: 31, label: 'own', color: 'red' },
      { price: 32, label: 'aliased', color: 'blue' },
    ])
  })

  it('rejects upsert update columns qualified with another table or named twice and leaves the rows unchanged', async () => {
    const { name, read } = await createProducts(driver)

    await expect(DB.table(name).upsert([{ id: 1, price: 99, label: 'x' }], ['id'], ['label', 'orders.price'])).rejects.toThrow(`Cannot upsert column "orders.price" outside table "${name}".`)
    await expect(DB.table(name).upsert([{ id: 1, price: 99, label: 'x' }], ['id'], ['price', `${name}.price`])).rejects.toThrow(`Cannot upsert column "price" more than once.`)

    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'red' },
      { price: 20, label: 'second', color: 'blue' },
    ])
  })

  it('rejects a column qualified with another table and leaves the rows unchanged', async () => {
    const { name, read } = await createProducts(driver)

    await expect(DB.table(name).update({ label: 'changed', 'orders.price': 1 })).rejects.toThrow(`Cannot update column "orders.price" outside table "${name}".`)

    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'red' },
      { price: 20, label: 'second', color: 'blue' },
    ])
  })

  it('rejects updating the same column under a bare and a qualified name', async () => {
    const { name, read } = await createProducts(driver)

    await expect(DB.table(name).update({ price: 1, [`${name}.price`]: 2 })).rejects.toThrow(`Cannot update column "price" more than once.`)

    expect(await read()).toEqual([
      { price: 10, label: 'first', color: 'red' },
      { price: 20, label: 'second', color: 'blue' },
    ])
  })
})

describe.each(drivers)('model upsert with a qualified updated_at update column on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('touches updated_at once when the update columns name it with the table or the query alias', async () => {
    const { schema } = await openDatabase(driver)
    const name = `posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.string('slug').unique()
      table.string('title')
      table.timestamps()
    })
    const past = new Date('2020-01-01T00:00:00.000Z')
    await DB.table(name).insert([
      { id: 1, slug: 'own', title: 'Own', created_at: past, updated_at: past },
      { id: 2, slug: 'aliased', title: 'Aliased', created_at: past, updated_at: past },
    ])
    const posts = defineTable(name, {
      id: column.id(),
      slug: column.string().unique(),
      title: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
    })
    const Post = defineModelFromTable(posts, { fillable: ['slug', 'title'] })

    await Post.query().upsert([{ slug: 'own', title: 'Own changed' }], ['slug'], [`${name}.updated_at`])
    await Post.query().from(`${name} as p`).upsert([{ slug: 'aliased', title: 'Aliased changed' }], ['slug'], ['p.updated_at' as never])

    const rows = await DB.table(name).orderBy('id').get()
    expect(rows.map(row => [row.title, new Date(row.updated_at as string).getTime() > past.getTime()])).toEqual([
      ['Own', true],
      ['Aliased', true],
    ])
  })
})

describe.each(drivers)('model upsert keeps protected columns out on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('rejects a guarded primary key or a protected column named as an update column, qualified or not, before any SQL runs', async () => {
    const statements: string[] = []
    const { schema } = await openDatabase(driver, { logger: { onQueryStart: (entry) => { statements.push(entry.sql) } } })
    const name = `posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.string('slug').unique()
      table.string('title')
      table.timestamps()
    })
    const past = new Date('2020-01-01T00:00:00.000Z')
    await DB.table(name).insert({ id: 1, slug: 'own', title: 'Own', created_at: past, updated_at: past })
    const posts = defineTable(name, {
      id: column.id(),
      slug: column.string().unique(),
      title: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
    })
    const Post = defineModelFromTable(posts, { fillable: ['slug', 'title'] })
    const notWritable = (column: string) => `Column "${column}" is not writable on model "${Post.definition.name}".`

    statements.length = 0
    await expect(Post.query().upsert([{ id: 99, slug: 'own', title: 'Taken' }], ['slug'], ['id'])).rejects.toThrow(notWritable('id'))
    await expect(Post.query().upsert([{ slug: 'own', title: 'Taken' }], ['slug'], [`${name}.created_at`])).rejects.toThrow(notWritable('created_at'))
    await expect(Post.query().from(`${name} as p`).upsert([{ slug: 'own', title: 'Taken' }], ['slug'], ['p.created_at' as never])).rejects.toThrow(notWritable('created_at'))
    await expect(Post.query().upsert([{ slug: 'own', title: 'Taken', [`${name}.created_at`]: past } as never], ['slug'], ['title'])).rejects.toThrow(notWritable('created_at'))
    expect(statements).toEqual([])

    const rows = await DB.table(name).get()
    expect(rows.map(row => [Number(row.id), row.title])).toEqual([[1, 'Own']])
  })

  it('leaves a row that conflicts on another unique column unchanged when there are no update columns', async () => {
    const { schema } = await openDatabase(driver)
    const name = `posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.string('slug').unique()
      table.string('title')
    })
    await DB.table(name).insert({ id: 1, slug: 'own', title: 'Own' })
    const posts = defineTable(name, {
      id: column.id(),
      slug: column.string().unique(),
      title: column.string(),
    })
    const Post = defineModelFromTable(posts, { fillable: ['slug', 'title'], timestamps: false })

    const upserts = [
      () => Post.query().upsert([{ id: 99, slug: 'own', title: 'Taken' }], ['id'], []),
      () => DB.table(name).upsert([{ id: 98, slug: 'own', title: 'Taken' }], ['id']),
    ]
    for (const upsert of upserts) {
      if (driver === 'mysql') await upsert()
      else await expect(upsert()).rejects.toThrow()
    }

    const rows = await DB.table(name).get()
    expect(rows.map(row => [Number(row.id), row.slug, row.title])).toEqual([[1, 'own', 'Own']])
  })
})

describe.each(drivers)('model upsert accepts a non-fillable key only on an unscoped query on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  async function createAccounts() {
    const statements: string[] = []
    const { schema } = await openDatabase(driver, { logger: { onQueryStart: (entry) => { statements.push(entry.sql) } } })
    const name = `accounts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(name)
    })
    await schema.createTable(name, (table) => {
      table.id()
      table.integer('tenant_id')
      table.string('slug').unique()
      table.string('status')
      table.timestamp('deleted_at').nullable()
    })
    await DB.table(name).insert([
      { id: 1, tenant_id: 1, slug: 'own', status: 'pending', deleted_at: null },
      { id: 2, tenant_id: 2, slug: 'foreign', status: 'pending', deleted_at: null },
    ])
    const accounts = defineTable(name, {
      id: column.id(),
      tenant_id: column.integer(),
      slug: column.string().unique(),
      status: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    const read = async () => (await DB.table(name).orderBy('id').get()).map(row => [Number(row.id), Number(row.tenant_id), row.status])
    return { statements, accounts, read, schema }
  }

  it('rejects a non-fillable key on a tenant-scoped model before any SQL runs', async () => {
    const { statements, accounts, read } = await createAccounts()
    const Account = defineModelFromTable(accounts, {
      fillable: ['tenant_id', 'slug', 'status'],
      timestamps: false,
      globalScopes: { tenant: query => query.where('tenant_id', 1) },
    })

    statements.length = 0
    await expect(Account.query().upsert([{ id: 2, tenant_id: 1, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(`Column "id" is not writable on model "${Account.definition.name}".`)
    expect(statements).toEqual([])
    expect(await read()).toEqual([[1, 1, 'pending'], [2, 2, 'pending']])
  })

  it('rejects a non-fillable key on a where-constrained query before any SQL runs', async () => {
    const { statements, accounts, read } = await createAccounts()
    const Account = defineModelFromTable(accounts, { fillable: ['tenant_id', 'slug', 'status'], timestamps: false })

    statements.length = 0
    await expect(Account.where('tenant_id', 1).upsert([{ id: 2, tenant_id: 1, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(`Column "id" is not writable on model "${Account.definition.name}".`)
    expect(statements).toEqual([])
    expect(await read()).toEqual([[1, 1, 'pending'], [2, 2, 'pending']])
  })

  it('rejects a non-fillable key on a query a join scopes, before any SQL runs', async () => {
    const { statements, accounts, read, schema } = await createAccounts()
    const allowed = `allowed_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => {
      await schema.dropTable(allowed)
    })
    await schema.createTable(allowed, (table) => {
      table.integer('account_id')
    })
    await DB.table(allowed).insert({ account_id: 1 })
    const name = accounts.tableName
    const Account = defineModelFromTable(accounts, {
      fillable: ['tenant_id', 'slug', 'status'],
      timestamps: false,
      globalScopes: { tenant: query => query.join(allowed, `${name}.id` as never, '=', `${allowed}.account_id` as never) },
    })
    const Plain = defineModelFromTable(accounts, { fillable: ['tenant_id', 'slug', 'status'], timestamps: false })
    const notWritable = `Column "id" is not writable on model "${Account.definition.name}".`

    statements.length = 0
    await expect(Account.query().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    await expect(Plain.query().join(allowed, `${name}.id` as never, '=', `${allowed}.account_id` as never).upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    expect(statements).toEqual([])
    expect(await read()).toEqual([[1, 1, 'pending'], [2, 2, 'pending']])
  })

  it('rejects a non-fillable key on a query a having clause or a limit scopes, before any SQL runs', async () => {
    const { statements, accounts, read } = await createAccounts()
    const Grouped = defineModelFromTable(accounts, {
      fillable: ['tenant_id', 'slug', 'status'],
      timestamps: false,
      globalScopes: { tenant: query => query.groupBy('id').having('tenant_id', '=', 1) },
    })
    const Limited = defineModelFromTable(accounts, {
      fillable: ['tenant_id', 'slug', 'status'],
      timestamps: false,
      globalScopes: { first: query => query.limit(1) },
    })
    const notWritable = `Column "id" is not writable on model "${Grouped.definition.name}".`

    statements.length = 0
    await expect(Grouped.query().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    await expect(Limited.query().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    expect(statements).toEqual([])
    expect(await read()).toEqual([[1, 1, 'pending'], [2, 2, 'pending']])
  })

  it('rejects a non-fillable key on a query restricted to trashed rows, before any SQL runs', async () => {
    const { statements, accounts, read } = await createAccounts()
    const Trashable = defineModelFromTable(accounts, { fillable: ['tenant_id', 'slug', 'status'], timestamps: false, softDeletes: true })
    const TrashedOnly = defineModelFromTable(accounts, {
      fillable: ['tenant_id', 'slug', 'status'],
      timestamps: false,
      softDeletes: true,
      globalScopes: { trashed: query => query.onlyTrashed() },
    })
    const notWritable = `Column "id" is not writable on model "${Trashable.definition.name}".`

    statements.length = 0
    await expect(Trashable.onlyTrashed().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    await expect(TrashedOnly.query().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'hacked' }], ['id'], ['status'])).rejects.toThrow(notWritable)
    expect(statements).toEqual([])
    expect(await read()).toEqual([[1, 1, 'pending'], [2, 2, 'pending']])
  })

  it('upserts with a non-fillable key on an unscoped and a soft-deleting model', async () => {
    const { accounts, read } = await createAccounts()
    const Account = defineModelFromTable(accounts, { fillable: ['tenant_id', 'slug', 'status'], timestamps: false })
    const Trashable = defineModelFromTable(accounts, { fillable: ['tenant_id', 'slug', 'status'], timestamps: false, softDeletes: true })

    await Account.query().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'active' }], ['id'], ['status'])
    await Trashable.query().upsert([{ id: 1, tenant_id: 1, slug: 'own', status: 'active' }], ['id'], ['status'])
    await Trashable.withTrashed().upsert([{ id: 2, tenant_id: 2, slug: 'foreign', status: 'archived' }], ['id'], ['status'])

    expect(await read()).toEqual([[1, 1, 'active'], [2, 2, 'archived']])
  })
})
