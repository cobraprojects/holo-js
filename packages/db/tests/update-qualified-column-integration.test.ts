import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, resetDB } from '../src'
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
