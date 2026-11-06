import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { CompilerError, DB, clearGeneratedTables, column, defineModel, defineGeneratedTable, registerGeneratedTables, resetDB } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase } from './support/database'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'])

function uniqueName(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`
}

async function createFixture(driver: typeof drivers[number], options: Parameters<typeof openDatabase>[1] = {}) {
  const { schema } = await openDatabase(driver, options)
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
  return { schema, products, orders, table, Product, joined }
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
    await expect(joined().select(`${products}.id`, `${orders}.price as price` as never).groupBy(`${products}.id`, `${orders}.price`).get())
      .rejects.toThrow(collision(`${orders}.price as price`, 'price', products))
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
    expect(attributes(await explicit.union(joined().select(`${orders}.*`, `${products}.*`).where(`${orders}.id`, 102)).get())).toEqual([ownRows[0], { ...ownRows[1]!, factor: 8 }])
    const withOrderId = joined().select(`${products}.*`, `${orders}.id as order_id` as never)
    await expect(withOrderId.union(joined().select(`${orders}.id as order_id` as never, `${products}.*`)).get()).rejects.toThrow(
      `Cannot combine a joined "${products}" model query with a union whose selections don't line up with its own. Select the same tables' columns in the same order in each query.`,
    )
    await expect(joined().select(`${products}.*`).union(joined().select(`${products}.price`, `${orders}.id`)).get()).rejects.toThrow(collision(`${orders}.id`, 'id', products))
  })

  it('keeps the model columns across nested unions of joined queries', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const nested = joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101)
      .union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 102).union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101)))
    expect(attributes(await nested.get())).toEqual(ownRows)
    const withOrderId = () => joined().select(`${products}.*`, `${orders}.id as order_id` as never)
    await expect(withOrderId().union(withOrderId().union(joined().select(`${orders}.id as order_id` as never, `${products}.*`))).get())
      .rejects.toThrow(`Cannot combine a joined "${products}" model query with a union whose selections don't line up with its own.`)
  })

  it('orders a union of joined queries by the model column', async () => {
    const { products, orders, joined } = await createFixture(driver)
    await DB.table(orders).where('id', 101).update({ id: 103 })

    const ownOnly = joined().select(`${products}.*`).where(`${orders}.id`, 102).union(joined().select(`${products}.*`).where(`${orders}.id`, 103)).orderBy('id')
    expect(attributes(await ownOnly.get()).map(({ id, price }) => [id, price])).toEqual([[1, 10], [2, 20]])
    const aliased = joined().select(`${products}.*`, `${orders}.id as order_id` as never).where(`${orders}.id`, 102)
      .union(joined().select(`${products}.*`, `${orders}.id as order_id` as never).where(`${orders}.id`, 103)).orderBy('id')
    expect((await aliased.get()).map(entity => [Number(entity.toAttributes().id), Number((entity.toAttributes() as Record<string, unknown>).order_id)])).toEqual([[1, 103], [2, 102]])

    const union = joined().where(`${orders}.id`, 102).union(joined().where(`${orders}.id`, 103)).orderBy('id')
    if (driver !== 'sqlite') {
      await expect(union.get()).rejects.toThrow(driver === 'postgres' ? 'ORDER BY "id" is ambiguous' : `Column 'id' in order clause is ambiguous`)
      return
    }
    expect((await union.get()).map(entity => Number(entity.toAttributes().id))).toEqual([1, 2])
    expect(attributes(await union.limit(1).get())).toEqual([ownRows[0]])
    expect(await DB.table(products).count()).toBe(2)
  })

  it('keeps a computed selection that replaces a model column after the model columns', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const parent = DB.table(`${products} as inner_products`).select('inner_products.parent_id').whereColumn('inner_products.id', `${products}.id`)
    const rows = await joined().select(`${products}.*`).addSelectSub(parent as never, 'price').addSelect(`${orders}.id as order_id` as never).get()
    expect(rows.map(row => [Number(row.toAttributes().id), Number(row.toAttributes().price)]).sort((left, right) => left[0]! - right[0]!)).toEqual([[1, 3], [2, 3]])
    const wildcard = await joined().select(`${products}.*`).addSelectSub(parent as never, 'price').addSelect(`${orders}.*`).get()
    expect(wildcard.map(row => [Number(row.toAttributes().id), Number(row.toAttributes().price)]).sort((left, right) => left[0]! - right[0]!)).toEqual([[1, 3], [2, 3]])

    registerGeneratedTables({ [orders]: defineGeneratedTable(orders, { id: column.id(), product_id: column.integer(), price: column.integer(), parent_id: column.integer().nullable(), factor: column.integer().nullable() }) })
    onTestFinished(() => clearGeneratedTables())
    const known = await joined().select(`${products}.*`).addSelectSub(parent as never, 'price').addSelect(`${orders}.*`).get()
    expect(known.map(row => [Number(row.toAttributes().id), Number(row.toAttributes().price), Number(row.toAttributes().factor)]).sort((left, right) => left[0]! - right[0]!)).toEqual([[1, 3, 2], [2, 3, 4]])
  })

  it('cursor paginates a joined query by the model key and by a joined column', async () => {
    const { products, orders, joined } = await createFixture(driver)
    await DB.table(orders).where('id', 101).update({ product_id: 2 })
    await DB.table(orders).where('id', 102).update({ product_id: 1 })

    const pages = async (query: ReturnType<typeof joined>) => {
      const seen: Record<string, unknown>[][] = []
      let cursor: string | null = null
      do {
        const page = await query.cursorPaginate(1, cursor)
        seen.push(attributes(page.data))
        cursor = page.nextCursor
      } while (cursor !== null && seen.length < 4)
      return seen.map(rows => rows.map(row => [row.id, row.product_id]))
    }
    expect(await pages(joined())).toEqual([[[1, 1]], [[2, 2]]])
    expect(await pages(joined().orderBy(`${orders}.id`))).toEqual([[[2, 2]], [[1, 1]]])
    expect(await pages(joined().select(`${products}.*`, `${orders}.id`, `${orders}.product_id` as never).orderBy(`${orders}.id`))).toEqual([[[2, 2]], [[1, 1]]])
    expect(await pages(joined().select('*' as never).orderBy(`${orders}.id`))).toEqual([[[2, 2]], [[1, 1]]])
    const taken = await joined().select(`${products}.*`, `${orders}.product_id as __holo_cursor_0` as never).orderBy(`${orders}.id`).cursorPaginate(2)
    expect(taken.data.map(entity => [Number(entity.toAttributes().id), Number((entity.toAttributes() as Record<string, unknown>).__holo_cursor_0)])).toEqual([[2, 2], [1, 1]])
    const aliased = () => joined().select(`${products}.*`, `${orders}.id as order_id` as never)
    const union = aliased().where(`${orders}.id`, 101).union(aliased().where(`${orders}.id`, 102)).orderBy('order_id' as never)
    if (driver === 'sqlite') expect(attributes((await union.cursorPaginate(1)).data).map(row => row.id)).toEqual([2])
    const unaliased = joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 101).union(joined().select(`${products}.*`, `${orders}.*`).where(`${orders}.id`, 102)).orderBy(`${orders}.id`)
    await expect(joined().select(`${products}.*`).orderBy(`${orders}.id`).cursorPaginate(1)).rejects.toThrow('Cursor pagination requires selected orderBy columns.')
    await expect(joined().select(`${products}.*`, `${orders}.*`).distinct().orderBy(`${orders}.id`).cursorPaginate(1)).rejects.toThrow(`Cannot cursor paginate a distinct or grouped joined "${products}" model query by "${orders}.id". Select it under an alias and order by that alias.`)
    await expect(joined().groupBy(`${products}.id`, `${orders}.id`).orderBy(`${orders}.id`).cursorPaginate(1)).rejects.toThrow(`Cannot cursor paginate a distinct or grouped joined "${products}" model query by "${orders}.id". Select it under an alias and order by that alias.`)
    await expect(unaliased.cursorPaginate(1)).rejects.toThrow(`Cannot cursor paginate a union of joined "${products}" model queries by "${orders}.id". Select it under an alias in each query and order by that alias.`)
    expect(await pages(joined().select(`${orders}.id as order_id` as never, `${orders}.product_id` as never, `${products}.*`).orderBy(`${orders}.id`, 'desc'))).toEqual([[[1, 1]], [[2, 2]]])
  })

  it('orders a union of joined queries by a model column a joined table does not have', async () => {
    const { schema, products, Product } = await createFixture(driver)
    const labels = uniqueName('labels')
    onTestFinished(async () => {
      await schema.dropTable(labels)
    })
    await schema.createTable(labels, (table) => {
      table.integer('product_id')
      table.string('label')
    })
    await DB.table(labels).insert([{ product_id: 1, label: 'one' }, { product_id: 2, label: 'two' }])

    const labelled = () => Product.query().join(labels, `${labels}.product_id`, '=', `${products}.id`).select(`${products}.*`, `${labels}.*`)
    const union = labelled().where(`${labels}.label` as never, 'two').union(labelled().where(`${labels}.label` as never, 'one')).orderBy('id')
    expect((await union.get()).map(entity => [Number(entity.toAttributes().id), (entity.toAttributes() as Record<string, unknown>).label])).toEqual([[1, 'one'], [2, 'two']])

    const keyed = Product.query().join(labels, `${labels}.product_id`, '=', `${products}.id`).select('id as product_key' as never, 'price').orderBy('id')
    const first = await keyed.cursorPaginate(1)
    const second = await keyed.cursorPaginate(1, first.nextCursor)
    expect([first, second].map(page => page.data.map(entity => Number((entity.toAttributes() as Record<string, unknown>).product_key)))).toEqual([[1], [2]])
  })

  it('keeps the precedence of outputs that are not model columns', async () => {
    const { schema, products, Product } = await createFixture(driver)
    const notes = uniqueName('notes')
    onTestFinished(async () => {
      await schema.dropTable(notes)
    })
    await schema.createTable(notes, (table) => {
      table.integer('product_id')
      table.string('label')
    })
    await DB.table(notes).insert([{ product_id: 1, label: 'first' }, { product_id: 2, label: 'second' }])

    const rows = await Product.query().join(notes, `${notes}.product_id`, '=', `${products}.id`).select(`${products}.price as label` as never, `${products}.*`, `${notes}.*`).get()
    expect(rows.map(entity => [Number(entity.toAttributes().id), (entity.toAttributes() as Record<string, unknown>).label]).sort((left, right) => Number(left[0]) - Number(right[0]))).toEqual([[1, 'first'], [2, 'second']])

    registerGeneratedTables({ [notes]: defineGeneratedTable(notes, { product_id: column.integer(), label: column.string() }) })
    onTestFinished(() => clearGeneratedTables())
    const known = await Product.query().join(notes, `${notes}.product_id`, '=', `${products}.id`).select(`${products}.*`, `${products}.price as label` as never, `${notes}.*`).get()
    expect(known.map(entity => [Number(entity.toAttributes().id), (entity.toAttributes() as Record<string, unknown>).label]).sort((left, right) => Number(left[0]) - Number(right[0]))).toEqual([[1, 'first'], [2, 'second']])
  })

  it('applies model casts to the model columns of a joined query', async () => {
    const { table, products, orders } = await createFixture(driver)
    const CastProduct = defineModel(table, { timestamps: false, casts: { price: 'string', factor: 'string' } })

    const rows = await CastProduct.query().join(orders, `${orders}.product_id`, '=', `${products}.id`).get()
    expect(rows.map(entity => [entity.get('price'), entity.get('factor')]).sort()).toEqual([['10', '2'], ['20', '4']])
  })

  it('reads a cursor from an aliased selection of the qualified order column', async () => {
    const { products, orders } = await createFixture(driver)

    const query = DB.table(products).select('id as product_key', 'price').orderBy(`${products}.id`)
    const first = await query.cursorPaginate(1)
    const second = await query.cursorPaginate(1, first.nextCursor)
    expect([first, second].map(page => page.data.map(row => Number(row.product_key)))).toEqual([[1], [2]])

    const overwritten = DB.table(products).select('id', 'id as factor', 'factor').orderBy(`${products}.id`)
    const page = await overwritten.cursorPaginate(1)
    const next = await overwritten.cursorPaginate(1, page.nextCursor)
    expect([page, next].map(result => result.data.map(row => [Number(row.id), Number(row.factor)]))).toEqual([[[1, 2]], [[2, 4]]])

    const wildcard = DB.table(products).select('id as factor', `${products}.*`).orderBy(`${products}.id`)
    const wildcardPage = await wildcard.cursorPaginate(1)
    const wildcardNext = await wildcard.cursorPaginate(1, wildcardPage.nextCursor)
    expect([wildcardPage, wildcardNext].map(result => result.data.map(row => Number(row.id)))).toEqual([[1], [2]])

    const replaced = DB.table(products).select(`${products}.id as product_key`, 'id', 'price as id').orderBy(`${products}.id`)
    const replacedPage = await replaced.cursorPaginate(1)
    const replacedNext = await replaced.cursorPaginate(1, replacedPage.nextCursor)
    expect([replacedPage, replacedNext].map(result => result.data.map(row => Number(row.product_key)))).toEqual([[1], [2]])

    const shadowed = DB.table(products).join(orders, `${orders}.product_id`, '=', `${products}.id`).select(`${products}.id as product_key`, `${products}.id`, `${orders}.*`).orderBy(`${products}.id`)
    const shadowedPage = await shadowed.cursorPaginate(1)
    const shadowedNext = await shadowed.cursorPaginate(1, shadowedPage.nextCursor)
    expect([shadowedPage, shadowedNext].map(result => result.data.map(row => Number(row.product_key)))).toEqual([[1], [2]])
  })

  it('keeps the precedence of non-model outputs of a joined wildcard that also shadows a model column', async () => {
    const { schema, products, Product } = await createFixture(driver)
    const notes = uniqueName('notes')
    onTestFinished(async () => {
      await schema.dropTable(notes)
    })
    await schema.createTable(notes, (table) => {
      table.integer('id')
      table.integer('product_id')
      table.string('label')
    })
    await DB.table(notes).insert([{ id: 11, product_id: 1, label: 'first' }, { id: 12, product_id: 2, label: 'second' }])
    registerGeneratedTables({ [notes]: defineGeneratedTable(notes, { id: column.integer(), product_id: column.integer(), label: column.string() }) })
    onTestFinished(() => clearGeneratedTables())

    const labelled = () => Product.query().join(notes, `${notes}.product_id`, '=', `${products}.id`).select(`${products}.*`, `${products}.price as label` as never, `${notes}.*`)
    const read = (rows: readonly { toAttributes(): Record<string, unknown> }[]) => rows
      .map(entity => [Number(entity.toAttributes().id), Number(entity.toAttributes().price), entity.toAttributes().label])
      .sort((left, right) => Number(left[0]) - Number(right[0]))
    expect(read(await labelled().get())).toEqual([[1, 10, 'first'], [2, 20, 'second']])
    expect(read(await labelled().distinct().get())).toEqual([[1, 10, 'first'], [2, 20, 'second']])
    expect(read(await labelled().where(`${notes}.id` as never, 11).union(labelled().where(`${notes}.id` as never, 12)).get())).toEqual([[1, 10, 'first'], [2, 20, 'second']])
  })

  it('reads a cursor from a surviving alias when a raw selection may replace the order column', async () => {
    const { products } = await createFixture(driver, { security: { allowUnsafeRawSql: true } })

    const raw = DB.table(products).select(`${products}.id as product_key`, `${products}.id`).addUnsafeSelect('price AS id', []).orderBy(`${products}.id`)
    const rawPage = await raw.cursorPaginate(1)
    const rawNext = await raw.cursorPaginate(1, rawPage.nextCursor)
    expect([rawPage, rawNext].map(result => result.data.map(row => Number(row.product_key)))).toEqual([[1], [2]])
  })

  it('reads a cursor from a joined column selected under another qualifier of the same table', async () => {
    const { products, orders } = await createFixture(driver)
    const schemaName = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : mysqlTestConnection().database

    const query = DB.table(products).join(`${schemaName}.${orders}`, `${orders}.product_id`, '=', `${products}.id`).select(`${products}.id`, `${orders}.price`).orderBy(`${schemaName}.${orders}.price`)
    const first = await query.cursorPaginate(1)
    const second = await query.cursorPaginate(1, first.nextCursor)
    expect([first, second].map(page => page.data.map(row => Number(row.price)))).toEqual([[100], [200]])
  })

  it('unions joined model queries that select the same model columns in different notation', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const union = joined().select(`${products}.*`).where(`${orders}.id`, 101)
      .union(joined().select(`${products}.id`, `${products}.price`, `${products}.parent_id`, `${products}.factor`).where(`${orders}.id`, 102))
    expect((await union.get()).map(entity => Number(entity.toAttributes().id)).sort()).toEqual([1, 2])
  })

  it('shows the projected SQL that a joined model query runs', async () => {
    const { products, orders, joined } = await createFixture(driver)

    const query = joined().orderBy('id')
    expect(query.toSQL().sql).not.toMatch(/^SELECT \*/)
    expect(query.debug().sql).toBe(query.toSQL().sql)
    expect(query.toRawSql()).toMatch(/^SELECT [`"]/)
    expect(query.toSQL().sql.indexOf(products, query.toSQL().sql.indexOf('ORDER BY'))).toBeGreaterThan(-1)
    expect(() => joined().select(`${products}.price`, `${orders}.id as id` as never).toSQL()).toThrow(collision(`${orders}.id as id`, 'id', products))
  })

  it('keeps a joined column that shares a hidden cursor alias name', async () => {
    const { schema, products, Product } = await createFixture(driver)
    const notes = uniqueName('notes')
    onTestFinished(async () => {
      await schema.dropTable(notes)
    })
    await schema.createTable(notes, (table) => {
      table.integer('note_id')
      table.integer('product_id')
      table.integer('__holo_cursor_0')
    })
    await DB.table(notes).insert([{ note_id: 2, product_id: 1, __holo_cursor_0: 7 }, { note_id: 1, product_id: 2, __holo_cursor_0: 8 }])
    registerGeneratedTables({ [notes]: defineGeneratedTable(notes, { note_id: column.integer(), product_id: column.integer(), __holo_cursor_0: column.integer() }) })
    onTestFinished(() => clearGeneratedTables())

    const page = await Product.query().join(notes, `${notes}.product_id`, '=', `${products}.id`).orderBy(`${notes}.note_id` as never).cursorPaginate(2)
    expect(page.data.map(entity => [Number(entity.toAttributes().id), Number((entity.toAttributes() as Record<string, unknown>).__holo_cursor_0)])).toEqual([[2, 8], [1, 7]])

    const sub = DB.table(notes).select('note_id', 'product_id', '__holo_cursor_0')
    const subPage = await Product.query().joinSub(sub as never, 'n', 'n.product_id' as never, '=', `${products}.id`).orderBy('n.note_id' as never).cursorPaginate(2)
    expect(subPage.data.map(entity => [Number(entity.toAttributes().id), Number((entity.toAttributes() as Record<string, unknown>).__holo_cursor_0)])).toEqual([[2, 8], [1, 7]])

    const links = uniqueName('links')
    onTestFinished(async () => {
      await schema.dropTable(links)
    })
    await schema.createTable(links, (table) => {
      table.integer('owner_note')
      table.string('tag')
    })
    await DB.table(links).insert([{ owner_note: 1, tag: 'a' }, { owner_note: 2, tag: 'b' }])
    registerGeneratedTables({ [links]: defineGeneratedTable(links, { owner_note: column.integer(), tag: column.string() }) })
    const joinedSub = DB.table(links).join(notes, `${notes}.note_id`, '=', `${links}.owner_note`)
    const joinedSubPage = await Product.query().joinSub(joinedSub as never, 'n', 'n.product_id' as never, '=', `${products}.id`).orderBy('n.note_id' as never).cursorPaginate(2)
    expect(joinedSubPage.data.map(entity => [Number(entity.toAttributes().id), Number((entity.toAttributes() as Record<string, unknown>).__holo_cursor_0)])).toEqual([[2, 8], [1, 7]])
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
