import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { clearGeneratedTables, defineModel, holoRuntimeInternals, renderGeneratedSchemaModule, renderGeneratedSchemaRuntimeModule, resetDB, type DatabaseContext, type SchemaService, type TableDefinition } from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

type Driver = typeof drivers[number]

const labelExpressions = {
  sqlite: 'name || \' (it\'\'s)\'',
  postgres: 'name || \' (it\'\'s)\'',
  mysql: 'concat(name, \' (it\'\'s)\')',
} as const

const rawTables = {
  sqlite: (name: string) => `CREATE TABLE "${name}" (
    "id" integer PRIMARY KEY,
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "area" integer GENERATED ALWAYS AS (width * height) STORED,
    "perimeter" integer AS (2 * (width + height)) VIRTUAL
  )`,
  postgres: (name: string) => `CREATE TABLE "${name}" (
    "id" serial PRIMARY KEY,
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "area" integer NOT NULL GENERATED ALWAYS AS (width * height) STORED
  )`,
  mysql: (name: string) => `CREATE TABLE \`${name}\` (
    \`id\` int AUTO_INCREMENT PRIMARY KEY,
    \`width\` int NOT NULL,
    \`height\` int NOT NULL,
    \`area\` int GENERATED ALWAYS AS (width * height) STORED NOT NULL,
    \`perimeter\` int AS (2 * (width + height)) VIRTUAL
  )`,
} as const

async function createProductsTable(schema: SchemaService, driver: Driver, name: string): Promise<void> {
  await schema.createTable(name, (table) => {
    table.id()
    table.integer('price')
    table.integer('quantity')
    table.string('name')
    table.string('note').nullable()
    table.integer('total').storedAs('price * quantity')
    const label = table.string('label')
    if (driver === 'postgres') label.storedAs(labelExpressions[driver])
    else label.virtualAs(labelExpressions[driver])
  })
}

async function openComputedDatabase(driver: Driver) {
  const opened = await openDatabase(driver)
  const names = { products: `computed_builder_${driver}`, shapes: `computed_raw_${driver}` }
  const drop = async () => {
    for (const name of Object.values(names)) {
      if (await opened.schema.hasTable(name)) await opened.schema.dropTable(name)
    }
  }
  await drop()
  onTestFinished(drop)
  await createProductsTable(opened.schema, driver, names.products)
  await opened.db.executeCompiled({ sql: rawTables[driver](names.shapes), source: 'test:computed-columns' })
  return { ...opened, names }
}

async function readTables(db: DatabaseContext, names: readonly string[]): Promise<TableDefinition[]> {
  const reader = createSchemaReader(db)
  return Promise.all(names.map(async name => (await reader.readTable(name))!))
}

async function reloadGeneratedSchema(tables: readonly TableDefinition[]): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'holo-computed-columns-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const modulePath = join(directory, 'schema.generated.ts')
  await writeFile(modulePath, renderGeneratedSchemaRuntimeModule(tables))
  await import(pathToFileURL(modulePath).href)
}

