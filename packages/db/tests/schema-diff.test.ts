import { describe, expect, it, onTestFinished } from 'vitest'
import { createPostgresAdapter } from '@holo-js/db-postgres'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { column, createDatabase, createDialect, diffSchema, createSchemaService, SchemaError } from '../src'
import { defineTable } from './support/internal'
import { createTestTable } from './support/schema'
import { openDatabase } from './support/database'

function openSQLiteSchema() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  return { adapter, db, schema: createSchemaService(db) }
}

describe('native schema diff', () => {
  it.each(['sqlite', 'postgres', 'mysql'] as const)('reports matching columns and indexes on %s', async driver => {
    const { schema, table } = await openDatabase(driver)
    const expected = defineTable(table.tableName.split('.').at(-1)!, table.columns)
    const diff = await diffSchema(schema, [expected])
    expect(diff.missingTables).toEqual([])
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0]).toMatchObject({
      missingColumns: [], extraColumns: [], mismatchedColumns: [],
      missingIndexes: [], extraIndexes: [], mismatchedIndexes: [],
      missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [], hasChanges: false,
    })
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('reports no changes for unique columns with conventional and shortened names on %s', async driver => {
    const { schema } = await openDatabase(driver)
    const name = `holo_diff_unique_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`
    onTestFinished(() => schema.dropTable(name))
    await schema.createTable(name, table => {
      table.id()
      table.string('email').unique()
      table.string('organizer_primary_contact_email_address').unique()
    })
    const expected = defineTable(name, {
      id: column.id(),
      email: column.string().unique(),
      organizer_primary_contact_email_address: column.string().unique(),
    })

    const diff = await diffSchema(schema, [expected])

    expect(diff.tables[0]).toMatchObject({ missingIndexes: [], extraIndexes: [], mismatchedIndexes: [], hasChanges: false })
  })

  it('compares actual foreign keys, unique indexes, and default reference actions', async () => {
    const { db, schema } = openSQLiteSchema()
    const teams = defineTable('teams', { id: column.id() })
    const users = defineTable('users', {
      id: column.id(), email: column.string().unique(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate(),
    }, { indexes: [{ columns: ['email'], unique: true }] })
    const audits = defineTable('audits', {
      id: column.id(), team_id: column.foreignId().constrained('teams'), message: column.string(),
    }, { indexes: [{ columns: ['message'], unique: false }] })
    for (const table of [teams, users, audits]) await createTestTable(db, table)
    const diff = await diffSchema(schema, [teams, users, audits])
    expect(diff.hasChanges).toBe(false)
    expect(diff.extraTables).toEqual([])
    expect(diff.missingTables).toEqual([])
    expect(diff.tables.every(table => !table.hasChanges)).toBe(true)
  })

  it('reports missing and extra tables and mismatched columns and reference actions', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE teams (id INTEGER PRIMARY KEY NOT NULL)')
    await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY NOT NULL, email INTEGER, legacy_flag TEXT, team_id INTEGER, FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL ON UPDATE NO ACTION)')
    await adapter.execute('CREATE INDEX legacy_email_idx ON users(email)')
    await adapter.execute('CREATE TABLE legacy (id INTEGER PRIMARY KEY NOT NULL)')
    const teams = defineTable('teams', { id: column.id() })
    const users = defineTable('users', {
      id: column.id(), email: column.string().unique(), active: column.boolean(),
      team_id: column.foreignId().constrained('teams').cascadeOnDelete().restrictOnUpdate(),
    }, { indexes: [{ columns: ['email'], unique: true }] })
    const posts = defineTable('posts', { id: column.id() })
    const diff = await diffSchema(schema, [teams, users, posts])
    expect(diff.missingTables).toEqual(['posts'])
    expect(diff.extraTables).toEqual(['legacy'])
    expect(diff.hasChanges).toBe(true)
    const changed = diff.tables.find(table => table.table === 'users')!
    expect(changed.missingColumns).toEqual(['active'])
    expect(changed.extraColumns).toEqual(['legacy_flag'])
    expect(changed.mismatchedColumns).toEqual([
      { column: 'email', expected: { type: 'VARCHAR(255)', notNull: true, primaryKey: false }, actual: { type: 'INTEGER', notNull: false, primaryKey: false } },
      { column: 'team_id', expected: { type: 'INTEGER', notNull: true, primaryKey: false }, actual: { type: 'INTEGER', notNull: false, primaryKey: false } },
    ])
    expect(changed.missingIndexes).toEqual(['users_email_unique'])
    expect(changed.extraIndexes).toEqual(['legacy_email_idx'])
    expect(changed.mismatchedForeignKeys).toEqual([{
      foreignKey: 'team_id->teams.id',
      expected: { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'RESTRICT', onDelete: 'CASCADE' },
      actual: { table: 'teams', from: 'team_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'SET NULL' },
    }])
  })

  it('reports index column and uniqueness changes and extra foreign keys', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE teams (id INTEGER PRIMARY KEY NOT NULL)')
    await adapter.execute('CREATE TABLE metrics (price NUMERIC NOT NULL, ratio REAL NOT NULL, payload BLOB NOT NULL, team_id INTEGER, FOREIGN KEY (team_id) REFERENCES teams(id))')
    await adapter.execute('CREATE INDEX metrics_price_idx ON metrics(ratio)')
    const metrics = defineTable('metrics', {
      price: column.decimal(), ratio: column.real(), payload: column.blob(), team_id: column.integer().nullable(),
    }, { indexes: [{ name: 'metrics_price_idx', columns: ['price'], unique: true }] })
    const diff = await diffSchema(schema, [metrics])
    expect(diff.tables[0]!.mismatchedColumns).toEqual([])
    expect(diff.tables[0]!.mismatchedIndexes).toEqual([{
      index: 'metrics_price_idx', expected: { unique: true, columns: ['price'] }, actual: { unique: false, columns: ['ratio'] },
    }])
    expect(diff.tables[0]!.extraForeignKeys).toEqual(['team_id->teams.id'])
  })

  it.each(['postgres', 'mysql'] as const)('compares a table qualified with the default schema on %s', async driver => {
    const { schema, table } = await openDatabase(driver)
    const name = table.tableName.split('.').at(-1)!

    const diff = await diffSchema(schema, [table])

    expect(table.tableName).toContain('.')
    expect(diff.missingTables).toEqual([])
    expect(diff.extraTables).not.toContain(name)
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0]).toMatchObject({ table: table.tableName, missingColumns: [], extraColumns: [], mismatchedColumns: [], hasChanges: false })
  })

  it.each(['postgres', 'mysql'] as const)('compares tables qualified with another schema on %s', async driver => {
    const { schema, adapter } = await openDatabase(driver)
    const tenant = `holo_tenant_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const quote = (identifier: string) => driver === 'postgres' ? `"${identifier}"` : `\`${identifier}\``
    onTestFinished(async () => { await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(tenant)}${driver === 'postgres' ? ' CASCADE' : ''}`) })
    await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(tenant)}`)
    await schema.createTable(`${tenant}.orders`, table => {
      table.id()
      table.string('reference')
      table.string('legacy_code')
      table.index(['reference'])
    })
    const orders = defineTable(`${tenant}.orders`, {
      id: column.id(), reference: column.string(), total: column.integer(),
    }, { indexes: [{ columns: ['reference'], unique: false }] })
    const invoices = defineTable(`${tenant}.invoices`, { id: column.id() })

    const diff = await diffSchema(schema, [orders, invoices])

    expect(diff.missingTables).toEqual([`${tenant}.invoices`])
    expect(diff.extraTables).not.toContain('orders')
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0]).toMatchObject({
      table: `${tenant}.orders`,
      missingColumns: ['total'], extraColumns: ['legacy_code'], mismatchedColumns: [],
      missingIndexes: [], extraIndexes: [], mismatchedIndexes: [], hasChanges: true,
    })
  })

  it.each(['postgres', 'mysql'] as const)('compares foreign keys of a qualified table by the schema they reference on %s', async driver => {
    const { schema, adapter, table } = await openDatabase(driver)
    const qualifiedHome = table.tableName
    const home = qualifiedHome.split('.').at(-1)!
    const tenant = `holo_tenant_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const quote = (identifier: string) => driver === 'postgres' ? `"${identifier}"` : `\`${identifier}\``
    onTestFinished(async () => { await adapter.execute(`${driver === 'postgres' ? 'DROP SCHEMA IF EXISTS' : 'DROP DATABASE IF EXISTS'} ${quote(tenant)}${driver === 'postgres' ? ' CASCADE' : ''}`) })
    await adapter.execute(`${driver === 'postgres' ? 'CREATE SCHEMA' : 'CREATE DATABASE'} ${quote(tenant)}`)
    await schema.createTable(`${tenant}.customers`, table => { table.id() })
    await schema.createTable(`${tenant}.orders`, table => {
      table.id()
      table.foreignId('customer_id').constrained(`${tenant}.customers`)
      table.integer('home_id')
      table.foreign('home_id').references('id').on(qualifiedHome)
    })
    const customers = defineTable(`${tenant}.customers`, { id: column.id() })
    const orders = defineTable(`${tenant}.orders`, {
      id: column.id(),
      customer_id: column.foreignId().constrained(`${tenant}.customers`),
      home_id: column.integer().references('id').on(driver === 'postgres' ? home : qualifiedHome),
    })

    const diff = await diffSchema(schema, [customers, orders])

    expect(diff.tables.find(entry => entry.table === `${tenant}.orders`)).toMatchObject({
      missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [],
    })
  })

  it('reports an unqualified reference that the search path cannot resolve on postgres', async () => {
    const { schema, adapter } = await openDatabase('postgres')
    const tenant = `holo_tenant_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    onTestFinished(async () => { await adapter.execute(`DROP SCHEMA IF EXISTS "${tenant}" CASCADE`) })
    await adapter.execute(`CREATE SCHEMA "${tenant}"`)
    await adapter.execute(`CREATE TABLE "${tenant}".customers (id BIGINT PRIMARY KEY)`)
    await adapter.execute(`CREATE TABLE "${tenant}".orders (id BIGINT PRIMARY KEY, customer_id BIGINT NOT NULL REFERENCES "${tenant}".customers (id))`)
    const orders = defineTable(`${tenant}.orders`, {
      id: column.bigInteger().primaryKey(),
      customer_id: column.bigInteger().references('id').on('customers'),
    })

    const diff = await diffSchema(schema, [orders])

    expect(diff.tables[0]).toMatchObject({
      missingForeignKeys: ['customer_id->customers.id'],
      extraForeignKeys: [`customer_id->${tenant}.customers.id`],
      hasChanges: true,
    })
  })

  it('resolves an unqualified foreign key reference through the whole search path on postgres', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const first = `holo_first_${suffix}`
    const billing = `holo_billing_${suffix}`
    const users = `holo_users_${suffix}`
    const adapter = createPostgresAdapter({ config: {
      host: process.env.HOLO_POSTGRES_HOST ?? '127.0.0.1',
      port: Number(process.env.HOLO_POSTGRES_PORT ?? 5432),
      user: process.env.HOLO_POSTGRES_USER ?? 'postgres',
      password: process.env.HOLO_POSTGRES_PASSWORD,
      database: process.env.HOLO_POSTGRES_DATABASE ?? 'postgres',
      options: `-c search_path=${first},public`,
    } })
    const db = createDatabase({ adapter, dialect: createDialect('postgres') })
    const schema = createSchemaService(db)
    onTestFinished(async () => {
      try {
        await adapter.execute(`DROP SCHEMA IF EXISTS "${billing}" CASCADE`)
        await adapter.execute(`DROP SCHEMA IF EXISTS "${first}" CASCADE`)
        await adapter.execute(`DROP TABLE IF EXISTS public."${users}"`)
      } finally {
        await db.disconnect()
      }
    })
    await adapter.execute(`CREATE SCHEMA "${first}"`)
    await adapter.execute(`CREATE SCHEMA "${billing}"`)
    await adapter.execute(`CREATE TABLE public."${users}" (id BIGINT PRIMARY KEY)`)
    await adapter.execute(`CREATE TABLE "${billing}".invoices (id BIGINT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES "${users}" (id))`)
    const invoices = defineTable(`${billing}.invoices`, {
      id: column.bigInteger().primaryKey(),
      user_id: column.bigInteger().references('id').on(users),
    })

    const diff = await diffSchema(schema, [invoices])

    expect(diff.tables[0]).toMatchObject({ missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [] })
  })

  it('reports a schema-qualified view as a missing table on mysql', async () => {
    const { schema, adapter, table } = await openDatabase('mysql')
    const view = `${table.tableName}_view`
    const quote = (path: string) => path.split('.').map(part => `\`${part}\``).join('.')
    onTestFinished(async () => { await adapter.execute(`DROP VIEW IF EXISTS ${quote(view)}`) })
    await adapter.execute(`CREATE VIEW ${quote(view)} AS SELECT id FROM ${quote(table.tableName)}`)

    const diff = await diffSchema(schema, [defineTable(view, { id: column.integer().primaryKey() })])

    expect(diff.missingTables).toEqual([view])
    expect(diff.tables).toEqual([])
  })

  it('compares tables qualified with the main schema on sqlite', async () => {
    const { db, schema } = openSQLiteSchema()
    await createTestTable(db, defineTable('teams', { id: column.id() }))
    const teams = defineTable('main.teams', { id: column.id(), name: column.string() })
    const posts = defineTable('main.posts', { id: column.id() })

    const diff = await diffSchema(schema, [teams, posts])

    expect(diff.missingTables).toEqual(['main.posts'])
    expect(diff.extraTables).toEqual([])
    expect(diff.tables).toHaveLength(1)
    expect(diff.tables[0]).toMatchObject({ table: 'main.teams', missingColumns: ['name'], extraColumns: [], hasChanges: true })
  })

  it('matches the main schema case-insensitively on sqlite', async () => {
    const { db, schema } = openSQLiteSchema()
    await createTestTable(db, defineTable('teams', { id: column.id() }))

    const diff = await diffSchema(schema, [defineTable('MAIN.teams', { id: column.id() })])

    expect(diff.missingTables).toEqual([])
    expect(diff.extraTables).toEqual([])
    expect(diff.tables[0]).toMatchObject({ table: 'MAIN.teams', hasChanges: false })
  })

  it('matches a qualified table by its stored name case-insensitively on sqlite', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE "Teams" (id INTEGER PRIMARY KEY NOT NULL)')

    const diff = await diffSchema(schema, [defineTable('main.teams', { id: column.integer().primaryKey() })])

    expect(diff.missingTables).toEqual([])
    expect(diff.extraTables).toEqual([])
  })

  it('matches foreign keys of a qualified table by the stored referenced table name on sqlite', async () => {
    const { adapter, schema } = openSQLiteSchema()
    await adapter.execute('CREATE TABLE "Parents" (id INTEGER PRIMARY KEY NOT NULL)')
    await adapter.execute('CREATE TABLE children (id INTEGER PRIMARY KEY NOT NULL, parent_id INTEGER NOT NULL, FOREIGN KEY (parent_id) REFERENCES parents (id))')
    const children = defineTable('main.children', {
      id: column.integer().primaryKey(),
      parent_id: column.integer().references('id').on('main.PARENTS'),
    })

    const diff = await diffSchema(schema, [children])

    expect(diff.tables[0]).toMatchObject({ missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [] })
  })

  it('reports a table in an unattached schema as missing on sqlite', async () => {
    const { schema } = openSQLiteSchema()

    expect(await schema.hasTable('missing.orders')).toBe(false)
    const diff = await diffSchema(schema, [defineTable('missing.orders', { id: column.id() })])

    expect(diff.missingTables).toEqual(['missing.orders'])
  })

  it('matches qualified tables and references case-insensitively when mysql folds names', async ({ skip }) => {
    const { schema, adapter, db } = await openDatabase('mysql')
    const folding = await db.queryCompiled<{ folding: number | string }>({ sql: 'SELECT @@lower_case_table_names AS folding', bindings: [], source: 'test' })
    if (Number(folding.rows[0]!.folding) === 0) skip()
    const database = (process.env.HOLO_MYSQL_DATABASE ?? 'mysql').toUpperCase()
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12)
    const parents = `holo_parents_${suffix}`
    const children = `holo_children_${suffix}`
    onTestFinished(async () => {
      await adapter.execute(`DROP TABLE IF EXISTS \`${children}\``)
      await adapter.execute(`DROP TABLE IF EXISTS \`${parents}\``)
    })
    await adapter.execute(`CREATE TABLE \`${parents}\` (id BIGINT UNSIGNED PRIMARY KEY)`)
    await adapter.execute(`CREATE TABLE \`${children}\` (id BIGINT UNSIGNED PRIMARY KEY, parent_id BIGINT UNSIGNED NOT NULL, FOREIGN KEY (parent_id) REFERENCES \`${parents}\` (id))`)
    const declared = defineTable(`${database}.${children}`, {
      id: column.bigInteger().primaryKey(),
      parent_id: column.bigInteger().references('id').on(`${database}.${parents.toUpperCase()}`),
    })

    const diff = await diffSchema(schema, [declared])

    expect(diff.missingTables).toEqual([])
    expect(diff.extraTables).not.toContain(children)
    expect(diff.tables[0]).toMatchObject({ missingForeignKeys: [], extraForeignKeys: [], mismatchedForeignKeys: [] })
  })

  it.each(['sqlite', 'postgres', 'mysql'] as const)('keeps an unqualified table that shares its name with a table in another schema on %s', async driver => {
    const { schema, table } = await openDatabase(driver)
    const name = table.tableName.split('.').at(-1)!
    const elsewhere = defineTable(`${driver === 'sqlite' ? 'temp' : 'holo_missing_schema'}.${name}`, table.columns)

    const diff = await diffSchema(schema, [elsewhere])

    expect(diff.missingTables).toEqual([elsewhere.tableName])
    expect(diff.extraTables).toContain(name)
    expect(diff.tables).toEqual([])
  })

  it.each(['sqlite', 'mysql'] as const)('rejects unsupported vector columns on %s', async driver => {
    const { db, table, schema } = await openDatabase(driver)
    await schema.table(table.tableName, table => { table.blob('embedding').nullable() })
    const vectors = defineTable(table.tableName.split('.').at(-1)!, { ...table.columns, embedding: column.vector({ dimensions: 3 }).nullable() })
    await expect(diffSchema(schema, [vectors])).rejects.toThrow(SchemaError)
    expect(await db.table(table).count()).toBe(0)
  })
})
