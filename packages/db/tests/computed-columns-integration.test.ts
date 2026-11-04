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

const POSTGRES_18 = 180000

async function readPostgresVersion(db: DatabaseContext): Promise<number> {
  const result = await db.queryCompiled<{ version: string }>({ sql: 'SELECT current_setting(\'server_version_num\') AS version', source: 'test:computed-columns' })
  return Number(result.rows[0]?.version)
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

  it('rejects incrementing or decrementing a computed column through a model with the generated column error', async () => {
    const { db, names } = await openComputedDatabase(driver)
    await reloadGeneratedSchema(await readTables(db, [names.products]))
    const Product = defineModel(names.products, { fillable: ['price', 'quantity', 'name'], timestamps: false })
    await Product.create({ price: 2, quantity: 3, name: 'Ink' })
    const error = 'Column "total" is generated and cannot be written directly.'

    await expect(Product.increment('total')).rejects.toThrow(error)
    await expect(Product.decrement(`${names.products}.total`, 2)).rejects.toThrow(error)
    await expect(Product.where('price', 2).increment('total')).rejects.toThrow(error)
    await expect(Product.where('price', 2).decrement('total')).rejects.toThrow(error)
    await expect(Product.incrementEach({ price: 1, total: 1 })).rejects.toThrow(error)
    await expect(Product.where('price', 2).decrementEach({ price: 1, total: 1 })).rejects.toThrow(error)
    expect((await Product.query().get()).toJSON().map(row => [row.price, Number(row.total)])).toEqual([[2, 6]])
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

  it('adds a storedAs column to a table that has rows and computes it for them', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)
    await db.table(names.products).insert([{ price: 2, quantity: 3, name: 'Ink' }, { price: 5, quantity: 1, name: 'Pad' }])

    await schema.table(names.products, (table) => {
      table.integer('doubled').storedAs('price * 2')
    })

    await db.table(names.products).insert({ price: 7, quantity: 1, name: 'Pen' })
    const rows = await db.table(names.products).orderBy('id').get()
    expect(rows.map(row => [Number(row.doubled), Number(row.total), row.label])).toEqual([[4, 6, 'Ink (it\'s)'], [10, 5, 'Pad (it\'s)'], [14, 7, 'Pen (it\'s)']])
  })

  it.runIf(driver === 'sqlite')('keeps the rows, indexes, constraints and triggers of a sqlite table a unique storedAs column is added to', async () => {
    const { db, schema, adapter } = await openDatabase(driver)
    const name = 'computed_added_stored'
    onTestFinished(async () => {
      if (await schema.hasTable(name)) await schema.dropTable(name)
    })
    await adapter.execute(`CREATE TABLE "${name}" (
      "id" INTEGER PRIMARY KEY AUTOINCREMENT,
      "email" TEXT NOT NULL UNIQUE,
      "price" INTEGER NOT NULL CHECK ("price" > 0),
      "visits" INTEGER NOT NULL DEFAULT 0
    )`)
    await adapter.execute(`CREATE INDEX "computed_added_stored_price" ON "${name}" ("price")`)
    await adapter.execute(`CREATE TRIGGER "computed_added_stored_visit" AFTER INSERT ON "${name}" BEGIN UPDATE "${name}" SET "visits" = "visits" + 1 WHERE "id" = NEW."id"; END`)
    await db.table(name).insert([{ email: 'a@example.com', price: 3 }, { email: 'b@example.com', price: 4 }])
    await db.table(name).where('id', 2).delete()
    const reader = createSchemaReader(db)
    const before = (await reader.readTableStructure(name))!

    await schema.table(name, (table) => {
      table.integer('doubled').storedAs('price * 2').unique()
    })

    const after = (await reader.readTableStructure(name))!
    expect(after.columns.filter(column => column.name !== 'doubled')).toEqual(before.columns)
    expect(after.indexes.map(index => [index.columns, index.unique])).toEqual(expect.arrayContaining([...before.indexes.map(index => [index.columns, index.unique]), [['doubled'], true]]))
    expect(after.indexes).toHaveLength(before.indexes.length + 1)
    expect(await db.table(name).get()).toEqual([{ id: 1, email: 'a@example.com', price: 3, visits: 1, doubled: 6 }])
    expect(await db.table(name).insertGetId({ email: 'c@example.com', price: 5 })).toBe(3)
    expect(await db.table(name).where('id', 3).first()).toEqual({ id: 3, email: 'c@example.com', price: 5, visits: 1, doubled: 10 })
    await expect(db.table(name).insert({ email: 'a@example.com', price: 1 })).rejects.toThrow()
    await expect(db.table(name).insert({ email: 'd@example.com', price: 0 })).rejects.toThrow()
    await expect(db.table(name).insert({ email: 'e@example.com', price: 5 })).rejects.toThrow()
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

  it.runIf(driver === 'sqlite')('rejects reading a sqlite computed column whose expression its stored definition does not hold', async () => {
    const { db } = await openDatabase(driver, {
      wrapAdapter: adapter => new Proxy(adapter, {
        get(target, property) {
          const introspect = target.introspect?.bind(target)
          if (property !== 'introspect' || !introspect) return Reflect.get(target, property, target)
          return async (...args: Parameters<typeof introspect>) => {
            const result = await introspect(...args)
            return { ...result, rows: result.rows.map(row => typeof row.sql === 'string' ? { ...row, sql: row.sql.replace(' AS (a * 2)', '') } : row) }
          }
        },
      }),
    })
    await db.executeCompiled({ sql: 'CREATE TABLE "computed_unreadable" ("a" integer, "b" integer AS (a * 2))', source: 'test:computed-columns' })

    await expect(createSchemaReader(db).readTable('computed_unreadable')).rejects.toThrow('SQLite cannot read the expression of computed column "b" on table "computed_unreadable".')
  })

  it.runIf(driver === 'postgres')('rejects redeclaring a computed column expression through change() on postgres', async () => {
    const { schema, names } = await openComputedDatabase(driver)

    await expect(schema.table(names.products, (table) => {
      table.integer('total').storedAs('price * quantity + 1').change()
    })).rejects.toThrow('PostgreSQL cannot change the expression of generated column "total". Drop and add the column instead.')
  })

  it.runIf(driver === 'postgres')('applies no operation of a table() call whose change() redeclares a computed column on postgres', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)

    await expect(schema.table(names.products, (table) => {
      table.integer('discount').nullable()
      table.integer('total').storedAs('price * quantity + 1').change()
    })).rejects.toThrow('PostgreSQL cannot change the expression of generated column "total". Drop and add the column instead.')

    const [products] = await readTables(db, [names.products])
    expect(products!.columns.discount).toBeUndefined()
  })

  it.runIf(driver === 'postgres')('creates a virtualAs column on postgres 18 or newer and rejects it with a clear error on older servers', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = 'computed_virtual_postgres'
    onTestFinished(async () => {
      if (await schema.hasTable(name)) await schema.dropTable(name)
    })

    const created = schema.createTable(name, (table) => {
      table.id()
      table.integer('price')
      table.integer('doubled').virtualAs('price * 2')
    })

    if (await readPostgresVersion(db) < POSTGRES_18) {
      await expect(created).rejects.toThrow('PostgreSQL 18 or newer is required for the virtualAs() column "doubled". Use storedAs() instead.')
      expect(await schema.hasTable(name)).toBe(false)
      return
    }
    await created
    const tables = await readTables(db, [name])
    expect(renderGeneratedSchemaModule(tables)).toContain('"doubled": column.integer().virtualAs("(price * 2)")')
    await reloadGeneratedSchema(tables)
    const Doubled = defineModel(name, { fillable: ['price', 'doubled'], timestamps: false })
    const row = await Doubled.create({ price: 21 })
    expect(Number((await Doubled.findOrFail(row.get('id'))).get('doubled'))).toBe(42)
    await expect(Doubled.create({ price: 1, doubled: 5 })).rejects.toThrow('Column "doubled" is generated and cannot be written directly.')
  })

  it.runIf(driver === 'postgres')('applies no operation of a table() call whose virtualAs column the postgres server cannot create', async () => {
    const { db, schema, names } = await openComputedDatabase(driver)

    const altered = schema.table(names.products, (table) => {
      table.integer('discount').nullable()
      table.integer('doubled').virtualAs('price * 2')
    })

    if (await readPostgresVersion(db) < POSTGRES_18) {
      await expect(altered).rejects.toThrow('PostgreSQL 18 or newer is required for the virtualAs() column "doubled". Use storedAs() instead.')
      const [products] = await readTables(db, [names.products])
      expect(products!.columns.discount).toBeUndefined()
      return
    }
    await altered
    const [products] = await readTables(db, [names.products])
    expect([products!.columns.discount?.name, products!.columns.doubled?.computed]).toEqual(['discount', { expression: '(price * 2)', stored: false }])
  })
})
