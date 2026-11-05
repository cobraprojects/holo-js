import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { mysqlTestConnection, openDatabase } from './support/database'

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
    table.integer('stock')
    table.string('label')
  })
  const products = defineGeneratedTable(name, { id: column.id(), price: column.integer(), stock: column.integer(), label: column.string() })
  const Product = defineModel(products, { fillable: ['price', 'stock', 'label'], timestamps: false })
  await DB.table(name).insert([
    { id: 1, price: 10, stock: 5, label: 'first' },
    { id: 2, price: 20, stock: 7, label: 'second' },
  ])
  const read = async () => (await DB.table(name).orderBy('id').get()).map(row => ({ price: Number(row.price), stock: Number(row.stock), label: row.label }))
  return { name, Product, read }
}

describe.each(drivers)('increment and decrement on a table-qualified column on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('adjusts the column through the static model increment and decrement', async () => {
    const { name, Product, read } = await createProducts(driver)

    await Product.increment(`${name}.price`, 3)
    await Product.decrement(`${name}.stock`, 2, { label: 'adjusted' })

    expect(await read()).toEqual([
      { price: 13, stock: 3, label: 'adjusted' },
      { price: 23, stock: 5, label: 'adjusted' },
    ])
  })

  it('adjusts the column through a model query incrementEach and decrementEach', async () => {
    const { name, Product, read } = await createProducts(driver)

    await Product.where('id', 1).incrementEach({ [`${name}.price`]: 4, stock: 1 })
    await Product.where('id', 2).decrementEach({ [`${name}.price`]: 5, [`${name}.stock`]: 2 })

    expect(await read()).toEqual([
      { price: 14, stock: 6, label: 'first' },
      { price: 15, stock: 5, label: 'second' },
    ])
  })

  it('adjusts the column through the table query builder', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).where('id', 1).increment(`${name}.price`)
    await DB.table(name).where('id', 2).decrement(`${name}.stock`, 3)
    await DB.table(name).where('id', 1).incrementEach({ [`${name}.stock`]: 2 })
    await DB.table(name).where('id', 2).decrementEach({ [`${name}.price`]: 1 })

    expect(await read()).toEqual([
      { price: 11, stock: 7, label: 'first' },
      { price: 19, stock: 4, label: 'second' },
    ])
  })

  it('adjusts the column through a limited table query', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(name).orderBy('id', 'desc').limit(1).increment(`${name}.price`, 5)

    expect(await read()).toEqual([
      { price: 10, stock: 5, label: 'first' },
      { price: 25, stock: 7, label: 'second' },
    ])
  })

  it('adjusts the column through the static model incrementEach and decrementEach', async () => {
    const { name, Product, read } = await createProducts(driver)

    await Product.incrementEach({ [`${name}.price`]: 2 })
    await Product.decrementEach({ [`${name}.stock`]: 1 })

    expect(await read()).toEqual([
      { price: 12, stock: 4, label: 'first' },
      { price: 22, stock: 6, label: 'second' },
    ])
  })

  it('adjusts a column qualified with the bare name of a schema-qualified table', async () => {
    const { name, read } = await createProducts(driver)
    const schemaName = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database

    await DB.table(`${schemaName}.${name}`).where('id', 1).increment(`${name}.price`, 6)
    await DB.table(`${schemaName}.${name}`).where('id', 2).decrementEach({ [`${schemaName}.${name}.stock`]: 2 })

    expect(await read()).toEqual([
      { price: 16, stock: 5, label: 'first' },
      { price: 20, stock: 5, label: 'second' },
    ])
  })

  it('keeps rejecting a JSON path target as an invalid column reference', async () => {
    const { name } = await createProducts(driver)

    await expect(DB.table(name).increment('label->a.b')).rejects.toThrow('Column reference "label->a.b" is not')
  })

  it('adjusts a column qualified with the query table alias', async () => {
    const { name, read } = await createProducts(driver)

    await DB.table(`${name} as p`).where('id', 1).increment('p.price', 2)
    await DB.table(`${name} as p`).where('id', 2).decrementEach({ 'p.stock': 1 })

    expect(await read()).toEqual([
      { price: 12, stock: 5, label: 'first' },
      { price: 20, stock: 6, label: 'second' },
    ])
  })

  it('rejects a column qualified with another table and leaves the rows unchanged', async () => {
    const { name, read } = await createProducts(driver)

    await expect(DB.table(name).increment('orders.price')).rejects.toThrow(`Cannot increment/decrement column "orders.price" outside table "${name}".`)
    await expect(DB.table(name).decrementEach({ price: 1, 'orders.stock': 1 })).rejects.toThrow(`Cannot increment/decrement column "orders.stock" outside table "${name}".`)

    expect(await read()).toEqual([
      { price: 10, stock: 5, label: 'first' },
      { price: 20, stock: 7, label: 'second' },
    ])
  })

  it('rejects adjusting the same column twice under a bare and a qualified name', async () => {
    const { name, read } = await createProducts(driver)

    await expect(DB.table(name).incrementEach({ price: 1, [`${name}.price`]: 2 })).rejects.toThrow(`Cannot increment/decrement column "price" more than once.`)

    expect(await read()).toEqual([
      { price: 10, stock: 5, label: 'first' },
      { price: 20, stock: 7, label: 'second' },
    ])
  })
})
