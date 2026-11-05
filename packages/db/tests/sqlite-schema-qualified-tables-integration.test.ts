import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

async function openProducts() {
  const { db, schema } = await openDatabase('sqlite')
  await schema.createTable('products', (table) => {
    table.id()
    table.string('name')
    table.integer('price')
  })
  return { db, schema }
}

const readProducts = async (table: string) => (await DB.table(table).orderBy('id').get())
  .map(row => ({ id: Number(row.id), name: row.name, price: Number(row.price) }))

describe('SQLite schema-qualified table names', () => {
  afterEach(() => {
    resetDB()
  })

  it('selects, inserts, updates, and deletes through a main-qualified table', async () => {
    await openProducts()

    await DB.table('main.products').insert([
      { id: 1, name: 'first', price: 10 },
      { id: 2, name: 'second', price: 20 },
    ])
    await DB.table('main.products').where('id', 1).update({ price: 15 })
    await DB.table('main.products').where('main.products.id', 2).increment('price', 5)
    await DB.table('main.products').insert({ id: 3, name: 'third', price: 30 })
    await DB.table('main.products').where('id', 3).delete()

    expect(await readProducts('main.products')).toEqual([
      { id: 1, name: 'first', price: 15 },
      { id: 2, name: 'second', price: 25 },
    ])
    expect(await DB.table('main.products').where('name', 'second').value('price')).toBe(25)
    expect(await readProducts('products')).toEqual(await readProducts('main.products'))
  })

  it('reads and writes a table in an attached database', async () => {
    const { db } = await openProducts()
    await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."products" ("id" INTEGER PRIMARY KEY, "name" TEXT, "price" INTEGER)', source: 'schema' })

    await DB.table('archive.products').insert({ id: 7, name: 'archived', price: 70 })
    await DB.table('archive.products').where('id', 7).update({ price: 75 })

    expect(await readProducts('archive.products')).toEqual([{ id: 7, name: 'archived', price: 75 }])
    expect(await readProducts('main.products')).toEqual([])

    await DB.table('main.products').insert({ id: 7, name: 'current', price: 80 })
    expect(await DB.table('main.products')
      .join('archive.products', 'archive.products.id', '=', 'main.products.id')
      .select('main.products.name as current', 'archive.products.name as archived')
      .get()).toEqual([{ current: 'current', archived: 'archived' }])
    expect(await DB.table('main.products as p')
      .join('archive.products as a', 'a.id', '=', 'p.id')
      .select('p.price as current_price', 'a.price as archived_price')
      .get()).toEqual([{ current_price: 80, archived_price: 75 }])

    await DB.table('archive.products').where('id', 7).delete()
    expect(await DB.table('archive.products').count()).toBe(0)
  })

  it('updates and deletes through an aliased table in an attached database', async () => {
    const { db } = await openProducts()
    await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."products" ("id" INTEGER PRIMARY KEY, "name" TEXT, "price" INTEGER)', source: 'schema' })
    await DB.table('archive.products').insert([{ id: 1, name: 'first', price: 10 }, { id: 2, name: 'second', price: 20 }])

    await DB.table('archive.products as a').where('a.id', 1).update({ price: 11 })
    await DB.table('archive.products as a').where('a.id', 2).delete()

    expect(await readProducts('archive.products')).toEqual([{ id: 1, name: 'first', price: 11 }])
  })

  it('persists and queries a model on a main-qualified table', async () => {
    await openProducts()
    const products = defineGeneratedTable('main.products', { id: column.id(), name: column.string(), price: column.integer() })
    const Product = defineModel(products, { fillable: ['name', 'price'], timestamps: false })

    const product = await Product.create({ name: 'modeled', price: 40 })
    product.set('price', 45)
    await product.save()

    expect((await Product.findOrFail(product.get('id'))).get('price')).toBe(45)
    expect(await Product.where('name', 'modeled').count()).toBe(1)

    await product.delete()
    expect(await Product.count()).toBe(0)
  })

  it('persists and queries a model on a table in an attached database', async () => {
    const { db } = await openProducts()
    await db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."products" ("id" INTEGER PRIMARY KEY, "name" TEXT, "price" INTEGER)', source: 'schema' })
    const products = defineGeneratedTable('archive.products', { id: column.id(), name: column.string(), price: column.integer() })
    const Product = defineModel(products, { fillable: ['name', 'price'], timestamps: false })

    const product = await Product.create({ name: 'archived', price: 50 })
    product.set('price', 55)
    await product.save()

    expect((await Product.findOrFail(product.get('id'))).get('price')).toBe(55)
    expect(await readProducts('main.products')).toEqual([])

    await product.delete()
    expect(await Product.count()).toBe(0)
  })

  it('keeps rejecting unsafe identifier segments', async () => {
    await openProducts()

    await expect(DB.table('main."products').get()).rejects.toThrow('Table "main."products" is not a valid identifier.')
    await expect(DB.table('main.products;drop').insert({ id: 1, name: 'x', price: 1 })).rejects.toThrow('Table "main.products;drop" is not a valid identifier.')
    await expect(DB.table('main..products').where('id', 1).update({ price: 1 })).rejects.toThrow('Table "main..products" is not a valid identifier.')
    await expect(DB.table('main.pro"ducts').delete()).rejects.toThrow('Table "main.pro"ducts" is not a valid identifier.')
    await expect(DB.table('main.products').where('id', 1).update({ 'pri"ce': 1 })).rejects.toThrow('Column "pri"ce" is not a valid identifier.')
    expect(await readProducts('products')).toEqual([])
  })
})

