import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { openDatabase } from './support/database'

function uniqueName(prefix: string, length = 12): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, length)}`
}

const expectedColumns = {
  sqlite: [
    { name: 'id', type: 'INTEGER', logicalType: 'integer', notNull: true, defaultValue: null, primaryKey: true },
    { name: 'user_id', type: 'INTEGER', logicalType: 'integer', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'title', type: 'varchar(255)', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'slug', type: 'varchar(255)', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'body', type: 'TEXT', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'published', type: 'tinyint(1)', logicalType: 'boolean', notNull: true, defaultValue: '0', primaryKey: false },
    { name: 'views', type: 'INTEGER', logicalType: 'integer', notNull: true, defaultValue: '7', primaryKey: false },
    { name: 'meta', type: 'TEXT', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'status', type: 'TEXT', logicalType: 'text', notNull: true, defaultValue: '\'draft\'', primaryKey: false },
    { name: 'published_at', type: 'datetime', logicalType: 'datetime', notNull: true, defaultValue: 'CURRENT_TIMESTAMP', primaryKey: false },
    { name: 'token', type: 'TEXT', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'price', type: 'NUMERIC', logicalType: 'decimal', notNull: true, defaultValue: null, primaryKey: false },
  ],
  postgres: [
    { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
    { name: 'user_id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'title', type: 'character varying', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'slug', type: 'character varying', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'body', type: 'text', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'published', type: 'boolean', logicalType: 'boolean', notNull: true, defaultValue: 'false', primaryKey: false },
    { name: 'views', type: 'integer', logicalType: 'integer', notNull: true, defaultValue: '7', primaryKey: false },
    { name: 'meta', type: 'jsonb', logicalType: 'json', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'status', type: 'text', logicalType: 'text', notNull: true, defaultValue: '\'draft\'::text', primaryKey: false },
    { name: 'published_at', type: 'timestamp without time zone', logicalType: 'timestamp', notNull: true, defaultValue: 'CURRENT_TIMESTAMP', primaryKey: false },
    { name: 'token', type: 'uuid', logicalType: 'uuid', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'price', type: 'numeric', logicalType: 'decimal', notNull: true, defaultValue: null, primaryKey: false },
  ],
  mysql: [
    { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
    { name: 'user_id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'title', type: 'varchar', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'slug', type: 'varchar', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
    { name: 'body', type: 'text', logicalType: 'text', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'published', type: 'tinyint', logicalType: 'boolean', notNull: true, defaultValue: '0', primaryKey: false },
    { name: 'views', type: 'int', logicalType: 'integer', notNull: true, defaultValue: '7', primaryKey: false },
    { name: 'meta', type: 'json', logicalType: 'json', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'status', type: 'enum', logicalType: 'enum', notNull: true, defaultValue: 'draft', primaryKey: false },
    { name: 'published_at', type: 'timestamp', logicalType: 'timestamp', notNull: true, defaultValue: 'CURRENT_TIMESTAMP', primaryKey: false },
    { name: 'token', type: 'char', logicalType: 'uuid', notNull: false, defaultValue: null, primaryKey: false },
    { name: 'price', type: 'decimal', logicalType: 'decimal', notNull: true, defaultValue: null, primaryKey: false },
  ],
} as const

function expectedIndexes(driver: 'sqlite' | 'postgres' | 'mysql', posts: string) {
  const slug = { name: `${posts}_slug_unique`, unique: true, columns: ['slug'] }
  const titleViews = { name: `${posts}_title_views_index`, unique: false, columns: ['title', 'views'] }
  if (driver === 'sqlite') return [slug, titleViews]
  if (driver === 'postgres') return [{ name: `${posts}_pkey`, unique: true, columns: ['id'] }, slug, titleViews]
  return [slug, titleViews, { name: `${posts}_user_id_foreign`, unique: false, columns: ['user_id'] }, { name: 'PRIMARY', unique: true, columns: ['id'] }]
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`native ${driver} schema introspection`, () => {
    it('reports the tables, columns, indexes and foreign keys of the default schema', async () => {
      const { schema } = await openDatabase(driver)
      const users = uniqueName('holo_intro_users')
      const posts = uniqueName('holo_intro_posts')
      onTestFinished(async () => {
        await schema.dropTable(posts)
        await schema.dropTable(users)
      })
      await schema.createTable(users, table => {
        table.id()
      })
      await schema.createTable(posts, table => {
        table.id()
        table.foreignId('user_id').constrained(users).onDelete('cascade')
        table.string('title')
        table.string('slug').unique()
        table.text('body').nullable()
        table.boolean('published').default(false)
        table.integer('views').default(7)
        table.json('meta').nullable()
        table.enum('status', ['draft', 'live'] as const).default('draft')
        table.timestamp('published_at').defaultNow()
        table.uuid('token').nullable()
        table.decimal('price')
        table.index(['title', 'views'])
      })

      expect((await schema.getTables()).filter(name => name === users || name === posts)).toEqual([users, posts].sort())
      expect(await schema.getColumns(posts)).toEqual(expectedColumns[driver])
      expect(await schema.getIndexes(posts)).toEqual(expectedIndexes(driver, posts))
      expect(await schema.getForeignKeys(posts)).toEqual([
        { table: users, from: 'user_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
      ])
    })

    it('reports nothing for a table that does not exist', async () => {
      const { schema } = await openDatabase(driver)
      const missing = uniqueName('holo_intro_missing')

      expect(await schema.hasTable(missing)).toBe(false)
      expect(await schema.getColumns(missing)).toEqual([])
      expect(await schema.getIndexes(missing)).toEqual([])
      expect(await schema.getForeignKeys(missing)).toEqual([])
    })

    it.runIf(driver === 'postgres')('reads the configured non-public schema, not a public table with the same name', async () => {
      const tenant = uniqueName('tenant', 8)
      const { db, schema } = await openDatabase(driver, { schemaName: tenant })
      const customers = uniqueName('customers', 8)
      const orders = uniqueName('orders', 8)
      onTestFinished(async () => {
        await db.executeCompiled({ sql: `DROP SCHEMA IF EXISTS "${tenant}" CASCADE`, source: 'schema' })
        await schema.dropTable(`public.${orders}`)
        await schema.dropTable(`public.${customers}`)
      })
      await schema.createTable(`public.${customers}`, table => {
        table.id()
      })
      await schema.createTable(`public.${orders}`, table => {
        table.id()
        table.string('public_only').unique()
        table.foreignId('public_customer_id').constrained(`public.${customers}`)
      })
      await schema.createTable(`${tenant}.${customers}`, table => {
        table.id()
      })
      await schema.createTable(`${tenant}.${orders}`, table => {
        table.id()
        table.string('code').unique()
        table.foreignId('customer_id').constrained(`${tenant}.${customers}`).onDelete('cascade')
        table.index(['code', 'customer_id'], 'tenant_orders_lookup')
      })

      expect(await schema.getTables()).toEqual([customers, orders].sort())
      expect(await schema.hasTable(orders)).toBe(true)
      expect(await schema.getColumns(orders)).toEqual([
        { name: 'id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: true },
        { name: 'code', type: 'character varying', logicalType: 'string', notNull: true, defaultValue: null, primaryKey: false },
        { name: 'customer_id', type: 'bigint', logicalType: 'bigInteger', notNull: true, defaultValue: null, primaryKey: false },
      ])
      expect(await schema.getIndexes(orders)).toEqual([
        { name: `${orders}_pkey`, unique: true, columns: ['id'] },
        { name: `${tenant}_${orders}_code_unique`, unique: true, columns: ['code'] },
        { name: 'tenant_orders_lookup', unique: false, columns: ['code', 'customer_id'] },
      ])
      expect(await schema.getForeignKeys(orders)).toEqual([
        { table: customers, from: 'customer_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
      ])
    })

    it.runIf(driver === 'postgres')('drops a unique constraint and renames an enum column in the configured non-public schema', async () => {
      const tenant = uniqueName('tenant', 8)
      const { db, schema } = await openDatabase(driver, { schemaName: tenant })
      const orders = uniqueName('orders', 8)
      onTestFinished(async () => {
        await db.executeCompiled({ sql: `DROP SCHEMA IF EXISTS "${tenant}" CASCADE`, source: 'schema' })
        await schema.dropTable(`public.${orders}`)
      })
      await schema.createTable(`public.${orders}`, table => {
        table.id()
        table.string('code').unique()
      })
      await schema.createTable(`${tenant}.${orders}`, table => {
        table.id()
        table.string('code')
        table.enum('state', ['open', 'closed'] as const).default('open')
      })
      await db.executeCompiled({ sql: `ALTER TABLE "${tenant}"."${orders}" ADD CONSTRAINT "${orders}_code_key" UNIQUE (code)`, source: 'schema' })

      await schema.table(`${tenant}.${orders}`, table => {
        table.dropUnique(`${orders}_code_key`)
        table.renameColumn('state', 'status')
      })

      expect((await schema.getIndexes(orders)).map(index => index.name)).toEqual([`${orders}_pkey`])
      expect((await schema.getColumns(orders)).map(column => column.name)).toEqual(['id', 'code', 'status'])
      await db.table(`${tenant}.${orders}`).insert({ code: 'same', status: 'closed' })
      await db.table(`${tenant}.${orders}`).insert({ code: 'same', status: 'open' })
      await expect(db.table(`${tenant}.${orders}`).insert({ code: 'other', status: 'pending' })).rejects.toThrow()
      await db.table(`public.${orders}`).insert({ code: 'same' })
      await expect(db.table(`public.${orders}`).insert({ code: 'same' })).rejects.toThrow()
    })
  })
}
