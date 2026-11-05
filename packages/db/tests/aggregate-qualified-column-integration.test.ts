import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineModel, defineGeneratedTable, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite' as const,
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

const kinds = ['max', 'min', 'sum', 'avg'] as const

const expected = { max: 30, min: 10, sum: 60, avg: 20 } as const

function uniqueName(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function createProducts(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const name = uniqueName('products')
  const ordersName = uniqueName('orders')
  onTestFinished(async () => {
    await schema.dropTable(ordersName)
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('price')
  })
  await schema.createTable(ordersName, (table) => {
    table.id()
    table.integer('product_id')
    table.integer('price')
  })
  await DB.table(name).insert([
    { id: 1, price: 10 },
    { id: 2, price: 20 },
    { id: 3, price: 30 },
  ])
  await DB.table(ordersName).insert([
    { id: 1, product_id: 1, price: 100 },
    { id: 2, product_id: 2, price: 200 },
    { id: 3, product_id: 3, price: 300 },
  ])
  return { name, ordersName }
}

describe.each(drivers)('aggregates on a table-qualified column on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it.each(kinds)('%s accepts a column qualified with the query table', async (kind) => {
    const { name } = await createProducts(driver)

    expect(Number(await DB.table(name)[kind](`${name}.price`))).toBe(expected[kind])
  })

  it.each(kinds)('%s accepts a column qualified with the query table alias', async (kind) => {
    const { name } = await createProducts(driver)

    expect(Number(await DB.table(`${name} as p`)[kind]('p.price'))).toBe(expected[kind])
  })

  it.each(kinds)('%s reads the own table column through a join', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const query = DB.table(name).join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
  })

  it.each(kinds)('%s reads an aliased joined table column', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const query = DB.table(`${name} as p`).join(`${ordersName} as o`, 'o.product_id', '=', 'p.id')
    expect(Number(await query[kind]('o.price'))).toBe(expected[kind] * 10)
    expect(Number(await query[kind]('p.price'))).toBe(expected[kind])
  })

  it.each(kinds)('%s reads the requested table when the query already selects both same-named columns', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const query = DB.table(name)
      .join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
      .select(`${name}.price`, `${ordersName}.price`)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
  })

  it.each(kinds)('%s reads an aliased query table through a join when qualified with its table name', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const query = DB.table(`${name} as p`).join(`${ordersName} as o`, 'o.product_id', '=', 'p.id')
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
  })

  it.each(kinds)('%s rejects a column qualified with a table the query does not join', async (kind) => {
    const { name } = await createProducts(driver)

    await expect(DB.table(name)[kind]('orders.price')).rejects.toThrow(`Cannot aggregate column "orders.price" outside table "${name}".`)
  })

  it.skipIf(driver === 'sqlite').each(kinds)('%s accepts the bare name of a schema-qualified table', async (kind) => {
    const { name } = await createProducts(driver)
    const schemaName = driver === 'postgres' ? 'public' : process.env.HOLO_MYSQL_DATABASE ?? 'mysql'

    expect(Number(await DB.table(`${schemaName}.${name}`)[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await DB.table(`${schemaName}.${name}`)[kind](`${schemaName}.${name}.price`))).toBe(expected[kind])
  })

  it.each(kinds)('%s on a model accepts a column qualified with the model table', async (kind) => {
    const { name } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    expect(await Product.query()[kind](`${name}.price`)).toBe(expected[kind])
    expect(await Product[kind](`${name}.price`)).toBe(expected[kind])
  })

  it.each(kinds)('%s on a joined model query reads the requested table', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    const query = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price` as never))).toBe(expected[kind] * 10)
    expect(Number(await query.where(`${ordersName}.price`, '>', 100)[kind](`${name}.price`))).toBe(kind === 'sum' ? 50 : kind === 'avg' ? 25 : kind === 'min' ? 20 : 30)
  })

  it.each(kinds)('%s on a model rejects a column qualified with another table', async (kind) => {
    const { name } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    await expect(Product.query()[kind]('orders.price')).rejects.toThrow(`Cannot aggregate column "orders.price" outside table "${name}".`)
  })
})