async function openArchive() {
  const opened = await openProducts()
  await opened.db.executeCompiled({ sql: `ATTACH DATABASE ':memory:' AS archive`, source: 'schema' })
  return opened
}

const indexesOf = async (schema: Awaited<ReturnType<typeof openProducts>>['schema'], table: string) => (await schema.getIndexes(table))
  .filter(index => !index.name.startsWith('sqlite_autoindex_'))
  .map(index => ({ name: index.name, unique: index.unique, columns: index.columns }))
  .sort((left, right) => left.name.localeCompare(right.name))

describe('SQLite schema operations on schema-qualified tables', () => {
  afterEach(() => {
    resetDB()
  })

  it('creates indexes in the table schema', async () => {
    const { schema } = await openArchive()

    await schema.createTable('archive.items', (table) => {
      table.id()
      table.string('name').index()
      table.string('code').unique()
    })
    await schema.createTable('main.things', (table) => {
      table.id()
      table.string('name').index()
    })

    expect(await indexesOf(schema, 'archive.items')).toEqual([
      { name: 'archive_items_code_unique', unique: true, columns: ['code'] },
      { name: 'archive_items_name_index', unique: false, columns: ['name'] },
    ])
    expect(await indexesOf(schema, 'main.things')).toEqual([
      { name: 'main_things_name_index', unique: false, columns: ['name'] },
    ])
    expect(await indexesOf(schema, 'items')).toEqual([])
    await expect(DB.table('archive.items').insert([{ id: 1, name: 'a', code: 'same' }, { id: 2, name: 'b', code: 'same' }])).rejects.toThrow('UNIQUE constraint failed')
  })

  it('adds, renames, and drops indexes and columns on an attached table', async () => {
    const { schema } = await openArchive()
    await schema.createTable('archive.items', (table) => {
      table.id()
      table.string('name')
      table.string('code')
      table.integer('stock')
    })
    await DB.table('archive.items').insert({ id: 1, name: 'kept', code: 'c1', stock: 3 })

    await schema.table('archive.items', (table) => {
      table.index(['stock'], 'items_stock_index')
      table.unique(['code'])
      table.index(['name'])
    })
    expect(await indexesOf(schema, 'archive.items')).toEqual([
      { name: 'archive_items_code_unique', unique: true, columns: ['code'] },
      { name: 'archive_items_name_index', unique: false, columns: ['name'] },
      { name: 'items_stock_index', unique: false, columns: ['stock'] },
    ])

    await schema.table('archive.items', (table) => {
      table.renameIndex('items_stock_index', 'items_stock_renamed')
    })
    await schema.table('archive.items', (table) => {
      table.dropIndex(['name'])
      table.dropUnique(['code'])
    })
    expect(await indexesOf(schema, 'archive.items')).toEqual([
      { name: 'items_stock_renamed', unique: false, columns: ['stock'] },
    ])

    await schema.table('archive.items', (table) => {
      table.dropIndex('items_stock_renamed')
      table.string('note').nullable()
    })
    await schema.table('archive.items', (table) => {
      table.renameColumn('note', 'remark')
    })
    await schema.table('archive.items', (table) => {
      table.dropColumn('remark')
    })

    expect(await indexesOf(schema, 'archive.items')).toEqual([])
    expect((await schema.getColumns('archive.items')).map(columnInfo => columnInfo.name)).toEqual(['id', 'name', 'code', 'stock'])
    expect(await DB.table('archive.items').get()).toEqual([{ id: 1, name: 'kept', code: 'c1', stock: 3 }])
  })

  it('references a table in the same attached database by its bare name', async () => {
    const { schema } = await openArchive()
    await schema.createTable('archive.parents', (table) => {
      table.id()
    })
    await schema.createTable('archive.kids', (table) => {
      table.id()
      table.foreignId('parent_id').constrained('archive.parents')
    })
    await schema.createTable('archive.pets', (table) => {
      table.id()
    })
    await schema.table('archive.pets', (table) => {
      table.foreignId('parent_id').nullable().constrained('archive.parents')
    })

    expect(await schema.getForeignKeys('archive.kids')).toEqual([expect.objectContaining({ table: 'parents', from: 'parent_id', to: 'id' })])
    expect(await schema.getForeignKeys('archive.pets')).toEqual([expect.objectContaining({ table: 'parents', from: 'parent_id', to: 'id' })])

    await schema.table('archive.pets', (table) => {
      table.dropForeign(['parent_id'])
    })
    expect(await schema.getForeignKeys('archive.pets')).toEqual([])
  })

  it('rejects a foreign key to a table in another database', async () => {
    const { schema } = await openArchive()

    await expect(schema.createTable('archive.kids', (table) => {
      table.id()
      table.foreignId('product_id').constrained('main.products')
    })).rejects.toThrow('SQLite foreign key "product_id" on table "archive.kids" cannot reference table "main.products" in another database.')
    await expect(schema.createTable('kids', (table) => {
      table.id()
      table.foreignId('product_id').constrained('archive.products')
    })).rejects.toThrow('SQLite foreign key "product_id" on table "kids" cannot reference table "archive.products" in another database.')
    await expect(schema.table('products', (table) => {
      table.foreignId('parent_id').nullable().constrained('archive.parents')
    })).rejects.toThrow('SQLite foreign key "parent_id" on table "products" cannot reference table "archive.parents" in another database.')
  })

  it('rebuilds an attached table and keeps its rows, indexes, and autoincrement sequence', async () => {
    const { schema } = await openArchive()
    await schema.createTable('archive.parents', (table) => {
      table.id()
    })
    await schema.createTable('archive.pets', (table) => {
      table.id()
      table.string('name').index()
    })
    await DB.table('archive.parents').insert({ id: 1 })
    await DB.table('archive.pets').insert([{ name: 'a' }, { name: 'b' }, { name: 'c' }])
    await DB.table('archive.pets').where('name', 'c').delete()

    await schema.table('archive.pets', (table) => {
      table.foreignId('parent_id').nullable().constrained('archive.parents')
    })
    expect(await schema.getForeignKeys('archive.pets')).toEqual([expect.objectContaining({ table: 'parents', from: 'parent_id', to: 'id' })])
    await schema.table('archive.pets', (table) => {
      table.dropForeign(['parent_id'])
    })

    expect(await schema.getForeignKeys('archive.pets')).toEqual([])
    expect(await indexesOf(schema, 'archive.pets')).toEqual([{ name: 'archive_pets_name_index', unique: false, columns: ['name'] }])
    expect(await schema.getTables()).not.toContain('pets')
    await DB.table('archive.pets').insert({ name: 'd' })
    expect(await DB.table('archive.pets').orderBy('id').get()).toEqual([
      { id: 1, name: 'a', parent_id: null },
      { id: 2, name: 'b', parent_id: null },
      { id: 4, name: 'd', parent_id: null },
    ])
  })

  it('keeps dotted view and column names when it rebuilds a table', async () => {
    const { db, schema } = await openProducts()
    await db.executeCompiled({ sql: 'CREATE TABLE "parents" ("id" INTEGER PRIMARY KEY)', source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "prices" ("id" INTEGER PRIMARY KEY, "unit.price" INTEGER)', source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE VIEW "price.summary" AS SELECT "id", "unit.price" FROM "prices"', source: 'schema' })
    await db.executeCompiled({ sql: 'INSERT INTO "prices" ("id", "unit.price") VALUES (1, 12)', source: 'schema' })

    await schema.table('prices', (table) => {
      table.foreignId('parent_id').nullable().constrained('parents')
    })

    expect((await schema.getColumns('prices')).map(columnInfo => columnInfo.name)).toEqual(['id', 'unit.price', 'parent_id'])
    expect((await db.queryCompiled<Record<string, unknown>>({ sql: 'SELECT * FROM "price.summary"', source: 'test' })).rows).toEqual([{ 'id': 1, 'unit.price': 12 }])
  })

  it('rejects a rebuild that would leave a foreign key violation in an attached database and rolls it back', async () => {
    const { schema } = await openArchive()
    await schema.createTable('archive.parents', (table) => {
      table.id()
    })
    await schema.createTable('archive.children', (table) => {
      table.id()
      table.integer('parent_id')
    })
    await DB.table('archive.parents').insert({ id: 1 })
    await DB.table('archive.children').insert([{ id: 1, parent_id: 1 }, { id: 2, parent_id: 99 }])

    await expect(schema.table('archive.children', (table) => {
      table.foreign('parent_id').references('id').on('archive.parents')
    })).rejects.toThrow('SQLite cannot rebuild table "archive.children" because it would leave 1 foreign key violation.')

    expect(await schema.getForeignKeys('archive.children')).toEqual([])
    expect(await DB.table('archive.children').orderBy('id').pluck('parent_id')).toEqual([1, 99])
  })

  it('renames a table inside its attached database', async () => {
    const { schema } = await openArchive()
    await schema.createTable('archive.items', (table) => {
      table.id()
    })
    await DB.table('archive.items').insert({ id: 1 })

    await schema.renameTable('archive.items', 'archive.goods')
    expect(await DB.table('archive.goods').get()).toEqual([{ id: 1 }])
    await schema.renameTable('archive.goods', 'stock')
    expect(await DB.table('archive.stock').get()).toEqual([{ id: 1 }])
    expect(await schema.getTables()).not.toContain('stock')

    await expect(schema.renameTable('archive.stock', 'main.stock')).rejects.toThrow('SQLite cannot move table "archive.stock" to another database as "main.stock".')
    await expect(schema.renameTable('products', 'archive.products')).rejects.toThrow('SQLite cannot move table "products" to another database as "archive.products".')
  })

  it('selects every column and single columns through schema-qualified references', async () => {
    const { db } = await openArchive()
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."products" ("id" INTEGER PRIMARY KEY, "name" TEXT, "price" INTEGER)', source: 'schema' })
    await DB.table('main.products').insert({ id: 1, name: 'current', price: 10 })
    await DB.table('archive.products').insert({ id: 1, name: 'archived', price: 5 })

    expect(await DB.table('main.products').select('main.products.*').get()).toEqual([{ id: 1, name: 'current', price: 10 }])
    expect(await DB.table('archive.products')
      .select('archive.products.name')
      .where('archive.products.id', 1)
      .orderBy('archive.products.id')
      .get()).toEqual([{ name: 'archived' }])
    expect(await DB.table('main.products as p')
      .join('archive.products as a', 'a.id', '=', 'p.id')
      .select('a.*', 'p.name as current')
      .get()).toEqual([{ id: 1, name: 'archived', price: 5, current: 'current' }])
    await expect(DB.table('main.products')
      .join('archive.products', 'archive.products.id', '=', 'main.products.id')
      .select('archive.products.*')
      .get()).rejects.toThrow('SQLite cannot select "archive.products.*" because more than one table in the query is named "products". Alias the tables and select "alias.*" instead.')
  })

  it('refuses a schema-qualified wildcard that SQLite would expand from another table', async () => {
    const { db } = await openArchive()
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."products" ("id" INTEGER PRIMARY KEY, "name" TEXT, "price" INTEGER)', source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."orders" ("id" INTEGER PRIMARY KEY, "total" INTEGER)', source: 'schema' })

    await expect(DB.table('main.products as p')
      .join('archive.products', 'archive.products.id', '=', 'p.id')
      .select('main.products.*')
      .get()).rejects.toThrow('SQLite cannot select "main.products.*" because table "main.products" is aliased as "p". Select "p.*" instead.')
    await expect(DB.table('archive.orders as products')
      .select('main.products.*')
      .get()).rejects.toThrow('SQLite cannot select "main.products.*" because no table in the query is "main.products" without an alias. Qualify the table the same way or select "products.*".')
    await expect(DB.table('main.products')
      .join('archive.orders as products', 'products.id', '=', 'main.products.id')
      .select('archive.products.*')
      .get()).rejects.toThrow('SQLite cannot select "archive.products.*" because more than one table in the query is named "products". Alias the tables and select "alias.*" instead.')
    await expect(DB.table('products')
      .select('archive.products.*')
      .get()).rejects.toThrow('SQLite cannot select "archive.products.*" because no table in the query is "archive.products" without an alias. Qualify the table the same way or select "products.*".')
    await expect(DB.table('products')
      .select('main.products.*')
      .get()).rejects.toThrow('SQLite cannot select "main.products.*" because no table in the query is "main.products" without an alias. Qualify the table the same way or select "products.*".')
    expect(await DB.table('main.products').select('main.products.*').get()).toEqual([])
  })

  it('selects the unaliased table of a self-join through its qualified wildcard', async () => {
    await openArchive()
    await DB.table('main.products').insert([{ id: 1, name: 'first', price: 10 }, { id: 2, name: 'second', price: 20 }])

    expect(await DB.table('main.products')
      .join('main.products as p', 'p.id', '=', 'main.products.id')
      .select('main.products.*', 'p.name as alias_name')
      .orderBy('main.products.id')
      .get()).toEqual([
      { id: 1, name: 'first', price: 10, alias_name: 'first' },
      { id: 2, name: 'second', price: 20, alias_name: 'second' },
    ])
  })

  it('applies the qualified wildcard checks to counts and pagination', async () => {
    await openArchive()
    await DB.table('main.products').insert({ id: 1, name: 'main', price: 10 })

    await expect(DB.table('main.products as p').select('main.products.*').count())
      .rejects.toThrow('SQLite cannot select "main.products.*" because table "main.products" is aliased as "p". Select "p.*" instead.')
    await expect(DB.table('products').select('main.products.*').count())
      .rejects.toThrow('SQLite cannot select "main.products.*" because no table in the query is "main.products" without an alias. Qualify the table the same way or select "products.*".')
    await expect(DB.table('products').select('main.products.*').paginate(10, 1))
      .rejects.toThrow('SQLite cannot select "main.products.*" because no table in the query is "main.products" without an alias. Qualify the table the same way or select "products.*".')
    expect(await DB.table('main.products').select('main.products.*').count()).toBe(1)
  })

  it('never expands a qualified wildcard from a temporary table that shadows it', async () => {
    const { db } = await openArchive()
    await db.executeCompiled({ sql: 'CREATE TEMP TABLE "products" ("id" INTEGER PRIMARY KEY, "other" TEXT)', source: 'schema' })
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."notes" ("id" INTEGER PRIMARY KEY, "body" TEXT)', source: 'schema' })
    await DB.table('main.products').insert({ id: 1, name: 'main', price: 10 })
    await DB.table('temp.products').insert({ id: 2, other: 'temp' })
    await DB.table('archive.notes').insert({ id: 3, body: 'archived' })

    await expect(DB.table('products').select('main.products.*').get())
      .rejects.toThrow('SQLite cannot select "main.products.*" because no table in the query is "main.products" without an alias. Qualify the table the same way or select "products.*".')
    expect(await DB.table('main.products').select('main.products.*').get()).toEqual([{ id: 1, name: 'main', price: 10 }])
    expect(await DB.table('temp.products').select('temp.products.*').get()).toEqual([{ id: 2, other: 'temp' }])
    expect(await DB.table('notes').select('notes.*').get()).toEqual([{ id: 3, body: 'archived' }])
    await expect(DB.table('notes').select('archive.notes.*').get())
      .rejects.toThrow('SQLite cannot select "archive.notes.*" because no table in the query is "archive.notes" without an alias. Qualify the table the same way or select "notes.*".')
    expect(await DB.table('archive.notes').select('archive.notes.*').get()).toEqual([{ id: 3, body: 'archived' }])
  })

  it('selects every column of a joined attached table with a distinct name', async () => {
    const { db } = await openArchive()
    await db.executeCompiled({ sql: 'CREATE TABLE "archive"."notes" ("id" INTEGER PRIMARY KEY, "product_id" INTEGER, "body" TEXT)', source: 'schema' })
    await DB.table('main.products').insert({ id: 1, name: 'current', price: 10 })
    await DB.table('archive.notes').insert({ id: 9, product_id: 1, body: 'note' })

    expect(await DB.table('main.products')
      .join('archive.notes', 'archive.notes.product_id', '=', 'main.products.id')
      .select('archive.notes.*', 'main.products.name')
      .get()).toEqual([{ id: 9, product_id: 1, body: 'note', name: 'current' }])
  })
})
