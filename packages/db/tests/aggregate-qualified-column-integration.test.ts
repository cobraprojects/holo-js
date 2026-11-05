import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineModel, defineGeneratedTable, resetDB } from '../src'
import cache, { configureCacheRuntime, resetCacheRuntime } from '../../cache/src'
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
    table.integer('parent_id').nullable()
  })
  await schema.createTable(ordersName, (table) => {
    table.id()
    table.integer('product_id')
    table.integer('price')
  })
  await DB.table(name).insert([
    { id: 1, price: 10, parent_id: 3 },
    { id: 2, price: 20, parent_id: 3 },
    { id: 3, price: 30, parent_id: 3 },
  ])
  await DB.table(ordersName).insert([
    { id: 1, product_id: 1, price: 100 },
    { id: 2, product_id: 2, price: 200 },
    { id: 3, product_id: 3, price: 300 },
  ])
  return { name, ordersName }
}

describe.each(drivers)('aggregates on a table-qualified column on %s', (driver) => {
  afterEach(async () => {
    await cache.flush().catch(() => undefined)
    resetCacheRuntime()
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

  it.each(kinds)('%s reads the requested table on a joined query with a having clause', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const query = DB.table(name)
      .join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
      .select(`${name}.price`, `${ordersName}.price`)
      .groupBy(`${name}.id`, `${ordersName}.id`)
      .having('count(*)', '>', 0)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
  })

  it.each(kinds)('%s rejects a qualified column on a joined query with a union', async (kind) => {
    const { name, ordersName } = await createProducts(driver)

    const joined = () => DB.table(name).join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).select(`${name}.price`, `${ordersName}.price`)
    await expect(joined().union(joined())[kind](`${name}.price`)).rejects.toThrow(`Cannot aggregate column "${name}.price" on a joined query with a union.`)
  })

  it.each(kinds)('%s reads the query table rather than an aliased self-join', async (kind) => {
    const { name } = await createProducts(driver)

    const query = DB.table(name).join(`${name} as parent`, 'parent.id', '=', `${name}.parent_id`)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind]('parent.price'))).toBe(kind === 'sum' ? 90 : 30)
  })

  it.each(kinds)('%s keeps every row of a distinct joined query without selections', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    await DB.table(name).insert({ id: 4, price: 10 })
    await DB.table(ordersName).insert({ id: 4, product_id: 4, price: 100 })

    const query = DB.table(name).join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).distinct()
    expect(Number(await query[kind](`${name}.price`))).toBe({ max: 30, min: 10, sum: 70, avg: 17.5 }[kind])
  })

  it.each(kinds)('%s reads a schema-qualified query table through a join', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    const schemaName = driver === 'sqlite' ? 'main' : driver === 'postgres' ? 'public' : process.env.HOLO_MYSQL_DATABASE ?? 'mysql'

    const query = DB.table(`${schemaName}.${name}`).join(`${schemaName}.${ordersName}`, `${ordersName}.product_id`, '=', `${name}.id`).distinct()
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
  })

  it.skipIf(driver !== 'sqlite').each(kinds)('%s keeps the row order of an unqualified order by on a limited joined query', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    await DB.table(ordersName).delete()
    await DB.table(ordersName).insert([
      { id: 30, product_id: 1, price: 100 },
      { id: 20, product_id: 2, price: 200 },
      { id: 10, product_id: 3, price: 300 },
    ])
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    const query = DB.table(name).join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).orderBy('id').limit(1)
    expect(Number(await query[kind](`${name}.price`))).toBe(10)
    expect(await Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).orderBy('id').limit(1)[kind](`${name}.price`)).toBe(10)
  })

  it.each(kinds)('%s keeps cached joined rows and each qualified aggregate under an explicit cache key apart', async (kind) => {
    configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
    const { name, ordersName } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })
    const cacheKey = `aggregates-${name}-${kind}`

    const query = DB.table(name).join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).cache({ key: cacheKey, ttl: 60 })
    const rows = await query.get()
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${ordersName}.price`))).toBe(expected[kind] * 10)
    expect(await query.get()).toEqual(rows)

    const modelQuery = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).cache({ key: `${cacheKey}-model`, ttl: 60 })
    const modelRows = (await modelQuery.get()).map(entity => entity.toAttributes())
    expect(await modelQuery[kind](`${name}.price`)).toBe(expected[kind])
    expect((await modelQuery.get()).map(entity => entity.toAttributes())).toEqual(modelRows)
  })

  it.skipIf(driver === 'sqlite').each(kinds)('%s reads each of two same-named tables joined from different schemas', async (kind) => {
    const { name } = await createProducts(driver)
    const { adapter, schema } = await openDatabase(driver)
    const schemaName = driver === 'postgres' ? 'public' : process.env.HOLO_MYSQL_DATABASE ?? 'mysql'
    const tenant = uniqueName('holo_tenant')
    const quote = (identifier: string) => driver === 'postgres' ? `"${identifier}"` : `\`${identifier}\``
    onTestFinished(async () => {
      await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(tenant)}${driver === 'postgres' ? ' CASCADE' : ''}`)
    })
    await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(tenant)}`)
    await schema.createTable(`${tenant}.${name}`, (table) => {
      table.id()
      table.integer('price')
    })
    await DB.table(`${tenant}.${name}`).insert([{ id: 1, price: 1 }, { id: 2, price: 2 }, { id: 3, price: 3 }])

    const query = DB.table(`${schemaName}.${name}`).join(`${tenant}.${name}`, `${tenant}.${name}.id`, '=', `${schemaName}.${name}.id`)
    expect(Number(await query[kind](`${schemaName}.${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind](`${tenant}.${name}.price`))).toBe(expected[kind] / 10)
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

  it.each(kinds)('%s on a joined model query applies the model accessor to its own column', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), {
      timestamps: false,
      accessors: { price: value => Number(value) * 2 },
    })

    expect(await Product.query()[kind](`${name}.price`)).toBe(expected[kind] * 2)
    expect(await Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)[kind](`${name}.price`)).toBe(expected[kind] * 2)
    expect(await Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).select(`${ordersName}.price`)[kind](`${name}.price`)).toBe(expected[kind] * 2)
  })

  it.each(kinds)('%s on a joined model query reads the model table rather than an aliased self-join', async (kind) => {
    const { name } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer(), parent_id: column.integer().nullable() }), { timestamps: false })

    const query = Product.query().join(`${name} as parent`, 'parent.id', '=', `${name}.parent_id`)
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
  })

  it.each(kinds)('%s on a distinct joined model query keeps the selected projection', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    await DB.table(name).insert({ id: 4, price: 10 })
    await DB.table(ordersName).insert({ id: 4, product_id: 4, price: 400 })
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    const query = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).select(`${name}.price`).distinct()
    expect(Number(await query[kind](`${name}.price`))).toBe(expected[kind])
    expect(Number(await query[kind]('price'))).toBe(expected[kind])
  })

  it.each(kinds)('%s on a joined model query keeps the attributes its accessor reads', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer(), parent_id: column.integer().nullable() }), {
      timestamps: false,
      accessors: { price: (value, entity) => Number(value) * Number(entity.toAttributes().parent_id) },
    })

    const query = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
    expect(await query[kind](`${name}.price`)).toBe(expected[kind] * 3)
  })

  it.each(kinds)('%s on a joined model query gives its accessor the model attributes rather than same-named joined ones', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    await DB.table(ordersName).delete()
    await DB.table(ordersName).insert([
      { id: 101, product_id: 1, price: 100 },
      { id: 102, product_id: 2, price: 200 },
      { id: 103, product_id: 3, price: 300 },
    ])
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), {
      timestamps: false,
      accessors: { price: (value, entity) => Number(value) * Number(entity.toAttributes().id) },
    })

    const query = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`)
    const expectedWithId = { max: 90, min: 10, sum: 140, avg: 140 / 3 }[kind]
    expect(await query[kind](`${name}.price`)).toBe(expectedWithId)
    expect(await query.select(`${name}.*`, `${ordersName}.*`)[kind](`${name}.price`)).toBe(expectedWithId)
    const explicit = query.select(`${name}.id`, `${name}.price`, `${ordersName}.id`, `${ordersName}.price`)
    expect(await explicit.distinct()[kind](`${name}.price`)).toBe(expectedWithId)
    expect(await explicit.groupBy(`${name}.id`, `${ordersName}.id`)[kind](`${name}.price`)).toBe(expectedWithId)
    expect(await query.select(`${name}.id as id`, `${name}.price`, `${ordersName}.id`).distinct()[kind](`${name}.price`)).toBe(expectedWithId)
  })

  it.each(kinds)('%s on a joined model query keeps an order by on a selected output column', async (kind) => {
    const { name, ordersName } = await createProducts(driver)
    await DB.table(ordersName).delete()
    await DB.table(ordersName).insert([
      { id: 103, product_id: 1, price: 100 },
      { id: 102, product_id: 2, price: 200 },
      { id: 101, product_id: 3, price: 300 },
    ])
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    const query = Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).select(`${ordersName}.id`).orderBy('id').limit(1)
    if (driver === 'sqlite') {
      await expect(query.get()).rejects.toThrow('ambiguous column name: id')
      await expect(query[kind](`${name}.price`)).rejects.toThrow('ambiguous column name: id')
    }
    else {
      expect(await query[kind](`${name}.price`)).toBe(30)
    }
    await expect(Product.query().join(ordersName, `${ordersName}.product_id`, '=', `${name}.id`).select(`${ordersName}.price`).orderBy('price')[kind](`${name}.price`))
      .rejects.toThrow(`Cannot aggregate column "${name}.price" while ordering by "price", which names another selected column. Qualify the order by column.`)
  })

  it.each(kinds)('%s on a model rejects a column qualified with another table', async (kind) => {
    const { name } = await createProducts(driver)
    const Product = defineModel(defineGeneratedTable(name, { id: column.id(), price: column.integer() }), { timestamps: false })

    await expect(Product.query()[kind]('orders.price')).rejects.toThrow(`Cannot aggregate column "orders.price" outside table "${name}".`)
  })
})