describe.each(drivers)('computed columns on %s', (driver) => {
  afterEach(() => {
    clearGeneratedTables()
    resetDB()
  })

  it('writes computed columns made by storedAs, virtualAs or raw SQL to the Generated schema as storedAs and virtualAs', async () => {
    const { db, names } = await openComputedDatabase(driver)

    const tables = await readTables(db, [names.products, names.shapes])

    await expect(renderGeneratedSchemaModule(tables)).toMatchFileSnapshot(`./fixtures/computed-columns/${driver}.generated.ts`)
  })

  it('makes storedAs and virtualAs columns nullable on sqlite and mysql unless notNull() declares them, and not null on postgres', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `computed_nullability_${driver}`
    const computedAs = driver === 'postgres' ? 'storedAs' : 'virtualAs'
    onTestFinished(async () => {
      if (await schema.hasTable(name)) await schema.dropTable(name)
    })

    await schema.createTable(name, (table) => {
      table.integer('price')
      table.integer('implicit').storedAs('price * 2')
      table.integer('declared_after')[computedAs]('price * 3').notNull()
      table.integer('declared_before').notNull().storedAs('price * 4')
    })

    const [computed] = await readTables(db, [name])
    expect([computed!.columns.implicit?.nullable, computed!.columns.declared_after?.nullable, computed!.columns.declared_before?.nullable])
      .toEqual([driver !== 'postgres', false, false])
  })

  it('creates a model row without its computed columns and reads back the values the database computed', async () => {
    const { db, names } = await openComputedDatabase(driver)
    await reloadGeneratedSchema(await readTables(db, [names.products, names.shapes]))
    const Product = defineModel(names.products, { fillable: ['price', 'quantity', 'name'], timestamps: false })
    const Shape = defineModel(names.shapes, { fillable: ['width', 'height'], timestamps: false })

    const product = await Product.create({ price: 3, quantity: 4, name: 'Pen' })
    const shape = await Shape.create({ width: 2, height: 5 })

    const stored = await Product.findOrFail(product.get('id'))
    expect([Number(stored.get('total')), stored.get('label')]).toEqual([12, 'Pen (it\'s)'])
    expect(Number((await Shape.findOrFail(shape.get('id'))).get('area'))).toBe(10)
  })

  it('rejects writing a computed column through a model with the generated column error', async () => {
    const { db, names } = await openComputedDatabase(driver)
    await reloadGeneratedSchema(await readTables(db, [names.products]))
    const Product = defineModel(names.products, { fillable: ['price', 'quantity', 'name', 'total'], timestamps: false })
    const product = await Product.create({ price: 1, quantity: 1, name: 'Cup' })

    await expect(Product.create({ price: 1, quantity: 1, name: 'Mug', total: 5 })).rejects.toThrow('Column "total" is generated and cannot be written directly.')
    await expect(Product.update(product.get('id'), { total: 5 })).rejects.toThrow('Column "total" is generated and cannot be written directly.')
  })

  it('keeps computed columns computing after change() alters another column', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)
    await db.table(names.products).insert({ price: 2, quantity: 3, name: 'Ink' })

    await schema.table(names.products, (table) => {
      table.text('note').nullable().change()
    })

    await db.table(names.products).insert({ price: 5, quantity: 5, name: 'Pad' })
    const rows = await db.table(names.products).orderBy('id').get()
    expect(rows.map(row => [Number(row.total), row.label])).toEqual([[6, 'Ink (it\'s)'], [25, 'Pad (it\'s)']])
    const [products] = await readTables(db, [names.products])
    expect(products!.columns.total?.computed?.stored).toBe(true)
  })

  it.runIf(driver !== 'postgres')('recomputes a computed column whose expression change() redeclares', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)
    await db.table(names.products).insert({ price: 2, quantity: 3, name: 'Ink' })

    await schema.table(names.products, (table) => {
      table.integer('total').storedAs('price * quantity + 1').change()
    })

    await db.table(names.products).insert({ price: 5, quantity: 5, name: 'Pad' })
    expect((await db.table(names.products).orderBy('id').pluck('total')).map(Number)).toEqual([7, 26])
  })

  it.runIf(driver !== 'postgres')('turns an ordinary column into a computed one through change() and computes it for existing rows', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)
    await db.table(names.products).insert({ price: 2, quantity: 3, name: 'Ink', note: 'manual' })

    await schema.table(names.products, (table) => {
      table.string('note').storedAs(labelExpressions[driver]).change()
    })

    await db.table(names.products).insert({ price: 5, quantity: 5, name: 'Pad' })
    expect(await db.table(names.products).orderBy('id').pluck('note')).toEqual(['Ink (it\'s)', 'Pad (it\'s)'])
  })

  it.runIf(driver === 'postgres')('rejects redeclaring a computed column expression through change() on postgres', async () => {
    const { schema, names } = await openComputedDatabase(driver)

    await expect(schema.table(names.products, (table) => {
      table.integer('total').storedAs('price * quantity + 1').change()
    })).rejects.toThrow('PostgreSQL cannot change the expression of generated column "total". Drop and add the column instead.')
  })

  it.runIf(driver === 'postgres')('creates a virtualAs column on postgres 18 or newer and rejects it with a clear error on older servers', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = 'computed_virtual_postgres'
    onTestFinished(async () => {
      if (await schema.hasTable(name)) await schema.dropTable(name)
    })
    const version = Number((await db.queryCompiled<{ version: string }>({ sql: 'SELECT current_setting(\'server_version_num\') AS version', source: 'test:computed-columns' })).rows[0]?.version)

    const created = schema.createTable(name, (table) => {
      table.integer('price')
      table.integer('doubled').virtualAs('price * 2')
    })

    if (version >= 180000) await expect(created).resolves.toBeUndefined()
    else await expect(created).rejects.toThrow('PostgreSQL 18 or newer is required for the virtualAs() column "doubled". Use storedAs() instead.')
  })
})
