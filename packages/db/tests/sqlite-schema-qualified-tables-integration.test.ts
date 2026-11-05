import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, createDialect, defineGeneratedTable, defineModel, resetDB } from '../src'
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

  it('quotes each segment of a qualified identifier', () => {
    expect(createDialect('sqlite').quoteIdentifier('main.products')).toBe('"main"."products"')
    expect(createDialect('sqlite').quoteIdentifier('products')).toBe('"products"')
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
