import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { clearGeneratedTables, defineModel, holoRuntimeInternals, registerGeneratedTables, renderGeneratedSchemaModule, SchemaError } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

function uniqueName(prefix: string, length = 16): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, length)}`
}

const expectedKinds = {
  sqlite: { foreignId: 'integer', json: 'text', timestamp: 'datetime' },
  postgres: { foreignId: 'bigInteger', json: 'json', timestamp: 'timestamp' },
  mysql: { foreignId: 'bigInteger', json: 'json', timestamp: 'timestamp' },
} as const

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'])) {
  describe(`native ${driver} schema reading`, () => {
    it('reads a table the schema builder created into its table definition', async () => {
      const { db, schema } = await openDatabase(driver)
      const users = uniqueName('holo_read_users')
      const posts = uniqueName('holo_read_posts')
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
        table.text('body').nullable()
        table.boolean('published').default(false)
        table.integer('views').default(7)
        table.json('meta').nullable()
        table.enum('status', ['draft', 'live'] as const).default('draft')
        table.timestamp('published_at').defaultNow()
        table.date('due_on').nullable()
        table.decimal('price')
        table.index(['title'])
      })

      const definition = await createSchemaReader(db).readTable(posts)
      const kinds = expectedKinds[driver]

      expect(definition).toEqual({
        kind: 'table',
        tableName: posts,
        columns: {
          id: { kind: 'id', name: 'id', nullable: false, hasDefault: false, generated: true, primaryKey: true, unique: false, idStrategy: 'autoIncrement' },
          user_id: {
            kind: kinds.foreignId,
            name: 'user_id',
            nullable: false,
            hasDefault: false,
            generated: false,
            primaryKey: false,
            unique: false,
            references: { table: users, column: 'id', constraintName: `${posts}_user_id_foreign`, onDelete: 'cascade' },
          },
          title: { kind: 'string', name: 'title', nullable: false, hasDefault: false, generated: false, primaryKey: false, unique: false },
          body: { kind: 'text', name: 'body', nullable: true, hasDefault: false, generated: false, primaryKey: false, unique: false },
          published: { kind: 'boolean', name: 'published', nullable: false, hasDefault: true, generated: false, primaryKey: false, unique: false, defaultKind: 'value', defaultValue: false },
          views: { kind: 'integer', name: 'views', nullable: false, hasDefault: true, generated: false, primaryKey: false, unique: false, defaultKind: 'value', defaultValue: 7 },
          meta: { kind: kinds.json, name: 'meta', nullable: true, hasDefault: false, generated: false, primaryKey: false, unique: false },
          status: { kind: 'enum', name: 'status', nullable: false, hasDefault: true, generated: false, primaryKey: false, unique: false, defaultKind: 'value', defaultValue: 'draft', enumValues: ['draft', 'live'] },
          published_at: { kind: kinds.timestamp, name: 'published_at', nullable: false, hasDefault: true, generated: false, primaryKey: false, unique: false, defaultKind: 'now' },
          due_on: { kind: 'date', name: 'due_on', nullable: true, hasDefault: false, generated: false, primaryKey: false, unique: false },
          price: { kind: 'decimal', name: 'price', nullable: false, hasDefault: false, generated: false, primaryKey: false, unique: false, ...(driver === 'mysql' ? { decimalTotal: 10, decimalPlaces: 2 } : {}) },
        },
        indexes: expect.arrayContaining([{ name: `${posts}_title_index`, columns: ['title'], unique: false }]),
      })
      await expect(createSchemaReader(db).readTable(uniqueName('holo_read_missing'))).resolves.toBeUndefined()
    })

    it('reads single-column unique indexes with conventional or native default names as unique columns', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_unique')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('inline_code').unique()
        table.string('email')
        table.string('handle')
        table.string('first_name')
        table.string('last_name')
        table.unique(['email'])
        table.unique(['handle'], `${name}_handle_lookup`)
        table.unique(['first_name', 'last_name'])
      })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(Object.fromEntries(Object.values(definition.columns).map(column => [column.name, column.unique]))).toEqual({
        id: false,
        inline_code: true,
        email: true,
        handle: false,
        first_name: false,
        last_name: false,
      })
      expect(definition.indexes).toEqual(expect.arrayContaining([
        { name: `${name}_handle_lookup`, columns: ['handle'], unique: true },
        { name: `${name}_first_name_last_name_unique`, columns: ['first_name', 'last_name'], unique: true },
      ]))
      expect(definition.indexes.flatMap(index => index.columns)).not.toContain('email')
      expect(definition.indexes.flatMap(index => index.columns)).not.toContain('inline_code')
    })

    it('round-trips a unique column with a shortened name through the generated schema as unique()', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_long_unique')
      const longColumn = 'organizer_primary_contact_email_address'
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string(longColumn).unique()
      })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(definition.columns[longColumn]?.unique).toBe(true)
      expect(definition.indexes).toEqual([])
      expect(renderGeneratedSchemaModule([definition])).toContain(`"${longColumn}": column.string().unique(),`)
    })

    it('reads a table without a primary key whose non-null unique column the database could promote to a key', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_keyless')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.string('email').unique()
        table.string('token')
      })

      const reader = createSchemaReader(db)
      const definition = (await reader.readTable(name))!
      const structure = (await reader.readTableStructure(name))!

      expect(structure.primaryKeyColumns).toEqual([])
      expect(structure.columns.filter(column => column.primaryKey)).toEqual([])
      expect(definition.primaryKeyColumns).toBeUndefined()
      expect(definition.columns.email).toMatchObject({ primaryKey: false, unique: true })
      expect(definition.columns.token).toMatchObject({ primaryKey: false, unique: false })
      expect(renderGeneratedSchemaModule([definition])).toContain('"email": column.string().unique(),')
    })

    it('reads referential actions, string lengths and primary-key structure', async () => {
      const { db, schema } = await openDatabase(driver)
      const parents = uniqueName('holo_read_parents')
      const children = uniqueName('holo_read_children')
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, table => {
        table.id()
      })
      await schema.createTable(children, table => {
        table.id()
        table.foreignId('parent_id').nullable().constrained(parents).onDelete('set null').onUpdate('restrict')
        table.string('label')
      })

      const reader = createSchemaReader(db)
      const definition = (await reader.readTable(children))!
      const structure = (await reader.readTableStructure(children))!

      expect(definition.columns.parent_id?.references).toEqual({
        table: parents,
        column: 'id',
        constraintName: `${children}_parent_id_foreign`,
        onDelete: 'set null',
        onUpdate: 'restrict',
      })
      expect(structure.columns.find(column => column.name === 'label')?.length).toBe(255)
      expect(structure.columns.filter(column => column.primaryKey).map(column => column.name)).toEqual(['id'])
      expect(structure.foreignKeys).toEqual([expect.objectContaining({ name: `${children}_parent_id_foreign`, from: 'parent_id', table: parents, to: 'id' })])
    })

    it('reads enum check constraint names for renames', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_checks')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.enum('state', ['open', 'closed'] as const)
      })

      const structure = (await createSchemaReader(db).readTableStructure(name))!

      expect(structure.enumChecks).toEqual([{
        ...(driver === 'mysql' ? {} : { name: `${name}_state_check` }),
        column: 'state',
        values: ['open', 'closed'],
      }])
    })

    it.runIf(driver === 'mysql')('reads enum values that MySQL stores with backslash escapes and doubled quotes as written', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_escaped_enum')
      onTestFinished(() => schema.dropTable(name))
      await db.executeCompiled({ sql: `CREATE TABLE \`${name}\` (\`id\` BIGINT PRIMARY KEY, \`path\` ENUM('C:\\\\temp', 'it''s', 'say \\"hi\\"', 'a\\\\\\'b', 'tab\\there') NOT NULL)`, source: 'schema' })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(definition.columns.path?.enumValues).toEqual(['C:\\temp', 'it\'s', 'say "hi"', 'a\\\'b', 'tab\there'])
    })

    it.runIf(driver === 'sqlite')('reads tables whose implicit foreign keys reference a missing parent or one without a primary key', async () => {
      const { db, schema } = await openDatabase(driver)
      const keyless = uniqueName('holo_read_keyless')
      const orphans = uniqueName('holo_read_orphans')
      const children = uniqueName('holo_read_keyless_children')
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(orphans)
        await schema.dropTable(keyless)
      })
      await db.executeCompiled({ sql: `CREATE TABLE "${keyless}" ("code" TEXT NOT NULL)`, source: 'schema' })
      await db.executeCompiled({ sql: `CREATE TABLE "${orphans}" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER REFERENCES "${uniqueName('holo_read_missing')}")`, source: 'schema' })
      await db.executeCompiled({ sql: `CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "keyless_code" TEXT REFERENCES "${keyless}")`, source: 'schema' })

      const reader = createSchemaReader(db)
      const definitions = [(await reader.readTable(orphans))!, (await reader.readTable(children))!]

      expect(definitions.map(definition => Object.keys(definition.columns))).toEqual([['id', 'parent_id'], ['id', 'keyless_code']])
      const rendered = renderGeneratedSchemaModule(definitions)
      expect(rendered).toContain('"parent_id": column.integer().nullable(),')
      expect(rendered).toContain('"keyless_code": column.text().nullable(),')
    })

    it.runIf(driver === 'sqlite')('reads an FTS5 virtual table from its columns, leaves out its shadow tables, and refuses to rebuild it', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const docs = uniqueName('holo_read_docs')
      onTestFinished(() => schema.dropTable(docs))
      await db.executeCompiled({ sql: `CREATE VIRTUAL TABLE "${docs}" USING fts5(title, body, tokenize='porter')`, source: 'schema' })
      await db.table(docs).insert({ title: 'Running', body: 'runners run' })

      const definitions = await createSchemaReader(db).readGeneratedSchema()

      expect(definitions.map(definition => definition.tableName).sort()).toEqual([docs, table.tableName].sort())
      const rendered = renderGeneratedSchemaModule(definitions)
      expect(rendered).toContain('"title": column.text().nullable(),')
      expect(rendered).toContain('"body": column.text().nullable(),')
      await expect(schema.table(docs, (table) => { table.text('title').change() }))
        .rejects.toThrow(new SchemaError(`SQLite cannot read the definition of table "${docs}" to rebuild it.`))
      expect((await db.queryCompiled<{ title: string }>({ sql: `SELECT title FROM "${docs}" WHERE "${docs}" MATCH 'run'`, source: 'test' })).rows).toEqual([{ title: 'Running' }])
    })

    it.runIf(driver === 'sqlite')('reads a parenthesized string default that contains parentheses as its literal value', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_paren_default')
      onTestFinished(() => schema.dropTable(name))
      await db.executeCompiled({ sql: `CREATE TABLE "${name}" ("id" integer PRIMARY KEY, "face" varchar(10) NOT NULL DEFAULT (((':)'))))`, source: 'schema' })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(definition.columns.face).toMatchObject({ defaultKind: 'value', defaultValue: ':)' })
    })

    it.runIf(driver === 'sqlite')('reads an INTEGER PRIMARY KEY as an auto-incrementing id', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_rowid')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('id').primaryKey()
        table.string('label')
      })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(definition.columns.id).toEqual({ kind: 'id', name: 'id', nullable: false, hasDefault: false, generated: true, primaryKey: true, unique: false, idStrategy: 'autoIncrement' })
    })

    it.runIf(driver === 'sqlite')('reads an INTEGER PRIMARY KEY that is not the rowid alias as a required primary-key column', async () => {
      const { db, schema } = await openDatabase(driver)
      const withoutRowId = uniqueName('holo_read_without_rowid')
      const descending = uniqueName('holo_read_desc_key')
      onTestFinished(async () => {
        await schema.dropTable(withoutRowId)
        await schema.dropTable(descending)
      })
      await db.executeCompiled({ sql: `CREATE TABLE "${withoutRowId}" ("id" INTEGER PRIMARY KEY, "value" TEXT NOT NULL) WITHOUT ROWID`, source: 'schema' })
      await db.executeCompiled({ sql: `CREATE TABLE "${descending}" ("id" INTEGER PRIMARY KEY DESC, "value" TEXT NOT NULL)`, source: 'schema' })
      await expect(db.table(withoutRowId).insert({ value: 'needs an id' })).rejects.toThrow()

      const reader = createSchemaReader(db)
      const definitions = [(await reader.readTable(withoutRowId))!, (await reader.readTable(descending))!]

      for (const definition of definitions) {
        expect(definition.columns.id).toEqual({ kind: 'integer', name: 'id', nullable: false, hasDefault: false, generated: false, primaryKey: true, unique: false })
      }
      expect(renderGeneratedSchemaModule(definitions)).toContain('"id": column.integer().primaryKey(),')
    })

    it.runIf(driver === 'postgres')('reads vector dimensions, uuid and jsonb columns', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_vectors')
      onTestFinished(() => schema.dropTable(name))
      await db.executeCompiled({ sql: 'CREATE EXTENSION IF NOT EXISTS vector', source: 'schema' })
      await schema.createTable(name, table => {
        table.uuid('id').primaryKey()
        table.vector('embedding', { dimensions: 3 }).nullable()
        table.json('settings').default({ theme: 'dark' })
      })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect(definition.columns).toEqual({
        id: { kind: 'uuid', name: 'id', nullable: false, hasDefault: false, generated: false, primaryKey: true, unique: false },
        embedding: { kind: 'vector', name: 'embedding', nullable: true, hasDefault: false, generated: false, primaryKey: false, unique: false, vectorDimensions: 3 },
        settings: { kind: 'json', name: 'settings', nullable: false, hasDefault: true, generated: false, primaryKey: false, unique: false, defaultKind: 'value', defaultValue: { theme: 'dark' } },
      })
    })

    it.runIf(driver === 'postgres')('reads tables, unique columns and foreign keys from the configured non-public schema', async () => {
      const tenant = uniqueName('tenant', 8)
      const { db, schema } = await openDatabase(driver, { schemaName: tenant })
      const customers = uniqueName('customers', 8)
      const orders = uniqueName('orders', 8)
      onTestFinished(async () => {
        await db.executeCompiled({ sql: `DROP SCHEMA IF EXISTS "${tenant}" CASCADE`, source: 'schema' })
        await schema.dropTable(`public.${orders}`)
      })
      await schema.createTable(`public.${orders}`, table => {
        table.id()
        table.string('public_only')
      })
      await schema.createTable(`${tenant}.${customers}`, table => {
        table.id()
      })
      await schema.createTable(`${tenant}.${orders}`, table => {
        table.id()
        table.string('email')
        table.foreignId('customer_id').constrained(`${tenant}.${customers}`)
        table.unique(['email'])
      })

      const reader = createSchemaReader(db)

      await expect(reader.listTables()).resolves.toEqual([customers, orders].sort())
      const definition = (await reader.readTable(orders))!
      expect(Object.keys(definition.columns)).toEqual(['id', 'email', 'customer_id'])
      expect(definition.columns.email?.unique).toBe(true)
      expect(definition.columns.customer_id?.references).toEqual({ table: customers, column: 'id', constraintName: `${tenant}_${orders}_customer_id_foreign` })
      expect((await reader.readGeneratedSchema()).map(table => table.tableName).sort()).toEqual([customers, orders].sort())
    })

    it.runIf(driver === 'postgres')('reads a primary key with INCLUDE columns as its key column and resolves its model', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_covering_pk')
      onTestFinished(async () => {
        clearGeneratedTables()
        await schema.dropTable(name)
      })
      await db.executeCompiled({ sql: `CREATE TABLE "${name}" ("id" integer NOT NULL, "email" varchar(255) NOT NULL, PRIMARY KEY ("id") INCLUDE ("email"))`, source: 'schema' })
      await db.table(name).insert([{ id: 1, email: 'first@example.com' }, { id: 2, email: 'second@example.com' }])

      const definition = (await createSchemaReader(db).readTable(name))!
      registerGeneratedTables({ [name]: definition })

      expect([definition.columns.id?.primaryKey, definition.columns.email?.primaryKey]).toEqual([true, false])
      expect((await defineModel(name, { timestamps: false }).find(2))?.get('email')).toBe('second@example.com')
    })

    it.runIf(driver === 'postgres')('reads a unique index with INCLUDE columns as a unique key column', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueName('holo_read_covering_unique')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('code')
        table.string('label')
      })
      await db.executeCompiled({ sql: `CREATE UNIQUE INDEX "${name}_code_unique" ON "${name}" ("code") INCLUDE ("label")`, source: 'schema' })

      const definition = (await createSchemaReader(db).readTable(name))!

      expect([definition.columns.code?.unique, definition.columns.label?.unique]).toEqual([true, false])
      expect(definition.indexes).toEqual([])
    })

    it.runIf(driver === 'postgres')('round-trips unique columns of a schema-qualified table through the generated schema as unique()', async () => {
      const tenant = uniqueName('tenant', 8)
      const { db, schema } = await openDatabase(driver, { schemaName: tenant })
      const accounts = uniqueName('accounts', 8)
      const longColumn = 'organizer_primary_contact_email_address'
      onTestFinished(async () => {
        await db.executeCompiled({ sql: `DROP SCHEMA IF EXISTS "${tenant}" CASCADE`, source: 'schema' })
      })
      await schema.createTable(`${tenant}.${accounts}`, table => {
        table.id()
        table.string('code').unique()
        table.string(longColumn).unique()
      })

      const [definition] = await createSchemaReader(db).readGeneratedSchema()

      expect(definition?.columns.code?.unique).toBe(true)
      expect(definition?.columns[longColumn]?.unique).toBe(true)
      expect(definition?.indexes).toEqual([])
    })
  })
}
