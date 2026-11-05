import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CompilerError, DB, clearGeneratedTables, column, defineModel, defineGeneratedTable, registerGeneratedTables, resetDB } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

function uniqueName(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function createFixture(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const products = uniqueName('products')
  const orders = uniqueName('orders')
  onTestFinished(async () => {
    await schema.dropTable(orders)
    await schema.dropTable(products)
  })
  await schema.createTable(products, (table) => {
    table.id()
    table.integer('price')
    table.integer('parent_id').nullable()
    table.integer('factor').nullable()
  })
  await schema.createTable(orders, (table) => {
    table.id()
    table.integer('product_id')
    table.integer('price')
    table.integer('parent_id').nullable()
    table.integer('factor').nullable()
  })
  await DB.table(products).insert([
    { id: 1, price: 10, parent_id: 3, factor: 2 },
    { id: 2, price: 20, parent_id: 3, factor: 4 },
  ])
  await DB.table(orders).insert([
    { id: 101, product_id: 1, price: 100, parent_id: 1, factor: 7 },
    { id: 102, product_id: 2, price: 200, parent_id: 1, factor: 5 },
  ])
  const table = defineGeneratedTable(products, {
    id: column.id(),
    price: column.integer(),
    parent_id: column.integer().nullable(),
    factor: column.integer().nullable(),
  })
  const Product = defineModel(table, {
    timestamps: false,
    fillable: ['factor'],
    accessors: { price: (value, entity) => Number(value) * Number(entity.toAttributes().parent_id) },
  })
  const joined = () => Product.query().join(orders, `${orders}.product_id`, '=', `${products}.id`)
  return { products, orders, table, Product, joined }
}

function attributes(entities: readonly { toAttributes(): Record<string, unknown> }[]) {
  return entities
    .map(entity => entity.toAttributes())
    .map(({ id, price, parent_id, factor, product_id }) => ({ id: Number(id), price: Number(price), parent_id: Number(parent_id), factor: Number(factor), product_id: Number(product_id) }))
    .sort((left, right) => left.id - right.id)
}

const ownRows = [
  { id: 1, price: 10, parent_id: 3, factor: 2, product_id: 1 },
  { id: 2, price: 20, parent_id: 3, factor: 4, product_id: 2 },
]

function collision(selection: string, name: string, table: string) {
  return `Cannot select "${selection}" on a joined "${table}" model query: "${name}" is a "${table}" column. Qualify or alias it to a non-model name.`
}

describe.each(drivers)('joined model queries keep the model columns on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('hydrates the model columns rather than same-named joined columns without a selection', async () => {
    const { orders, joined } = await createFixture(driver)

    expect(attributes(await joined().get())).toEqual(ownRows)
    expect(attributes(await joined().distinct().get())).toEqual(ownRows)
    expect(attributes([(await joined().where(`${orders}.id`, 101).first())!])).toEqual([ownRows[0]])
    expect(attributes((await joined().paginate(10)).data)).toEqual(ownRows)
    const chunks: Record<string, unknown>[][] = []
    await joined().chunk(10, (rows) => {
      chunks.push(attributes(rows))
    })
    expect(chunks).toEqual([ownRows])
    const lazy: { toAttributes(): Record<string, unknown> }[] = []
    for await (const entity of joined().lazy(10)) lazy.push(entity)
    expect(attributes(lazy)).toEqual(ownRows)
  })

  it('hydrates the model columns when both tables are selected with wildcards', async () => {
    const { products, orders, joined } = await createFixture(driver)

    expect(attributes(await joined().select(`${products}.*`, `${orders}.*`).get())).toEqual(ownRows)
    expect(attributes(await joined().select(`${products}.*`, `${orders}.*`).distinct().get())).toEqual(ownRows)
    expect(attributes(await joined().select(`${orders}.*`, `${products}.*`).get())).toEqual(ownRows)
    expect(attributes(await joined().groupBy(`${products}.id`, `${orders}.id`).get())).toEqual(ownRows)
  })

  it('reads the model columns in unqualified aggregates', async () => {
    const { products, orders, joined } = await createFixture(driver)

    expect(await joined().sum('price')).toBe(90)
    expect(await joined().avg('price')).toBe(45)
    expect(await joined().min('price')).toBe(30)
    expect(await joined().max('price')).toBe(60)
    expect(await joined().distinct().sum('price')).toBe(90)
    expect(await joined().select(`${products}.*`, `${orders}.*`).sum('price')).toBe(90)
    expect(await joined().select(`${products}.*`, `${orders}.*`).distinct().sum('price')).toBe(90)
    expect(await joined().groupBy(`${products}.id`, `${orders}.id`).sum('price')).toBe(90)
    expect(await joined().sum(`${products}.price`)).toBe(90)
  })

  it('keeps the model column when a joined column of the same name is also selected', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const rows = await joined().select(`${products}.id`, `${products}.price`, `${products}.parent_id`, `${orders}.id`, `${orders}.parent_id`).get()
    expect(rows.map(row => [Number(row.toAttributes().id), Number(row.toAttributes().parent_id)]).sort()).toEqual([[1, 3], [2, 3]])
    expect(await joined().select(`${products}.*`, `${orders}.id`, `${orders}.price`).sum('price')).toBe(90)
  })

  it('rejects a joined column aliased to a model column', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const parent = joined().select('parent_id', `${products}.price`, `${orders}.product_id as parent_id` as never).distinct()
    const message = collision(`${orders}.product_id as parent_id`, 'parent_id', products)
    await expect(parent.get()).rejects.toThrow(CompilerError)
    await expect(parent.get()).rejects.toThrow(message)
    await expect(parent.first()).rejects.toThrow(message)
    await expect(parent.paginate(10)).rejects.toThrow(message)
    await expect(parent.sum('price')).rejects.toThrow(message)
    await expect(parent.sum(`${products}.price`)).rejects.toThrow(message)

    const id = joined().select(`${products}.price`, `${orders}.id as id` as never).orderBy('id').limit(1)
    await expect(id.get()).rejects.toThrow(collision(`${orders}.id as id`, 'id', products))
    await expect(id.sum(`${products}.price`)).rejects.toThrow(collision(`${orders}.id as id`, 'id', products))

    await expect(joined().select(`${products}.price`, 'factor', `${orders}.factor as factor` as never).distinct().sum(`${products}.price`))
      .rejects.toThrow(collision(`${orders}.factor as factor`, 'factor', products))
    await expect(joined().select(`${orders}.factor as factor` as never).orderBy('factor').sum(`${products}.price`))
      .rejects.toThrow(collision(`${orders}.factor as factor`, 'factor', products))
  })

  it('rejects an unaliased joined column named like a model column the query does not select', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const query = joined().select(`${products}.price`, `${orders}.id`)
    await expect(query.get()).rejects.toThrow(collision(`${orders}.id`, 'id', products))
    await expect(query.sum('price')).rejects.toThrow(collision(`${orders}.id`, 'id', products))
    await expect(joined().select(`${orders}.parent_id`, `${products}.price`).sum(`${products}.price`)).rejects.toThrow(collision(`${orders}.parent_id`, 'parent_id', products))
  })

  it('rejects a joined wildcard that would replace model columns the query does not select', async () => {
    const { products, orders, joined } = await createFixture(driver)

    await expect(joined().select(`${orders}.*`).get()).rejects.toThrow(
      `Cannot select "${orders}.*" on a joined "${products}" model query: its columns may replace "${products}" columns the query doesn't select. Select "${products}.*" too, or select the joined columns by name.`,
    )
    await expect(joined().select(`${orders}.*`).sum('price')).rejects.toThrow(CompilerError)

    registerGeneratedTables({ [orders]: defineGeneratedTable(orders, { id: column.id(), product_id: column.integer(), price: column.integer(), parent_id: column.integer().nullable(), factor: column.integer().nullable() }) })
    onTestFinished(() => clearGeneratedTables())
    await expect(joined().select(`${orders}.*`).get()).rejects.toThrow(collision(`${orders}.*`, 'id', products))
    await expect(joined().select(`${products}.price`, `${orders}.*`).first()).rejects.toThrow(collision(`${orders}.*`, 'id', products))
    const rows = await joined().select(`${products}.id`, `${products}.price`, `${products}.parent_id`, `${products}.factor`, `${orders}.*`).get()
    expect(attributes(rows)).toEqual(ownRows)
  })

  it('keeps the model columns across a union of joined queries', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const union = joined().where(`${orders}.id`, 101).union(joined().where(`${orders}.id`, 102))
    expect(attributes(await union.get())).toEqual(ownRows)
    expect(await union.sum('price')).toBe(90)
    const product = (await union.get()).find(entity => Number(entity.toAttributes().id) === 2)!
    product.set('factor', 8)
    await product.save()
    expect((await DB.table(products).orderBy('id').get()).map(row => [Number(row.id), Number(row.factor)])).toEqual([[1, 2], [2, 8]])

    const explicit = joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101)
    expect(attributes(await explicit.union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 102)).get())).toEqual([ownRows[0], { ...ownRows[1]!, factor: 8 }])
    await expect(explicit.union(joined().select(`${orders}.*`, `${products}.*`)).get()).rejects.toThrow(
      `Cannot combine a joined "${products}" model query with a union whose selections don't line up with its own. Select the same tables' columns in the same order in each query.`,
    )
    await expect(joined().select(`${products}.*`).union(joined().select(`${products}.price`, `${orders}.id`)).get()).rejects.toThrow(collision(`${orders}.id`, 'id', products))
  })

  it('keeps the model columns across nested unions of joined queries', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const nested = joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101)
      .union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 102).union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101)))
    expect(attributes(await nested.get())).toEqual(ownRows)
    await expect(joined().select(`${products}.*`, `${orders}.*`).union(joined().select(`${products}.*`, `${orders}.*`).union(joined().select(`${orders}.*`, `${products}.*`))).get())
      .rejects.toThrow(`Cannot combine a joined "${products}" model query with a union whose selections don't line up with its own.`)
  })

  it('orders a union of joined queries by the model column', async () => {
    const { products, orders, joined } = await createFixture(driver)
    await DB.table(orders).where('id', 101).update({ id: 103 })

    const union = joined().where(`${orders}.id`, 102).union(joined().where(`${orders}.id`, 103)).orderBy('id')
    if (driver !== 'sqlite') {
      await expect(union.get()).rejects.toThrow(driver === 'postgres' ? 'ORDER BY "id" is ambiguous' : `Column 'id' in order clause is ambiguous`)
      return
    }
    expect((await union.get()).map(entity => Number(entity.toAttributes().id))).toEqual([1, 2])
    expect(attributes(await union.limit(1).get())).toEqual([ownRows[0]])
    expect(await DB.table(products).count()).toBe(2)
  })

  it('accepts a joined column aliased to a name that is not a model column', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const rows = await joined().select(`${products}.*`, `${orders}.id as order_id` as never, `${orders}.price as order_price` as never).get()
    expect(rows.map(row => {
      const { id, price, order_id, order_price } = row.toAttributes() as Record<string, unknown>
      return [Number(id), Number(price), Number(order_id), Number(order_price)]
    }).sort((left, right) => left[0]! - right[0]!)).toEqual([[1, 10, 101, 100], [2, 20, 102, 200]])
  })

  it('saves a model hydrated from a joined query to its own row', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const product = (await joined().where(`${orders}.id`, 101).first())!
    product.set('factor', 9)
    await product.save()

    expect((await DB.table(products).orderBy('id').get()).map(row => [Number(row.id), Number(row.factor)])).toEqual([[1, 9], [2, 4]])
    expect((await DB.table(orders).orderBy('id').get()).map(row => [Number(row.id), Number(row.factor)])).toEqual([[101, 7], [102, 5]])
  })
})
