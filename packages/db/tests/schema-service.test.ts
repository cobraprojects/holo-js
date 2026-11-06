import { randomUUID } from 'node:crypto'
import { getEventListeners } from 'node:events'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { column, createDatabase, createDialect, createSchemaService, defineModel, type DriverAdapter, holoRuntimeInternals, SchemaError, TransactionError, unsafeSql } from '../src'
import { defineTable } from './support/internal'
import { integrationDrivers, openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

async function readTempViewsAndTriggers(adapter: DriverAdapter): Promise<string[]> {
  const result = await adapter.query<{ name: string }>('SELECT name FROM temp.sqlite_master WHERE type IN (\'view\', \'trigger\') ORDER BY name')
  return result.rows.map(row => row.name)
}

for (const driver of integrationDrivers(['sqlite', 'postgres', 'mysql'])) {
  describe(`native ${driver} schema service`, () => {
    it('finds schema-qualified tables with hasTable()', async () => {
      const { schema, adapter, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const home = driver === 'sqlite' ? `main.${name}` : table.tableName
      expect(await schema.hasTable(home)).toBe(true)
      expect(await schema.hasTable(`${home}_missing`)).toBe(false)
      if (driver === 'sqlite') return
      const tenant = `holo_tenant_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const quoted = driver === 'postgres' ? `"${tenant}"` : `\`${tenant}\``
      onTestFinished(async () => { await adapter.execute(driver === 'postgres' ? `DROP SCHEMA IF EXISTS ${quoted} CASCADE` : `DROP DATABASE IF EXISTS ${quoted}`) })
      await adapter.execute(driver === 'postgres' ? `CREATE SCHEMA ${quoted}` : `CREATE DATABASE ${quoted}`)
      await schema.createTable(`${tenant}.orders`, table => {
        table.id()
        table.string('reference')
      })

      expect(await schema.hasTable(`${tenant}.orders`)).toBe(true)
      expect(await schema.hasTable(`${tenant}.invoices`)).toBe(false)
      expect(await schema.hasTable('orders')).toBe(false)
      expect((await schema.getColumns(`${tenant}.orders`)).map(column => column.name)).toEqual(['id', 'reference'])
    })

    it.runIf(driver === 'mysql')('does not find views with a schema-qualified hasTable() but lists their columns', async () => {
      const { schema, adapter, table } = await openDatabase(driver)
      const view = `${table.tableName}_view`
      onTestFinished(async () => { await adapter.execute(`DROP VIEW IF EXISTS ${view.split('.').map(part => `\`${part}\``).join('.')}`) })
      await adapter.execute(`CREATE VIEW ${view.split('.').map(part => `\`${part}\``).join('.')} AS SELECT id FROM ${table.tableName.split('.').map(part => `\`${part}\``).join('.')}`)

      expect(await schema.hasTable(view)).toBe(false)
      expect(await schema.hasTable(view.split('.').at(-1)!)).toBe(false)
      expect((await schema.getColumns(view)).map(column => column.name)).toEqual(['id'])
    })

    it('creates typed columns, defaults, indexes, and constraints that accept valid records', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_schema_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('email').unique()
        table.boolean('active').default(true)
        table.integer('visits').default(7)
        table.json('settings').nullable()
        table.timestamp('created_at').nullable()
        table.index(['active'])
      })
      expect(await schema.hasTable(name)).toBe(true)
      const definition = defineTable(name, {
        id: column.id(),
        email: column.string().unique(),
        active: column.boolean().default(true),
        visits: column.integer().default(7),
        settings: column.json().nullable(),
        created_at: column.timestamp().nullable(),
      })
      const createdAt = new Date('2026-01-01T00:00:00Z')
      await db.table(definition).insert({ email: 'native@example.com', settings: { enabled: true }, created_at: createdAt })
      const row = (await db.table(definition).first())!
      expect(Number(row.id)).toBe(1)
      expect(Number(row.visits)).toBe(7)
      expect([true, 1]).toContain(row.active)
      expect(typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings).toEqual({ enabled: true })
      await expect(db.table(definition).insert({ email: 'native@example.com' })).rejects.toThrow()
      await expect(db.table(definition).insert({ active: false })).rejects.toThrow()
      expect(await db.table(definition).count()).toBe(1)
      expect((await schema.getColumns(name)).find(column => column.name === 'id')).toMatchObject({ primaryKey: true, notNull: true })
      expect(await schema.getIndexes(name)).toEqual(expect.arrayContaining([expect.objectContaining({ columns: ['active'], unique: false })]))
    })

    it('renames tables and columns and preserves persisted rows', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const original = table.tableName.split('.').at(-1)!
      const renamed = `${original}_renamed`
      onTestFinished(async () => { if (await schema.hasTable(renamed)) await schema.dropTable(renamed) })
      await db.table(table).insert({ id: 1, name: 'Preserved', active: true })
      await schema.renameTable(original, renamed)
      expect(await schema.hasTable(original)).toBe(false)
      expect(await schema.hasTable(renamed)).toBe(true)
      await schema.table(renamed, table => { table.renameColumn('name', 'title') })
      expect(await db.table(renamed).pluck('title')).toEqual(['Preserved'])
      expect((await schema.getColumns(renamed)).map(column => column.name)).toContain('title')
      expect((await schema.getColumns(renamed)).map(column => column.name)).not.toContain('name')
    })

    it('adds, changes, and drops columns while preserving keys and records', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      await db.table(table).insert({ id: 1, name: 'Original', active: true })
      await schema.table(name, table => { table.string('nickname').nullable().default('guest') })
      expect(await db.table(name).pluck('nickname')).toEqual(['guest'])
      await schema.table(name, table => { table.string('nickname').nullable().default('changed').change() })
      expect(await db.table(name).pluck('nickname')).toEqual(['guest'])
      await db.table(name).insert({ id: 2, name: 'Second', active: false })
      expect(await db.table(name).where('id', 2).pluck('nickname')).toEqual(['changed'])
      expect((await schema.getColumns(name)).find(column => column.name === 'id')?.primaryKey).toBe(true)
      await schema.table(name, table => { table.dropColumn('nickname') })
      expect((await schema.getColumns(name)).map(column => column.name)).not.toContain('nickname')
      expect(await db.table(name).orderBy('id').pluck('name')).toEqual(['Original', 'Second'])
    })

    it('changes a column of a table created by raw SQL to exactly the modifiers given', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_change_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE ${name} (id integer PRIMARY KEY, nickname varchar(40) NULL DEFAULT 'guest')`)
      await db.table(name).insert({ id: 1 })

      await schema.table(name, table => { table.string('nickname').change() })

      expect((await schema.getColumns(name)).find(column => column.name === 'nickname')).toMatchObject({ notNull: true, defaultValue: null })
      await expect(db.table(name).insert({ id: 2 })).rejects.toThrow()
      await expect(db.table(name).insert({ id: 2, nickname: null })).rejects.toThrow()

      await schema.table(name, table => { table.string('nickname').nullable().change() })

      await db.table(name).insert({ id: 2 })
      expect(await db.table(name).orderBy('id').pluck('nickname')).toEqual(['guest', null])
    })

    it.runIf(driver === 'sqlite')('rebuilds a table on change() keeping undeclared columns, data, indexes, foreign keys, and triggers', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const members = `holo_members_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(members)
        await schema.dropTable(parents)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${members}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "parent_id" INTEGER CONSTRAINT "members_parent" REFERENCES "${parents}" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
        "email" TEXT NOT NULL UNIQUE,
        "code" TEXT COLLATE NOCASE CHECK (length("code") <= 5),
        "status" TEXT NOT NULL DEFAULT 'active' CONSTRAINT "members_status_check" CHECK ("status" IN ('active', 'banned')),
        "nickname" TEXT DEFAULT 'guest',
        "visits" INTEGER NOT NULL DEFAULT 0,
        UNIQUE ("parent_id", "code")
      )`)
      await adapter.execute(`CREATE INDEX "members_visits_index" ON "${members}" ("visits")`)
      await adapter.execute(`CREATE TRIGGER "members_count_visit" AFTER INSERT ON "${members}" BEGIN UPDATE "${members}" SET "visits" = "visits" + 1 WHERE "id" = NEW."id"; END`)
      await db.table(parents).insert([{ id: 1 }, { id: 2 }])
      await db.table(members).insert([
        { parent_id: 1, email: 'a@example.com', code: 'abc', status: 'active' },
        { parent_id: 2, email: 'b@example.com', code: 'xyz', status: 'banned' },
      ])
      await db.table(members).where('id', 2).delete()
      const reader = createSchemaReader(db)
      const before = (await reader.readTableStructure(members))!

      await schema.table(members, table => { table.string('nickname').nullable().change() })

      const after = (await reader.readTableStructure(members))!
      expect(after.columns.filter(column => column.name !== 'nickname')).toEqual(before.columns.filter(column => column.name !== 'nickname'))
      expect(after.columns.find(column => column.name === 'nickname')).toMatchObject({ fullType: 'varchar(255)', notNull: false, default: { kind: 'none' } })
      expect(after.foreignKeys).toEqual(before.foreignKeys)
      expect(after.enumChecks).toEqual(before.enumChecks)
      expect(after.indexes.map(index => [index.columns, index.unique])).toEqual(before.indexes.map(index => [index.columns, index.unique]))
      expect(await db.table(members).select('id', 'parent_id', 'email', 'code', 'status', 'nickname', 'visits').get()).toEqual([
        { id: 1, parent_id: 1, email: 'a@example.com', code: 'abc', status: 'active', nickname: 'guest', visits: 1 },
      ])

      const id = await db.table(members).insertGetId({ parent_id: 2, email: 'c@example.com', code: 'ABC' })
      expect(id).toBe(3)
      expect(await db.table(members).where('id', id).first()).toMatchObject({ nickname: null, visits: 1 })
      await expect(db.table(members).insert({ parent_id: 1, email: 'a@example.com', code: 'new' })).rejects.toThrow()
      await expect(db.table(members).insert({ parent_id: 1, email: 'd@example.com', code: 'ABC' })).rejects.toThrow()
      await expect(db.table(members).insert({ parent_id: 1, email: 'e@example.com', code: 'toolong' })).rejects.toThrow()
      await expect(db.table(members).insert({ parent_id: 1, email: 'f@example.com', status: 'gone' })).rejects.toThrow()
      await expect(db.table(members).insert({ parent_id: 99, email: 'g@example.com' })).rejects.toThrow()
      await db.table(parents).where('id', 1).delete()
      expect(await db.table(members).pluck('email')).toEqual(['c@example.com'])
    })

    it.runIf(driver === 'sqlite')('changes a column of a table whose stored definition contains SQL comments', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_commented_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, -- the key, (unbalanced
        "value" TEXT /* ) , "status" */ NOT NULL,
        /* a comment, before a column */ "status" TEXT NOT NULL CHECK ("status" IN ('open', 'closed')),
        "note" TEXT -- trailing, comment
      )`)
      await db.table(name).insert({ value: 'kept', status: 'open', note: 'old' })

      await schema.table(name, table => { table.string('note').nullable().default('none').change() })

      const columns = await schema.getColumns(name)
      expect(columns.map(column => [column.name, column.notNull])).toEqual([['id', true], ['value', true], ['status', true], ['note', false]])
      await db.table(name).insert({ value: 'new', status: 'closed' })
      expect(await db.table(name).orderBy('id').get()).toEqual([
        { id: 1, value: 'kept', status: 'open', note: 'old' },
        { id: 2, value: 'new', status: 'closed', note: 'none' },
      ])
      await expect(db.table(name).insert({ status: 'open' })).rejects.toThrow()
      await expect(db.table(name).insert({ value: 'x', status: 'gone' })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('keeps every child row when change() rebuilds a parent referenced with ON DELETE CASCADE', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(children, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).cascadeOnDelete()
      })
      await db.table(parents).insert([{ name: 'first' }, { name: 'second' }])
      await db.table(children).insert([{ parent_id: 1 }, { parent_id: 2 }, { parent_id: 2 }])

      await schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() })

      expect(await db.table(children).orderBy('id').pluck('parent_id')).toEqual([1, 2, 2])
      await db.table(parents).where('id', 2).delete()
      expect(await db.table(children).pluck('parent_id')).toEqual([1])
    })

    for (const sharing of ['another context on the same adapter', 'the same context'] as const) {
      it.runIf(driver === 'sqlite')(`keeps every child row when change() rebuilds a parent while ${sharing} has foreign-key checks off`, async () => {
        let readEnforcement!: () => void
        const enforcementRead = new Promise<void>(resolve => { readEnforcement = resolve })
        const { db, schema, adapter } = await openDatabase(driver, {
          wrapAdapter: adapter => new Proxy(adapter, {
            get(target, property) {
              const introspect = target.introspect?.bind(target)
              if (property !== 'introspect' || !introspect) return Reflect.get(target, property, target)
              return async (...args: Parameters<typeof introspect>) => {
                const result = await introspect(...args)
                if (args[0] === 'PRAGMA foreign_keys') readEnforcement()
                return result
              }
            },
          }),
        })
        const suspending = sharing === 'the same context'
          ? schema
          : createSchemaService(createDatabase({ connectionName: 'default', adapter, dialect: createDialect(driver) }))
        const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
        const parents = `holo_parents_${suffix}`
        const children = `holo_children_${suffix}`
        onTestFinished(async () => {
          await schema.dropTable(children)
          await schema.dropTable(parents)
        })
        await schema.createTable(parents, (table) => {
          table.id()
          table.string('name').nullable()
        })
        await schema.createTable(children, (table) => {
          table.id()
          table.foreignId('parent_id').constrained(parents).cascadeOnDelete()
        })
        await db.table(parents).insert([{ name: 'first' }, { name: 'second' }])
        await db.table(children).insert([{ parent_id: 1 }, { parent_id: 2 }])

        let suspended!: () => void
        const change = new Promise<void>(resolve => { suspended = resolve })
          .then(() => schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() }))
        await suspending.withoutForeignKeyConstraints(async () => {
          suspended()
          await Promise.race([enforcementRead, new Promise(resolve => setTimeout(resolve, 50))])
        })
        await change

        expect(await db.table(children).orderBy('id').pluck('parent_id')).toEqual([1, 2])
        await db.table(parents).where('id', 2).delete()
        expect(await db.table(children).pluck('parent_id')).toEqual([1])
      }, 5_000)
    }

    it.runIf(driver === 'sqlite')('changes a column referencing the primary key of its parent implicitly and keeps the key enforcing', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("code" TEXT PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "parent_code" TEXT REFERENCES "${parents}")`)
      await db.table(parents).insert({ code: 'a' })
      await db.table(children).insert({ id: 1, parent_code: 'a' })

      await schema.table(children, (table) => { table.string('parent_code').nullable().change() })

      expect(await schema.getForeignKeys(children)).toEqual([expect.objectContaining({ table: parents, from: 'parent_code', to: 'code' })])
      await db.table(children).insert({ id: 2, parent_code: 'a' })
      await expect(db.table(children).insert({ id: 3, parent_code: 'missing' })).rejects.toThrow()
      expect(await db.table(children).orderBy('id').pluck('parent_code')).toEqual(['a', 'a'])
    })

    it.runIf(driver === 'sqlite')('keeps a deferred foreign key deferred when change() rebuilds the referencing column', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER NOT NULL CONSTRAINT "children_parent" REFERENCES "${parents}" ("id") ON DELETE CASCADE MATCH SIMPLE DEFERRABLE INITIALLY DEFERRED)`)

      await schema.table(children, (table) => { table.integer('parent_id').nullable().change() })

      await db.transaction(async (transaction) => {
        await transaction.table(children).insert({ id: 1, parent_id: 7 })
        await transaction.table(parents).insert({ id: 7 })
      })
      await expect(db.transaction(async (transaction) => {
        await transaction.table(children).insert({ id: 2, parent_id: 8 })
      })).rejects.toThrow()
      expect(await schema.getForeignKeys(children)).toEqual([expect.objectContaining({ table: parents, from: 'parent_id', to: 'id', onDelete: 'CASCADE' })])
      expect((await schema.getColumns(children)).find(column => column.name === 'parent_id')).toMatchObject({ notNull: false })
      await db.table(parents).where('id', 7).delete()
      expect(await db.table(children).count()).toBe(0)

      await schema.table(children, (table) => { table.dropForeign('children_parent') })
      await db.table(children).insert({ id: 3, parent_id: 99 })
      expect(await schema.getForeignKeys(children)).toEqual([])
    })

    it.runIf(driver === 'sqlite')('keeps every foreign key of a column referencing several parents when change() rebuilds it', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const firstParents = `holo_first_parents_${suffix}`
      const secondParents = `holo_second_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(secondParents)
        await schema.dropTable(firstParents)
      })
      await adapter.execute(`CREATE TABLE "${firstParents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${secondParents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER NOT NULL REFERENCES "${firstParents}" ("id") REFERENCES "${secondParents}" ("id"))`)
      await db.table(firstParents).insert([{ id: 1 }, { id: 2 }])
      await db.table(secondParents).insert([{ id: 1 }, { id: 3 }])

      await schema.table(children, (table) => { table.integer('parent_id').nullable().change() })

      await db.table(children).insert([{ id: 1, parent_id: 1 }, { id: 2, parent_id: null }])
      await expect(db.table(children).insert({ id: 3, parent_id: 2 })).rejects.toThrow()
      await expect(db.table(children).insert({ id: 4, parent_id: 3 })).rejects.toThrow()
      expect(await db.table(children).orderBy('id').pluck('parent_id')).toEqual([1, null])
    })

    it.runIf(driver === 'sqlite')('keeps the collation of a unique column when change() rebuilds it', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_collated_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY, "email" TEXT NOT NULL COLLATE NOCASE UNIQUE)`)
      await db.table(name).insert({ id: 1, email: 'A' })

      await schema.table(name, (table) => { table.text('email').nullable().change() })

      await expect(db.table(name).insert({ id: 2, email: 'a' })).rejects.toThrow()
      await db.table(name).insert({ id: 3, email: null })
      expect(await db.table(name).orderBy('id').pluck('email')).toEqual(['A', null])
    })

    it.runIf(driver === 'sqlite')('keeps a descending INTEGER PRIMARY KEY apart from the rowid when change() rebuilds it', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_descending_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY DESC, "title" TEXT NOT NULL)`)
      await db.table(name).insert([{ id: null, title: 'first' }, { id: null, title: 'second' }])

      await schema.table(name, (table) => { table.integer('id').nullable().change() })

      expect(await db.table(name).orderBy('title').get()).toEqual([{ id: null, title: 'first' }, { id: null, title: 'second' }])
      expect((await schema.getColumns(name)).find(column => column.name === 'id')).toMatchObject({ primaryKey: true })
    })

    it.runIf(driver === 'sqlite')('replaces only the type, nullability and default of a column on change() and keeps its other constraints', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const firstParents = `holo_first_codes_${suffix}`
      const secondParents = `holo_second_codes_${suffix}`
      const name = `holo_coded_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(name)
        await schema.dropTable(secondParents)
        await schema.dropTable(firstParents)
      })
      await adapter.execute(`CREATE TABLE "${firstParents}" ("code" TEXT PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${secondParents}" ("code" TEXT PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY, "code" VARCHAR(10) NOT NULL DEFAULT 'xyz' COLLATE NOCASE CHECK (length("code") <= 5) REFERENCES "${firstParents}" ("code") REFERENCES "${secondParents}" ("code") UNIQUE ON CONFLICT IGNORE)`)
      await db.table(firstParents).insert([{ code: 'abc' }, { code: 'xyz' }, { code: 'one' }, { code: 'longer' }])
      await db.table(secondParents).insert([{ code: 'abc' }, { code: 'xyz' }, { code: 'two' }, { code: 'longer' }])

      await schema.table(name, (table) => { table.text('code').nullable().default('abc').change() })

      expect((await schema.getColumns(name)).find(column => column.name === 'code')).toMatchObject({ type: 'TEXT', notNull: false })
      await db.table(name).insert({ id: 1 })
      await db.table(name).insert({ id: 2, code: null })
      await db.table(name).insert({ id: 3, code: 'ABC' })
      await expect(db.table(name).insert({ id: 4, code: 'longer' })).rejects.toThrow()
      await expect(db.table(name).insert({ id: 5, code: 'one' })).rejects.toThrow()
      await expect(db.table(name).insert({ id: 6, code: 'two' })).rejects.toThrow()
      expect(await db.table(name).orderBy('id').pluck('code')).toEqual(['abc', null])
    })

    it.runIf(driver === 'sqlite')('changes a parent referenced with RESTRICT and NO ACTION and keeps enforcing those keys', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const restricted = `holo_restricted_${suffix}`
      const unchecked = `holo_unchecked_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(restricted)
        await schema.dropTable(unchecked)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(restricted, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).restrictOnDelete()
      })
      await schema.createTable(unchecked, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).noActionOnDelete()
      })
      await db.table(parents).insert([{ name: 'first' }, { name: 'second' }])
      await db.table(restricted).insert({ parent_id: 1 })
      await db.table(unchecked).insert({ parent_id: 2 })

      await schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() })

      expect(await db.table(restricted).pluck('parent_id')).toEqual([1])
      expect(await db.table(unchecked).pluck('parent_id')).toEqual([2])
      await expect(db.table(parents).where('id', 1).delete()).rejects.toThrow()
      await expect(db.table(parents).where('id', 2).delete()).rejects.toThrow()
      await expect(db.table(restricted).insert({ parent_id: 99 })).rejects.toThrow()
      expect(await db.table(parents).count()).toBe(2)
    })

    it.runIf(driver === 'sqlite')('leaves foreign-key enforcement off after change() when it was off before', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await adapter.execute('PRAGMA foreign_keys = ON')
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(children, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).cascadeOnDelete()
      })
      await db.table(parents).insert({ name: 'first' })
      await db.table(children).insert({ parent_id: 1 })
      await adapter.execute('PRAGMA foreign_keys = OFF')

      await schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() })

      await db.table(children).insert({ parent_id: 99 })
      expect(await db.table(children).orderBy('id').pluck('parent_id')).toEqual([1, 99])
    })

    it.runIf(driver === 'sqlite')('rejects a change() rebuild that would leave a foreign key violation and rolls it back', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(children, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).cascadeOnDelete()
      })
      await db.table(parents).insert({ name: 'first' })
      await schema.withoutForeignKeyConstraints(() => db.table(children).insert([{ parent_id: 1 }, { parent_id: 99 }]))

      await expect(schema.table(parents, (table) => { table.string('name').nullable().default('unnamed').change() }))
        .rejects.toThrow(new SchemaError(`SQLite cannot rebuild table "${parents}" because it would leave 1 foreign key violation.`))

      await db.table(parents).insert({ id: 2 })
      expect(await db.table(parents).where('id', 2).pluck('name')).toEqual([null])
      expect(await db.table(children).orderBy('id').pluck('parent_id')).toEqual([1, 99])
      await expect(db.table(children).insert({ parent_id: 98 })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('refuses to rebuild a referenced parent inside a transaction while foreign-key enforcement is on', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(children, (table) => {
        table.id()
        table.foreignId('parent_id').constrained(parents).cascadeOnDelete()
      })
      await db.table(parents).insert({ name: 'first' })
      await db.table(children).insert({ parent_id: 1 })

      await expect(db.transaction(tx => createSchemaService(tx).table(parents, (table) => {
        table.string('name').nullable().default('unnamed').change()
      }))).rejects.toThrow(SchemaError)
      await db.transaction(tx => createSchemaService(tx).table(children, (table) => {
        table.foreignId('parent_id').nullable().change()
      }))

      expect(await db.table(children).pluck('parent_id')).toEqual([1])
      await db.table(children).insert({ parent_id: null })
      await db.table(parents).insert({ id: 2 })
      expect(await db.table(parents).where('id', 2).pluck('name')).toEqual([null])
      await db.table(parents).where('id', 1).delete()
      expect(await db.table(children).pluck('parent_id')).toEqual([null])
    })

    it.runIf(driver === 'sqlite')('refuses to rebuild a parent that a child references in another letter case inside a transaction', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const children = `holo_children_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
      })
      await schema.createTable(parents, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await adapter.execute(`CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER REFERENCES "${parents.toUpperCase()}" ("id") ON DELETE CASCADE)`)
      await db.table(parents).insert({ name: 'first' })
      await db.table(children).insert({ parent_id: 1 })

      for (const target of [parents, parents.toUpperCase(), `main.${parents}`, `MAIN.${parents.toUpperCase()}`]) {
        await expect(db.transaction(tx => createSchemaService(tx).table(target, (table) => {
          table.string('name').nullable().default('unnamed').change()
        }))).rejects.toThrow(new SchemaError(
          `SQLite cannot rebuild table "${target}" inside a transaction while foreign-key enforcement is on, because table "${children}" references it. Run the change outside the transaction or in a migration.`,
        ))
      }

      expect(await db.table(children).pluck('parent_id')).toEqual([1])
      await db.table(parents).insert({ id: 2 })
      expect(await db.table(parents).orderBy('id').pluck('name')).toEqual(['first', null])
    })

    it.runIf(driver === 'sqlite')('keeps views and other tables\' triggers that depend on a table working after change() rebuilds it', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const records = `holo_records_${suffix}`
      const inbox = `holo_inbox_${suffix}`
      const recordsView = `holo_records_view_${suffix}`
      const namesView = `holo_names_view_${suffix}`
      const sessionView = `holo_session_view_${suffix}`
      onTestFinished(async () => {
        await adapter.execute(`DROP VIEW IF EXISTS temp."${sessionView}"`)
        await adapter.execute(`DROP VIEW IF EXISTS "${namesView}"`)
        await adapter.execute(`DROP VIEW IF EXISTS "${recordsView}"`)
        await schema.dropTable(inbox)
        await schema.dropTable(records)
      })
      await schema.createTable(records, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(inbox, (table) => {
        table.string('message')
      })
      await adapter.execute(`CREATE VIEW "${recordsView}" AS SELECT "id", "name" FROM "${records}"`)
      await adapter.execute(`CREATE VIEW "${namesView}" AS SELECT "name" FROM "${recordsView}"`)
      await adapter.execute(`CREATE TEMP VIEW "${sessionView}" AS SELECT "name" FROM main."${records}"`)
      await adapter.execute(`CREATE TRIGGER "inbox_files_${suffix}" AFTER INSERT ON "${inbox}" BEGIN INSERT INTO "${records}" ("name") VALUES (NEW."message"); END`)
      await adapter.execute(`CREATE TRIGGER "names_insert_${suffix}" INSTEAD OF INSERT ON "${namesView}" BEGIN INSERT INTO "${records}" ("name") VALUES (NEW."name"); END`)
      await db.table(records).insert({ name: 'first' })

      await schema.table(records, (table) => { table.string('name').nullable().default('unnamed').change() })

      await db.table(inbox).insert({ message: 'filed' })
      await db.table(namesView).insert({ name: 'through view' })
      await db.table(records).insert({ id: 4 })
      expect(await db.table(recordsView).orderBy('id').pluck('name')).toEqual(['first', 'filed', 'through view', 'unnamed'])
      expect(await db.table(namesView).pluck('name')).toEqual(['first', 'filed', 'through view', 'unnamed'])
      expect(await db.table(sessionView).pluck('name')).toEqual(['first', 'filed', 'through view', 'unnamed'])
    })

    it.runIf(driver === 'sqlite')('keeps a temp view in the temp schema beside a same-named main view after change() rebuilds their table', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const records = `holo_records_${suffix}`
      const recordsView = `holo_records_view_${suffix}`
      onTestFinished(async () => {
        await adapter.execute(`DROP VIEW IF EXISTS temp."${recordsView}"`)
        await adapter.execute(`DROP VIEW IF EXISTS main."${recordsView}"`)
        await schema.dropTable(records)
      })
      await schema.createTable(records, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await adapter.execute(`CREATE VIEW main."${recordsView}" AS SELECT "id" FROM "${records}"`)
      await adapter.execute(`CREATE TEMP VIEW "${recordsView}" AS SELECT "name" FROM main."${records}"`)
      await db.table(records).insert({ name: 'first' })

      await schema.table(records, (table) => { table.string('name').nullable().default('unnamed').change() })

      await db.table(records).insert({ id: 2 })
      expect(await readTempViewsAndTriggers(adapter)).toEqual([recordsView])
      expect(await db.table(`main.${recordsView}`).orderBy('id').pluck('id')).toEqual([1, 2])
      expect(await db.table(recordsView).pluck('name')).toEqual(['first', 'unnamed'])
    })

    it.runIf(driver === 'sqlite')('keeps a temp trigger on another table that writes into a rebuilt table in the temp schema after change()', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const records = `holo_records_${suffix}`
      const inbox = `holo_inbox_${suffix}`
      const inboxTrigger = `holo_inbox_files_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(inbox)
        await schema.dropTable(records)
      })
      await schema.createTable(records, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(inbox, table => { table.string('message') })
      await adapter.execute(`CREATE TEMP TRIGGER "${inboxTrigger}" AFTER INSERT ON main."${inbox}" BEGIN INSERT INTO "${records}" ("name") VALUES (NEW."message"); END`)

      await schema.table(records, (table) => { table.string('name').nullable().default('unnamed').change() })

      await db.table(inbox).insert({ message: 'filed' })
      expect(await readTempViewsAndTriggers(adapter)).toEqual([inboxTrigger])
      expect(await db.table(records).pluck('name')).toEqual(['filed'])
    })

    it.runIf(driver === 'sqlite')('keeps a temp trigger defined on a rebuilt main table firing in the temp schema after change()', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const records = `holo_records_${suffix}`
      const audits = `holo_audits_${suffix}`
      const auditTrigger = `holo_records_audit_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(audits)
        await schema.dropTable(records)
      })
      await schema.createTable(records, (table) => {
        table.id()
        table.string('name').nullable()
      })
      await schema.createTable(audits, table => { table.string('name').nullable() })
      await adapter.execute(`CREATE TEMP TRIGGER "${auditTrigger}" AFTER INSERT ON main."${records}" BEGIN INSERT INTO "${audits}" ("name") VALUES (NEW."name"); END`)
      await db.table(records).insert({ name: 'first' })

      await schema.table(records, (table) => { table.string('name').nullable().default('unnamed').change() })

      await db.table(records).insert({ id: 2 })
      expect(await readTempViewsAndTriggers(adapter)).toEqual([auditTrigger])
      expect(await db.table(audits).pluck('name')).toEqual(['first', 'unnamed'])
    })

    it.runIf(driver === 'sqlite')('rebuilds a mixed-case parent named in another letter case and keeps its rows, children, and triggers', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `Holo_Parents_${suffix}`
      const children = `holo_children_${suffix}`
      const audits = `holo_audits_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(children)
        await schema.dropTable(parents)
        await schema.dropTable(audits)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("id" INTEGER PRIMARY KEY, "name" TEXT)`)
      await adapter.execute(`CREATE TABLE "${audits}" ("name" TEXT)`)
      await adapter.execute(`CREATE TABLE "${children}" ("id" INTEGER PRIMARY KEY, "parent_id" INTEGER REFERENCES "${parents.toLowerCase()}" ("id") ON DELETE CASCADE)`)
      await adapter.execute(`CREATE TRIGGER "parents_audit_${suffix}" AFTER INSERT ON "${parents.toLowerCase()}" BEGIN INSERT INTO "${audits}" ("name") VALUES (NEW."name"); END`)
      await db.table(parents).insert({ id: 1, name: 'first' })
      await db.table(children).insert({ parent_id: 1 })

      await schema.table(parents.toLowerCase(), (table) => { table.string('name').nullable().default('unnamed').change() })

      expect(await schema.getTables()).toContain(parents)
      expect(await db.table(children).pluck('parent_id')).toEqual([1])
      await db.table(parents).insert({ id: 2 })
      expect(await db.table(parents).orderBy('id').pluck('name')).toEqual(['first', 'unnamed'])
      expect(await db.table(audits).pluck('name')).toEqual(['first', 'unnamed'])
      await db.table(parents).where('id', 1).delete()
      expect(await db.table(children).count()).toBe(0)
    })

    it.runIf(driver === 'postgres')('renames enum checks of a table created by raw SQL with its columns and the table', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_raw_enum_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const moved = `${name}_moved`
      onTestFinished(async () => {
        await schema.dropTable(name)
        await schema.dropTable(moved)
      })
      const checkNames = async (tableName: string): Promise<string[]> => (await adapter.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = \'c\' ORDER BY conname',
        [tableName],
      )).rows.map(row => row.conname)
      await adapter.execute(`CREATE TABLE "${name}" (id integer PRIMARY KEY, status varchar(20) NOT NULL CHECK (status IN ('open', 'closed')), total integer CHECK (total > 0))`)

      await schema.table(name, table => { table.renameColumn('status', 'state') })
      expect(await checkNames(name)).toEqual([`${name}_state_check`, `${name}_total_check`])

      await schema.renameTable(name, moved)
      expect(await checkNames(moved)).toEqual([`${moved}_state_check`, `${name}_total_check`])
      await expect(db.table(moved).insert({ id: 1, state: 'lost' })).rejects.toThrow()

      await schema.table(moved, table => { table.string('state').change() })
      expect(await checkNames(moved)).toEqual([`${name}_total_check`])
      await db.table(moved).insert({ id: 1, state: 'lost' })
    })

    it.runIf(driver === 'postgres')('renames only the conventional enum check when a column has several, and keeps custom-named checks', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_many_checks_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const moved = `${name}_moved`
      onTestFinished(async () => {
        await schema.dropTable(name)
        await schema.dropTable(moved)
      })
      const checkNames = async (tableName: string): Promise<string[]> => (await adapter.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = \'c\' ORDER BY conname',
        [tableName],
      )).rows.map(row => row.conname)
      await adapter.execute(`CREATE TABLE "${name}" (
        id integer PRIMARY KEY,
        status varchar(20) NOT NULL CHECK (status IN ('open', 'closed', 'archived')) CHECK (status IN ('open', 'closed')) CONSTRAINT status_allowed CHECK (status IN ('open', 'closed'))
      )`)

      await schema.table(name, table => { table.renameColumn('status', 'state') })
      expect(await checkNames(name)).toEqual([`${name}_state_check`, `${name}_status_check1`, 'status_allowed'])

      await schema.renameTable(name, moved)
      expect(await checkNames(moved)).toEqual([`${moved}_state_check`, `${name}_status_check1`, 'status_allowed'])
      await db.table(moved).insert({ id: 1, state: 'open' })
      await expect(db.table(moved).insert({ id: 2, state: 'archived' })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('keeps enum check names when renaming a table and when a later change() rebuilds it', async () => {
      const { db } = await openDatabase(driver)
      const schema = createSchemaService(db)
      const name = `holo_kept_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const moved = `${name}_moved`
      onTestFinished(() => schema.dropTable(moved))
      await schema.createTable(name, (table) => {
        table.id()
        table.enum('status', ['open', 'closed'] as const).default('open')
        table.string('note').nullable()
      })

      await schema.renameTable(name, moved)
      await schema.table(moved, table => { table.text('note').nullable().change() })

      expect((await createSchemaReader(db).readTableStructure(moved))?.enumChecks).toEqual([
        { name: `${name}_status_check`, column: 'status', values: ['open', 'closed'] },
      ])
      await expect(db.table(moved).insert({ status: 'lost' })).rejects.toThrow()
    })

    it('restricts enum columns to their allowed values and replaces them on change()', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_enum_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      const checkDefinitions = async (tableName = name): Promise<string[]> => {
        if (driver === 'postgres') {
          const result = await adapter.query<{ conname: string, definition: string }>(
            'SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::regclass AND contype = \'c\' ORDER BY conname',
            [tableName],
          )
          return result.rows.map(row => `${row.conname}: ${row.definition}`)
        }
        if (driver === 'sqlite') {
          const result = await adapter.query<{ sql: string }>('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = ?', [name])
          return [...result.rows[0]!.sql.matchAll(/CONSTRAINT "[^"]+" CHECK \([^)]+\)\)/g)].map(match => match[0])
        }
        return []
      }
      await schema.createTable(name, table => {
        table.id()
        table.enum('status', ['active', 'disabled'] as const).default('active')
        table.enum('tier', ['free', 'pro'] as const).nullable()
      })

      await db.table(name).insert({ tier: null })
      await expect(db.table(name).insert({ status: 'banned' })).rejects.toThrow()
      await expect(db.table(name).insert({ tier: 'enterprise' })).rejects.toThrow()
      expect(await db.table(name).pluck('status')).toEqual(['active'])
      expect(await checkDefinitions()).toEqual({
        postgres: [
          `${name}_status_check: CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))`,
          `${name}_tier_check: CHECK ((tier = ANY (ARRAY['free'::text, 'pro'::text])))`,
        ],
        sqlite: [
          `CONSTRAINT "${name}_status_check" CHECK ("status" IN ('active', 'disabled'))`,
          `CONSTRAINT "${name}_tier_check" CHECK ("tier" IN ('free', 'pro'))`,
        ],
        mysql: [],
      }[driver])

      await schema.table(name, table => { table.enum('status', ['active', 'disabled', 'banned'] as const).default('active').change() })
      await db.table(name).insert({ status: 'banned' })
      await expect(schema.table(name, table => { table.enum('status', ['active'] as const).default('active').change() })).rejects.toThrow()
      await expect(db.table(name).insert({ status: 'suspended' })).rejects.toThrow()
      expect(await db.table(name).orderBy('id').pluck('status')).toEqual(['active', 'banned'])

      await schema.table(name, table => { table.renameColumn('status', 'state') })
      await schema.table(name, table => { table.enum('state', ['active', 'disabled', 'banned', 'archived'] as const).default('active').change() })
      await db.table(name).insert({ state: 'archived' })
      await expect(db.table(name).insert({ state: 'suspended' })).rejects.toThrow()
      expect(await db.table(name).orderBy('id').pluck('state')).toEqual(['active', 'banned', 'archived'])
      if (driver === 'postgres') {
        const moved = `${name}_moved`
        await schema.renameTable(name, moved)
        expect((await checkDefinitions(moved)).map(definition => definition.split(':')[0])).toEqual([`${moved}_state_check`, `${moved}_tier_check`])
        await schema.renameTable(moved, name)
        expect((await checkDefinitions()).map(definition => definition.split(':')[0])).toEqual([`${name}_state_check`, `${name}_tier_check`])
      }
    })

    it.runIf(driver === 'postgres')('replaces only enum checks, across qualified, long, and custom-schema table names', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_enum_${randomUUID().replaceAll('-', '')}`
      const customSchema = `holo_enum_schema_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const longAlpha = 'subscription_lifecycle_state_alpha'
      const longBeta = 'subscription_lifecycle_state_beta'
      onTestFinished(async () => {
        await schema.dropTable(name)
        await adapter.execute(`DROP SCHEMA IF EXISTS "${customSchema}" CASCADE`)
      })
      const checkNames = async (tableName: string): Promise<string[]> => (await adapter.query<{ conname: string }>(
        'SELECT conname FROM pg_constraint WHERE conrelid = to_regclass($1) AND contype = \'c\' ORDER BY conname',
        [tableName],
      )).rows.map(row => row.conname)
      await schema.createTable(name, table => {
        table.id()
        table.integer('amount').default(1)
        table.integer('quantity').default(0)
        table.enum('status', ['draft', 'published'] as const).default('draft')
        table.enum(longAlpha, ['on', 'off'] as const).default('on')
        table.enum(longBeta, ['on', 'off'] as const).default('on')
      })
      await adapter.execute(`ALTER TABLE "${name}" ADD CHECK (amount > 0)`)
      await adapter.execute(`ALTER TABLE "${name}" ADD CONSTRAINT "${name}_total_check" CHECK (quantity >= 0)`)

      await schema.table(name, table => { table.integer('amount').default(2).change() })
      await expect(db.table(name).insert({ amount: -1 })).rejects.toThrow()
      await schema.table(`public.${name}`, table => { table.enum('status', ['draft', 'published', 'archived'] as const).default('draft').change() })
      await schema.table(name, table => { table.enum(longBeta, ['on', 'off', 'paused'] as const).default('on').change() })
      await db.table(name).insert({ status: 'archived', [longBeta]: 'paused' })
      await expect(db.table(name).insert({ [longAlpha]: 'paused' })).rejects.toThrow()
      await schema.table(`public.${name}`, table => { table.string('status').default('draft').change() })
      await db.table(name).insert({ status: 'anything' })
      await schema.table(`public.${name}`, table => { table.enum('status', ['draft', 'archived', 'anything'] as const).default('draft').change() })
      await expect(db.table(name).insert({ status: 'other' })).rejects.toThrow()
      await schema.table(name, table => { table.string('status').default('draft').change() })
      await db.table(name).insert({ status: 'other' })
      expect(await checkNames(name)).toHaveLength(4)
      expect(await checkNames(name)).toContain(`${name}_amount_check`)
      await schema.table(name, table => { table.renameColumn('amount', 'total') })
      expect(await checkNames(name)).toEqual(expect.arrayContaining([`${name}_amount_check`, `${name}_total_check`]))

      await adapter.execute(`CREATE SCHEMA "${customSchema}"`)
      await schema.createTable(`${customSchema}.orders`, table => {
        table.id()
        table.enum('state', ['open', 'closed'] as const).default('open')
      })
      const orders = `o_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      await schema.createTable(orders, table => {
        table.id()
        table.enum('status', ['open', 'closed'] as const).default('open')
        table.enum('archive_status', ['kept', 'purged'] as const).default('kept')
      })
      await adapter.execute(`ALTER TABLE "${orders}" ADD CONSTRAINT "__holo_check_rename_0" CHECK (id > 0)`)
      await adapter.execute(`ALTER TABLE "${orders}" ADD CONSTRAINT "__holo_check_rename_1" UNIQUE (id)`)
      await schema.renameTable(orders, `${orders}_archive`)
      expect(await checkNames(`${orders}_archive`)).toEqual(['__holo_check_rename_0', `${orders}_archive_archive_status_check`, `${orders}_archive_status_check`])
      await schema.dropTable(`${orders}_archive`)

      await schema.renameTable(`${customSchema}.orders`, 'purchases')
      expect(await checkNames(`${customSchema}.purchases`)).toEqual(['purchases_state_check'])
      await schema.table(`${customSchema}.purchases`, table => { table.string('state').default('open').change() })
      expect(await checkNames(`${customSchema}.purchases`)).toEqual([])
    })

    it.runIf(driver === 'sqlite')('keeps unconstrained enum columns from older databases unchanged when another column changes', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_legacy_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'active', "tier" TEXT NOT NULL DEFAULT 'free' check (tier in ('free', 'pro')), "bio" TEXT NOT NULL DEFAULT 'CHECK (status IN (')`)
      await db.table(name).insert({ status: 'legacy' })

      await schema.table(name, table => { table.text('bio').nullable().change() })
      await db.table(name).insert({ status: 'other' })
      expect(await db.table(name).orderBy('id').pluck('status')).toEqual(['legacy', 'other'])
      await expect(db.table(name).insert({ tier: 'enterprise' })).rejects.toThrow()

      await schema.table(name, table => { table.enum('status', ['active', 'disabled', 'legacy', 'other'] as const).default('active').change() })
      await expect(db.table(name).insert({ status: 'unknown' })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('declares Laravel type names on created and added columns, and reports them when reading columns', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_types_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.boolean('active')
        table.date('born_on')
        table.datetime('seen_at')
        table.timestamp('created_at')
        table.string('title')
        table.json('settings')
      })
      await schema.table(name, table => {
        table.boolean('archived').default(false)
        table.date('expires_on').nullable()
        table.datetime('synced_at').nullable()
        table.timestamp('deleted_at').nullable()
        table.string('slug').nullable()
        table.json('meta').nullable()
      })

      const columns = Object.fromEntries((await schema.getColumns(name)).map(column => [column.name, { type: column.type, logicalType: column.logicalType }]))
      expect(columns).toMatchObject({
        active: { type: 'tinyint(1)', logicalType: 'boolean' },
        born_on: { type: 'date', logicalType: 'date' },
        seen_at: { type: 'datetime', logicalType: 'datetime' },
        created_at: { type: 'datetime', logicalType: 'datetime' },
        title: { type: 'varchar(255)', logicalType: 'string' },
        settings: { type: 'TEXT', logicalType: 'text' },
        archived: { type: 'tinyint(1)', logicalType: 'boolean' },
        expires_on: { type: 'date', logicalType: 'date' },
        synced_at: { type: 'datetime', logicalType: 'datetime' },
        deleted_at: { type: 'datetime', logicalType: 'datetime' },
        slug: { type: 'varchar(255)', logicalType: 'string' },
        meta: { type: 'TEXT', logicalType: 'text' },
      })
    })

    it.runIf(driver === 'sqlite')('round-trips booleans, dates, strings, and JSON unchanged through models and the query builder', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_values_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('id').primaryKey()
        table.boolean('active')
        table.date('born_on')
        table.datetime('seen_at')
        table.timestamp('created_at')
        table.string('code')
        table.json('settings')
      })
      const definition = defineTable(name, {
        id: column.integer().primaryKey(),
        active: column.boolean(),
        born_on: column.date(),
        seen_at: column.datetime(),
        created_at: column.timestamp(),
        code: column.string(),
        settings: column.json(),
      })
      const Record = defineModel(definition, { timestamps: false, fillable: ['id', 'active', 'born_on', 'seen_at', 'created_at', 'code', 'settings'] })
      const bornOn = new Date('1990-05-17T00:00:00.000Z')
      const seenAt = new Date('2026-03-04T05:06:07.890Z')
      const createdAt = new Date('2026-01-01T00:00:00.000Z')
      const samples = [
        { id: 1, active: true, code: '00123', settings: '42', storedSettings: '"42"' },
        { id: 2, active: false, code: '1e3', settings: 42, storedSettings: '42' },
        { id: 3, active: true, code: '0.50', settings: { zip: '02134', count: 7 }, storedSettings: '{"zip":"02134","count":7}' },
        { id: 4, active: false, code: ' 42 ', settings: [1, '1', true], storedSettings: '[1,"1",true]' },
      ]

      for (const { storedSettings: _stored, ...sample } of samples.slice(0, 2)) {
        await Record.create({ ...sample, born_on: bornOn, seen_at: seenAt, created_at: createdAt })
      }
      for (const { storedSettings: _stored, ...sample } of samples.slice(2)) {
        await db.table(definition).insert({ ...sample, born_on: bornOn, seen_at: seenAt, created_at: createdAt })
      }

      for (const sample of samples) {
        const record = await Record.findOrFail(sample.id)
        expect(Object.fromEntries((['id', 'active', 'code', 'settings', 'born_on', 'seen_at', 'created_at'] as const).map(key => [key, record.get(key)]))).toEqual({
          id: sample.id,
          active: sample.active,
          code: sample.code,
          settings: sample.settings,
          born_on: bornOn,
          seen_at: seenAt,
          created_at: createdAt,
        })
        expect(await db.table(definition).where('id', sample.id).first()).toEqual({
          id: sample.id,
          active: sample.active,
          code: sample.code,
          settings: sample.storedSettings,
          born_on: '1990-05-17 00:00:00',
          seen_at: '2026-03-04 05:06:07.890',
          created_at: '2026-01-01 00:00:00',
        })
      }
      expect(await db.table(definition).where('code', '00123').pluck('id')).toEqual([1])
      expect(await db.table(definition).where('active', true).orderBy('id').pluck('id')).toEqual([1, 3])
      expect(await db.table(definition).where('seen_at', seenAt).count()).toBe(4)
    })

    it.runIf(driver === 'sqlite')('keeps tables created with the earlier SQLite type names readable, writable, and extendable unchanged', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_earlier_${randomUUID().replaceAll('-', '')}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" ("id" INTEGER PRIMARY KEY NOT NULL, "active" INTEGER NOT NULL, "born_on" TEXT NOT NULL, "code" TEXT NOT NULL, "settings" TEXT NOT NULL)`)
      await adapter.execute(`INSERT INTO "${name}" ("id", "active", "born_on", "code", "settings") VALUES (1, 1, '1990-05-17T00:00:00.000Z', '00123', '{"zip":"02134"}')`)
      const earlierColumns = await schema.getColumns(name)

      await schema.table(name, table => { table.string('nickname').nullable() })

      const definition = defineTable(name, {
        id: column.integer().primaryKey(),
        active: column.boolean(),
        born_on: column.date(),
        code: column.string(),
        settings: column.json(),
        nickname: column.string().nullable(),
      })
      const Record = defineModel(definition, { timestamps: false, fillable: ['id', 'active', 'born_on', 'code', 'settings', 'nickname'] })
      await Record.create({ id: 2, active: false, born_on: new Date('2001-02-03T00:00:00.000Z'), code: '1e3', settings: '7', nickname: '007' })

      expect((await schema.getColumns(name)).filter(column => column.name !== 'nickname')).toEqual(earlierColumns)
      expect(Object.fromEntries((['active', 'born_on', 'code', 'settings'] as const).map(key => [key, (earlierColumns.find(column => column.name === key))?.logicalType]))).toEqual({
        active: 'integer',
        born_on: 'text',
        code: 'text',
        settings: 'text',
      })
      const first = await Record.findOrFail(1)
      expect([first.get('active'), first.get('born_on'), first.get('code'), first.get('settings')]).toEqual([true, new Date('1990-05-17T00:00:00.000Z'), '00123', { zip: '02134' }])
      expect(await db.table(definition).where('id', 2).first()).toEqual({ id: 2, active: false, born_on: '2001-02-03 00:00:00', code: '1e3', settings: '"7"', nickname: '007' })
    })

    it.runIf(driver === 'mysql')('keeps enum values of a table renamed out of another database', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const tenant = `holo_tenant_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const purchases = `holo_purchases_${randomUUID().replaceAll('-', '')}`
      onTestFinished(async () => {
        await schema.dropTable(purchases)
        await adapter.execute(`DROP DATABASE IF EXISTS \`${tenant}\``)
      })
      await adapter.execute(`CREATE DATABASE \`${tenant}\``)
      await schema.createTable(`${tenant}.orders`, table => {
        table.id()
        table.enum('state', ['open', 'closed'] as const).default('open')
      })

      await schema.renameTable(`${tenant}.orders`, purchases)

      expect(await schema.hasTable(purchases)).toBe(true)
      expect((await createSchemaReader(db).readTable(purchases))?.columns.state?.enumValues).toEqual(['open', 'closed'])
      await expect(db.table(purchases).insert({ state: 'lost' })).rejects.toThrow()
    })

    it('creates and drops indexes and preserves index names across column renames', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const index = `${name}_name_unique`
      await schema.table(name, table => { table.unique(['name'], index) })
      await db.table(table).insert({ id: 1, name: 'Unique' })
      await expect(db.table(table).insert({ id: 2, name: 'Unique' })).rejects.toThrow()
      await schema.table(name, table => { table.renameColumn('name', 'title') })
      expect(await schema.getIndexes(name)).toEqual(expect.arrayContaining([expect.objectContaining({ name: index, columns: ['title'], unique: true })]))
      await schema.table(name, table => { table.dropIndex(index) })
      await db.table(name).insert({ id: 2, title: 'Unique' })
      expect(await db.table(name).count()).toBe(2)
    })

    it('preserves unique enforcement when renaming an index', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const original = `${name}_original`
      const renamed = `${name}_renamed`
      await schema.table(name, table => { table.unique(['name'], original) })
      await db.table(table).insert({ id: 1, name: 'Unique' })
      await schema.table(name, table => { table.renameIndex(original, renamed) })
      const indexes = await schema.getIndexes(name)
      expect(indexes).toEqual(expect.arrayContaining([expect.objectContaining({ name: renamed, columns: ['name'], unique: true })]))
      expect(indexes.map(index => index.name)).not.toContain(original)
      await expect(db.table(table).insert({ id: 2, name: 'Unique' })).rejects.toThrow()
      expect(await db.table(table).count()).toBe(1)
    })

    it('raises when renaming an index to a taken name and keeps both indexes', async () => {
      const { schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const original = `${name}_original`
      const taken = `${name}_taken`
      await schema.table(name, table => {
        table.unique(['name'], original)
        table.index(['active', 'name'], taken)
      })
      const before = await schema.getIndexes(name)

      await expect(schema.table(name, table => { table.renameIndex(original, taken) })).rejects.toThrow()

      expect(await schema.getIndexes(name)).toEqual(before)
    })

    it('raises when renaming a missing index', async () => {
      const { schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      const before = await schema.getIndexes(name)

      await expect(schema.table(name, table => { table.renameIndex(`${name}_missing`, `${name}_renamed`) })).rejects.toThrow()

      expect(await schema.getIndexes(name)).toEqual(before)
    })

    it('raises when dropIndex() names an index that does not exist and keeps the existing indexes', async () => {
      const { schema, table } = await openDatabase(driver)
      const name = table.tableName.split('.').at(-1)!
      await schema.table(name, table => { table.index(['name']) })
      const before = await schema.getIndexes(name)

      await expect(schema.table(name, table => { table.dropIndex(`${name}_missing_index`) })).rejects.toThrow()

      expect(await schema.getIndexes(name)).toEqual(before)
      expect(before.map(index => index.name)).toContain(`${name}_name_index`)
    })

    it('drops conventional indexes by their columns, including a morphs index', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_ic_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('a')
        table.string('b')
        table.morphs('taggable')
        table.index(['a', 'b'])
      })
      expect((await schema.getIndexes(name)).map(index => index.name)).toEqual(expect.arrayContaining([
        `${name}_a_b_index`,
        `${name}_taggable_type_taggable_id_index`,
      ]))

      await schema.table(name, table => {
        table.dropIndex(['a', 'b'])
        table.dropIndex(['taggable_type', 'taggable_id'])
      })

      expect((await schema.getIndexes(name)).filter(index => !index.columns.includes('id'))).toEqual([])
    })

    it('drops an index by its original name after the table is renamed and raises for the new table name', async () => {
      const { schema } = await openDatabase(driver)
      const original = `holo_index_ren_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const renamed = `${original}_new`
      onTestFinished(() => schema.dropTable(renamed))
      await schema.createTable(original, table => {
        table.id()
        table.string('email').index()
      })
      await schema.renameTable(original, renamed)

      await expect(schema.table(renamed, table => { table.dropIndex(`${renamed}_email_index`) })).rejects.toThrow()
      expect((await schema.getIndexes(renamed)).map(index => index.name)).toContain(`${original}_email_index`)

      await schema.table(renamed, table => { table.dropIndex(`${original}_email_index`) })

      expect((await schema.getIndexes(renamed)).filter(index => index.columns.includes('email'))).toEqual([])
    })

    it.runIf(driver === 'postgres')('renames and drops indexes of a table in a schema outside the search path', async () => {
      const tenant = `holo_tenant_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      const { db, schema } = await openDatabase(driver)
      onTestFinished(async () => { await db.executeCompiled({ sql: `DROP SCHEMA IF EXISTS "${tenant}" CASCADE`, source: 'schema' }) })
      await db.executeCompiled({ sql: `CREATE SCHEMA "${tenant}"`, source: 'schema' })
      const posts = `${tenant}.posts`
      await schema.createTable(posts, table => {
        table.id()
        table.string('title')
        table.string('slug')
        table.index(['title'])
        table.index(['slug'])
      })
      const indexNames = async () => (await createSchemaReader(db).readTableStructure(posts))!.indexes
        .filter(index => !index.primary)
        .map(index => index.name)
        .sort()
      expect(await indexNames()).toEqual([`${tenant}_posts_slug_index`, `${tenant}_posts_title_index`])

      await schema.table(posts, table => { table.renameIndex(`${tenant}_posts_title_index`, 'posts_title_lookup') })
      expect(await indexNames()).toEqual([`${tenant}_posts_slug_index`, 'posts_title_lookup'])

      await schema.table(posts, table => {
        table.dropIndex('posts_title_lookup')
        table.dropIndex(['slug'])
      })
      expect(await indexNames()).toEqual([])
    })

    it.runIf(driver === 'postgres')('raises when dropIndex() names the constraint of a unique column and keeps it enforced', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_index_uniq_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('email').unique()
      })

      await expect(schema.table(name, table => { table.dropIndex(`${name}_email_unique`) })).rejects.toThrow()

      await db.table(name).insert({ email: 'same@example.com' })
      await expect(db.table(name).insert({ email: 'same@example.com' })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('keeps the collation and sort order of a unique index when renaming it', async () => {
      const { db, schema, table, adapter } = await openDatabase(driver)
      const name = table.tableName
      const original = `${name}_name_nocase`
      const renamed = `${name}_name_renamed`
      await adapter.execute(`CREATE UNIQUE INDEX "${original}" ON "${name}" ("name" COLLATE NOCASE DESC)`)
      await db.table(table).insert({ id: 1, name: 'Hello' })

      await schema.table(name, table => { table.renameIndex(original, renamed) })

      expect((await schema.getIndexes(name)).map(index => index.name)).toEqual([renamed])
      await expect(db.table(table).insert({ id: 2, name: 'hello' })).rejects.toThrow()
      expect(await db.table(table).count()).toBe(1)
    })

    it.runIf(driver === 'sqlite')('refuses to rename a partial index instead of recreating it without its condition', async () => {
      const { db, schema, table, adapter } = await openDatabase(driver)
      const name = table.tableName
      const partial = `${name}_active_names`
      await adapter.execute(`CREATE UNIQUE INDEX "${partial}" ON "${name}" ("name") WHERE "active" = 1`)

      await expect(schema.table(name, table => { table.renameIndex(partial, `${name}_renamed`) })).rejects.toThrow(SchemaError)

      expect((await schema.getIndexes(name)).map(index => index.name)).toEqual([partial])
      await db.table(table).insert([{ id: 1, name: 'Same', active: false }, { id: 2, name: 'Same', active: false }])
      await expect(db.table(table).insert({ id: 3, name: 'Same', active: true })).resolves.toBeDefined()
      await expect(db.table(table).insert({ id: 4, name: 'Same', active: true })).rejects.toThrow()
    })

    it('renames a foreign key column and keeps the key enforcing', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_fk_rename_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(child))
      await db.table(table).insert({ id: 1, name: 'Parent' })
      await schema.createTable(child, table => {
        table.id()
        table.integer('parent_id')
        table.foreign('parent_id').references('id').on(parent)
      })
      await db.table(child).insert({ parent_id: 1 })

      await schema.table(child, table => { table.renameColumn('parent_id', 'owner_id') })

      expect(await db.table(child).pluck('owner_id')).toEqual([1])
      expect(await schema.getForeignKeys(child)).toEqual([expect.objectContaining({ from: 'owner_id', to: 'id' })])
      await expect(db.table(child).insert({ owner_id: 99 })).rejects.toThrow()
    })

    it('drops plain and enum columns and keeps the remaining records', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_drop_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('name')
        table.string('nickname').nullable()
        table.enum('status', ['open', 'closed'] as const).default('open')
      })
      await db.table(name).insert({ name: 'Kept', nickname: 'k', status: 'closed' })

      await schema.table(name, table => {
        table.dropColumn('nickname')
        table.dropColumn('status')
      })

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'name'])
      expect(await db.table(name).pluck('name')).toEqual(['Kept'])
      await db.table(name).insert({ name: 'Added' })
      expect(await db.table(name).count()).toBe(2)
    })

    it('drops every column named in a dropColumn() list and keeps the remaining records', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_drop_list_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('name')
        table.string('a').nullable()
        table.string('b').nullable()
      })
      await db.table(name).insert({ name: 'Kept', a: 'x', b: 'y' })

      await schema.table(name, table => { table.dropColumn(['a', 'b']) })

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'name'])
      expect(await db.table(name).pluck('name')).toEqual(['Kept'])
    })

    it('drops the morph columns and their index with dropMorphs()', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_dm_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('name')
        table.morphs('taggable')
        table.morphs('owner', `${name}_owner_lookup`)
      })
      await db.table(name).insert({ name: 'Kept', taggable_type: 'post', taggable_id: 1, owner_type: 'user', owner_id: 2 })

      await schema.table(name, table => {
        table.dropMorphs('taggable')
        table.dropMorphs('owner', `${name}_owner_lookup`)
      })

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'name'])
      expect((await schema.getIndexes(name)).filter(index => !index.columns.includes('id'))).toEqual([])
      expect(await db.table(name).pluck('name')).toEqual(['Kept'])
    })

    it('raises when dropMorphs() finds no morph index and keeps the morph columns', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_dm_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.morphs('taggable')
      })
      await schema.table(name, table => { table.dropIndex(['taggable_type', 'taggable_id']) })

      await expect(schema.table(name, table => { table.dropMorphs('taggable') })).rejects.toThrow()

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'taggable_type', 'taggable_id'])
    })

    it('drops the timestamp and soft-delete columns with dropTimestamps() and dropSoftDeletes()', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_drop_ts_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('name')
        table.timestamps()
        table.softDeletes()
        table.softDeletes('archived_at')
      })
      await db.table(name).insert({ name: 'Kept' })

      await schema.table(name, table => {
        table.dropTimestamps()
        table.dropSoftDeletes()
        table.dropSoftDeletes('archived_at')
      })

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'name'])
      expect(await db.table(name).pluck('name')).toEqual(['Kept'])
    })

    it('adds timestamp and soft-delete columns in table() with the same definitions as createTable()', async () => {
      const { schema } = await openDatabase(driver)
      const created = `holo_ts_created_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const altered = `holo_ts_altered_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      onTestFinished(async () => {
        await schema.dropTable(created)
        await schema.dropTable(altered)
      })
      await schema.createTable(created, table => {
        table.id()
        table.timestamps()
        table.softDeletes()
        table.softDeletes('archived_at')
      })
      await schema.createTable(altered, table => { table.id() })

      await schema.table(altered, table => {
        table.timestamps().softDeletes().softDeletes('archived_at')
      })

      expect(await schema.getColumns(altered)).toEqual(await schema.getColumns(created))
    })

    it.runIf(driver === 'sqlite')('raises SQLite\'s error when dropping an indexed column and leaves the table unchanged', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const name = table.tableName
      const index = `${name}_name_index`
      await schema.table(name, table => { table.index(['name'], index) })
      await db.table(table).insert({ id: 1, name: 'Indexed' })
      const reader = createSchemaReader(db)
      const before = await reader.readTableStructure(name)

      await expect(schema.table(name, table => { table.dropColumn('name') })).rejects.toThrow(`error in index ${index} after drop column: no such column`)

      expect(await reader.readTableStructure(name)).toEqual(before)
      expect(await db.table(table).pluck('name')).toEqual(['Indexed'])
    })

    it('names unique columns {table}_{column}_unique and drops them by name or by columns', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_unique_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('owner_email').nullable().unique()
        table.string('label').nullable()
      })
      await schema.table(name, table => { table.string('slug').nullable().unique() })
      await schema.table(name, table => { table.text('label').nullable().change() })
      await db.table(name).insert({ owner_email: 'owner@example.com', slug: 'one' })
      await expect(db.table(name).insert({ owner_email: 'owner@example.com' })).rejects.toThrow()
      await expect(db.table(name).insert({ slug: 'one' })).rejects.toThrow()
      expect((await schema.getIndexes(name)).filter(index => index.unique).map(index => [index.name, index.columns])).toEqual(expect.arrayContaining([
        [`${name}_owner_email_unique`, ['owner_email']],
        [`${name}_slug_unique`, ['slug']],
      ]))

      await schema.table(name, table => {
        table.dropUnique(`${name}_owner_email_unique`)
        table.dropUnique(['slug'])
      })

      await db.table(name).insert({ owner_email: 'owner@example.com', slug: 'one' })
      expect(await db.table(name).count()).toBe(2)
      expect((await schema.getIndexes(name)).filter(index => index.unique && !index.columns.includes('id'))).toEqual([])
    })

    it('raises when dropUnique() names a unique that does not exist', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_unique_missing_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('email')
      })

      await expect(schema.table(name, table => { table.dropUnique(`${name}_missing_unique`) })).rejects.toThrow()
      await expect(schema.table(name, table => { table.dropUnique(['email']) })).rejects.toThrow()
    })

    it.skipIf(driver === 'sqlite')('drops unique constraints created inline by earlier releases by their database name', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_unique_legacy_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const legacyName = driver === 'postgres' ? `${name}_owner_email_key` : 'owner_email'
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE ${db.getDialect().quoteIdentifier(name)} (id INTEGER PRIMARY KEY, owner_email VARCHAR(255) UNIQUE)`)
      await db.table(name).insert({ id: 1, owner_email: 'owner@example.com' })
      await expect(db.table(name).insert({ id: 2, owner_email: 'owner@example.com' })).rejects.toThrow()

      await schema.table(name, table => { table.dropUnique(legacyName) })

      await db.table(name).insert({ id: 2, owner_email: 'owner@example.com' })
      expect(await db.table(name).count()).toBe(2)
    })

    it('creates unique columns that a self-referencing foreign key depends on', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_unique_self_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('code').unique()
        table.unique(['code'])
        table.string('parent_code').nullable()
        table.foreign('parent_code').references('code').on(name)
      })
      await db.table(name).insert({ code: 'root' })
      await expect(db.table(name).insert({ code: 'root' })).rejects.toThrow()
      await db.table(name).insert({ code: 'child', parent_code: 'root' })
      await expect(db.table(name).insert({ code: 'orphan', parent_code: 'missing' })).rejects.toThrow()
      expect(await db.table(name).count()).toBe(2)
    })

    it('leaves the table unchanged when a new unique column cannot be indexed', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_unique_add_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('name')
      })
      await db.table(name).insert({ name: 'first' })
      await db.table(name).insert({ name: 'second' })

      await expect(schema.table(name, table => { table.string('slug').default('same').unique() })).rejects.toThrow()

      expect((await schema.getColumns(name)).map(column => column.name)).toEqual(['id', 'name'])
      expect(await db.table(name).orderBy('id').pluck('name')).toEqual(['first', 'second'])
    })

    it('rejects a declared index that reuses a unique column index name for other columns', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_unique_clash_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await expect(schema.createTable(name, table => {
        table.id()
        table.string('email').unique()
        table.string('other')
        table.index(['other'], `${name}_email_unique`)
      })).rejects.toThrow(SchemaError)
      expect(await schema.hasTable(name)).toBe(false)
    })

    it.skipIf(driver === 'mysql')('fails a unique column whose generated name belongs to another table, creating nothing', async () => {
      const { db, schema } = await openDatabase(driver)
      const prefix = `holo_uq_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      onTestFinished(async () => {
        await schema.dropTable(prefix)
        await schema.dropTable(`${prefix}_b`)
      })
      await schema.createTable(`${prefix}_b`, table => { table.string('c').unique() })

      await expect(schema.createTable(prefix, table => {
        table.string('b_c').unique()
      })).rejects.toThrow()

      expect(await schema.hasTable(prefix)).toBe(false)
      await db.table(`${prefix}_b`).insert({ c: 'same' })
      await expect(db.table(`${prefix}_b`).insert({ c: 'same' })).rejects.toThrow()
    })

    it('creates the same table with unique columns again without failing', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_unique_again_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      const create = () => schema.createTable(name, table => {
        table.id()
        table.string('email').unique()
      })
      await create()

      await create()

      await db.table(name).insert({ email: 'same@example.com' })
      await expect(db.table(name).insert({ email: 'same@example.com' })).rejects.toThrow()
    })

    it('creates the same table with every kind of declared index again without failing', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_ix_again_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      onTestFinished(() => schema.dropTable(name))
      const create = () => schema.createTable(name, table => {
        table.id()
        table.string('email')
        table.string('slug').index()
        table.integer('rank')
        table.morphs('taggable')
        table.unique(['email'])
        table.index(['rank'])
      })
      await create()

      await create()

      await db.table(name).insert({ email: 'same@example.com', slug: 'a', rank: 1, taggable_type: 'post', taggable_id: 1 })
      await expect(db.table(name).insert({ email: 'same@example.com', slug: 'b', rank: 2, taggable_type: 'post', taggable_id: 2 })).rejects.toThrow()
      expect((await schema.getIndexes(name)).map(index => [index.columns, index.unique])).toEqual(expect.arrayContaining([
        [['email'], true],
        [['slug'], false],
        [['rank'], false],
        [['taggable_type', 'taggable_id'], false],
      ]))
    })

    it('fails to create an existing table again when its index of the declared name has other columns', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_ix_shape_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const indexName = `${name}_lookup`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.integer('rank')
        table.integer('score')
        table.index(['rank'], indexName)
      })

      await expect(schema.createTable(name, table => {
        table.id()
        table.integer('rank')
        table.integer('score')
        table.unique(['score'], indexName)
      })).rejects.toThrow(SchemaError)

      expect((await schema.getIndexes(name)).find(index => index.name === indexName)).toMatchObject({ columns: ['rank'], unique: false })
    })

    it.skipIf(driver === 'mysql')('fails to create a table whose declared index name another table owns, creating nothing', async () => {
      const { db, schema } = await openDatabase(driver)
      const original = `holo_ix_own_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const renamed = `${original}_old`
      onTestFinished(async () => {
        await schema.dropTable(original)
        await schema.dropTable(renamed)
      })
      const create = () => schema.createTable(original, table => {
        table.id()
        table.string('email')
        table.integer('rank')
        table.unique(['email'])
        table.index(['rank'])
      })
      await create()
      await schema.renameTable(original, renamed)

      await expect(create()).rejects.toThrow(/already exists/)

      expect(await schema.hasTable(original)).toBe(false)
      await db.table(renamed).insert({ email: 'same@example.com', rank: 1 })
      await expect(db.table(renamed).insert({ email: 'same@example.com', rank: 1 })).rejects.toThrow()
    })

    it.skipIf(driver === 'mysql')('fails to create a table whose plain index name another table owns, creating nothing', async () => {
      const { schema } = await openDatabase(driver)
      const original = `holo_ix_plain_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const renamed = `${original}_old`
      onTestFinished(async () => {
        await schema.dropTable(original)
        await schema.dropTable(renamed)
      })
      const create = () => schema.createTable(original, table => {
        table.id()
        table.integer('rank').index()
      })
      await create()
      await schema.renameTable(original, renamed)

      await expect(create()).rejects.toThrow(/already exists/)

      expect(await schema.hasTable(original)).toBe(false)
    })

    it('fails to add an index in schema.table() whose name another table owns', async () => {
      const { db, schema } = await openDatabase(driver)
      const prefix = `holo_ix_add_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const owner = `${prefix}_owner`
      const target = `${prefix}_target`
      const indexName = `${prefix}_email_unique`
      onTestFinished(async () => {
        await schema.dropTable(owner)
        await schema.dropTable(target)
      })
      await schema.createTable(owner, table => {
        table.id()
        table.string('email')
        table.unique(['email'], indexName)
      })
      await schema.createTable(target, table => {
        table.id()
        table.string('email')
        table.integer('rank')
      })

      const addIndexes = schema.table(target, table => {
        table.unique(['email'], indexName)
      })

      if (driver === 'mysql') {
        await addIndexes
        await db.table(target).insert({ email: 'same@example.com', rank: 1 })
        await expect(db.table(target).insert({ email: 'same@example.com', rank: 2 })).rejects.toThrow()
        return
      }
      await expect(addIndexes).rejects.toThrow()
      await expect(schema.table(target, table => { table.index(['rank'], indexName) })).rejects.toThrow()
      await expect(schema.table(target, table => { table.integer('position').nullable().index(indexName) })).rejects.toThrow()
      await expect(schema.table(target, table => { table.nullableMorphs('taggable', indexName) })).rejects.toThrow()
      expect((await schema.getIndexes(target)).map(index => index.name)).not.toContain(indexName)
      await db.table(target).insert({ email: 'same@example.com', rank: 1 })
      await db.table(target).insert({ email: 'same@example.com', rank: 1 })
      expect(await db.table(target).count()).toBe(2)
    })

    it('shortens long unique column names and still drops them by columns', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_unique_long_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const longColumn = 'organizer_primary_contact_email_address'
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string(longColumn).nullable().unique()
      })
      await db.table(name).insert({ [longColumn]: 'owner@example.com' })
      await expect(db.table(name).insert({ [longColumn]: 'owner@example.com' })).rejects.toThrow()
      const [index] = (await schema.getIndexes(name)).filter(index => index.columns.includes(longColumn))
      expect(index?.name).toMatch(/^holo_unique_long_\w+_[0-9a-f]{8}_unique$/)
      expect(index?.name).toHaveLength(63)

      await schema.table(name, table => { table.dropUnique([longColumn]) })

      await db.table(name).insert({ [longColumn]: 'owner@example.com' })
      expect(await db.table(name).count()).toBe(2)
    })

    it('drops a unique by its existing name after the table is renamed, and a later change() keeps it dropped', async () => {
      const { db, schema } = await openDatabase(driver)
      const original = `holo_unique_ren_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const renamed = `${original}_new`
      onTestFinished(() => schema.dropTable(renamed))
      await schema.createTable(original, table => {
        table.id()
        table.string('email').unique()
        table.string('label').nullable()
      })
      await schema.renameTable(original, renamed)

      await schema.table(renamed, table => { table.dropUnique(`${original}_email_unique`) })
      await schema.table(renamed, table => { table.text('label').nullable().change() })

      await db.table(renamed).insert({ email: 'same@example.com' })
      await db.table(renamed).insert({ email: 'same@example.com' })
      expect(await db.table(renamed).count()).toBe(2)
    })

    it.runIf(driver === 'sqlite')('keeps an inline unique column from an earlier release unique when that column changes', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_unique_inline_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" (id INTEGER PRIMARY KEY, owner_email VARCHAR(255) UNIQUE)`)

      await schema.table(name, table => { table.text('owner_email').nullable().change() })

      await db.table(name).insert({ id: 1, owner_email: 'owner@example.com' })
      await expect(db.table(name).insert({ id: 2, owner_email: 'owner@example.com' })).rejects.toThrow()
      expect((await schema.getColumns(name)).find(column => column.name === 'owner_email')?.type).toBe('TEXT')
    })

    it('adds and removes foreign-key enforcement on an existing table', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_fk_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const constraint = `${child}_parent`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => { table.id(); table.integer('parent_id') })
      await schema.table(child, table => { table.foreign('parent_id', constraint).references('id').on(parent) })
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      await db.table(table).insert({ id: 1, name: 'Parent' })
      await db.table(child).insert({ parent_id: 1 })
      await expect(schema.table(child, table => { table.dropForeign(`${child}_missing`) })).rejects.toThrow()
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      await schema.table(child, table => { table.dropForeign(constraint) })
      await db.table(child).insert({ parent_id: 99 })
      expect(await db.table(child).orderBy('id').pluck('parent_id')).toEqual([1, 99])
      expect(await schema.getForeignKeys(child)).toEqual([])
    })

    it('drops foreign keys declared inline by createTable and added columns using their conventional names', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parent = `holo_fk_parent_${suffix}`
      const child = `holo_fk_child_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(child)
        await schema.dropTable(parent)
      })
      await schema.createTable(parent, table => { table.id() })
      await schema.createTable(child, table => {
        table.id()
        table.foreignId('created_by_id').nullable().constrained(parent).restrictOnDelete()
      })
      await schema.table(child, table => {
        table.foreignId('updated_by_id').nullable().constrained(parent)
      })
      await expect(db.table(child).insert({ created_by_id: 99 })).rejects.toThrow()
      await expect(db.table(child).insert({ updated_by_id: 99 })).rejects.toThrow()

      await schema.table(child, table => {
        table.dropForeign(`${child}_created_by_id_foreign`)
        table.dropForeign(`${child}_updated_by_id_foreign`)
      })

      await db.table(child).insert({ created_by_id: 99, updated_by_id: 99 })
      expect(await schema.getForeignKeys(child)).toEqual([])
    })

    it('drops conventional foreign keys by their columns and raises when the key is missing', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parent = `holo_fk_parent_${suffix}`
      const child = `holo_fk_child_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(child)
        await schema.dropTable(parent)
      })
      await schema.createTable(parent, table => { table.id() })
      await schema.createTable(child, table => {
        table.id()
        table.foreignId('created_by_id').nullable().constrained(parent)
      })
      await schema.table(child, table => {
        table.foreignId('updated_by_id').nullable().constrained(parent)
      })

      await schema.table(child, table => {
        table.dropForeign(['created_by_id'])
        table.dropForeign(['updated_by_id'])
      })

      await db.table(child).insert({ created_by_id: 99, updated_by_id: 99 })
      expect(await schema.getForeignKeys(child)).toEqual([])
      await expect(schema.table(child, table => { table.dropForeign(['created_by_id']) })).rejects.toThrow()
    })

    it('runs the same column-form drop migration on a database named by an earlier release and on a fresh one', async () => {
      const { db, schema, adapter, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const suffix = randomUUID().replaceAll('-', '').slice(0, 16)
      const legacy = `holo_cover_legacy_${suffix}`
      const fresh = `holo_cover_fresh_${suffix}`
      const quote = (identifier: string) => db.getDialect().quoteIdentifier(identifier)
      onTestFinished(async () => {
        await schema.dropTable(legacy)
        await schema.dropTable(fresh)
      })
      await adapter.execute(`CREATE TABLE ${quote(legacy)} (id INTEGER PRIMARY KEY, slug VARCHAR(255) UNIQUE, category_id INTEGER, FOREIGN KEY (category_id) REFERENCES ${quote(parent)} (id))`)
      await schema.createTable(fresh, (table) => {
        table.integer('id').primaryKey()
        table.string('slug').unique()
        table.integer('category_id').nullable()
        table.foreign('category_id').references('id').on(parent)
      })
      const legacyUniqueName = { sqlite: `sqlite_autoindex_${legacy}_1`, postgres: `${legacy}_slug_key`, mysql: 'slug' }[driver]
      const legacyForeignKeyName = { sqlite: undefined, postgres: `${legacy}_category_id_fkey`, mysql: `${legacy}_ibfk_1` }[driver]
      expect((await schema.getIndexes(legacy)).find(index => index.columns.includes('slug'))?.name).toBe(legacyUniqueName)
      expect((await createSchemaReader(db).readTableStructure(legacy))?.foreignKeys[0]?.name).toBe(legacyForeignKeyName)

      for (const name of [legacy, fresh]) {
        await schema.table(name, (table) => {
          table.dropUnique(['slug'])
          table.dropForeign(['category_id'])
        })

        await db.table(name).insert([{ id: 1, slug: 'same', category_id: 999 }, { id: 2, slug: 'same', category_id: 999 }])
        expect(await db.table(name).count()).toBe(2)
        expect(await schema.getForeignKeys(name)).toEqual([])
        expect((await schema.getIndexes(name)).filter(index => index.unique && index.columns.includes('slug'))).toEqual([])
      }
    })

    it('drops a constrained foreign id and a morph index under the names an earlier release gave them', async () => {
      const { db, schema, adapter, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const legacy = `holo_cover_legacy_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      const quote = (identifier: string) => db.getDialect().quoteIdentifier(identifier)
      onTestFinished(() => schema.dropTable(legacy))
      await adapter.execute(`CREATE TABLE ${quote(legacy)} (id INTEGER PRIMARY KEY, category_id INTEGER, taggable_type VARCHAR(255), taggable_id INTEGER, FOREIGN KEY (category_id) REFERENCES ${quote(parent)} (id))`)
      await adapter.execute(`CREATE INDEX ${quote(`${legacy}_morph_lookup`)} ON ${quote(legacy)} (taggable_type, taggable_id)`)

      await schema.table(legacy, (table) => {
        table.dropConstrainedForeignId('category_id')
        table.dropMorphs('taggable')
      })

      expect((await schema.getColumns(legacy)).map(column => column.name)).toEqual(['id'])
      expect(await schema.getForeignKeys(legacy)).toEqual([])
      expect((await schema.getIndexes(legacy)).filter(index => !index.columns.includes('id'))).toEqual([])
    })

    it('refuses a column-form drop that more than one index or foreign key covers and names the candidates', async () => {
      const { schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const name = `holo_cover_twice_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.integer('id').primaryKey()
        table.string('email')
        table.integer('parent_id')
        table.string('label')
        table.unique(['email'], `${name}_email_first`)
        table.unique(['email'], `${name}_email_second`)
        table.index(['label'], `${name}_label_first`)
        table.index(['label'], `${name}_label_second`)
        table.foreign('parent_id', `${name}_parent_first`).references('id').on(parent)
      })
      await schema.table(name, (table) => { table.foreign('parent_id', `${name}_parent_second`).references('id').on(parent) })

      await expect(schema.table(name, (table) => { table.dropUnique(['email']) }))
        .rejects.toThrow(`Table "${name}" has more than one unique index on columns "email": "${name}_email_first", "${name}_email_second". Drop one by name.`)
      await expect(schema.table(name, (table) => { table.dropIndex(['label']) }))
        .rejects.toThrow(`Table "${name}" has more than one index on columns "label": "${name}_label_first", "${name}_label_second". Drop one by name.`)
      await expect(schema.table(name, (table) => { table.dropForeign(['parent_id']) }))
        .rejects.toThrow(`Table "${name}" has more than one foreign key on columns "parent_id": "${name}_parent_first", "${name}_parent_second". Drop one by name.`)
      expect((await schema.getIndexes(name)).map(index => index.name)).toEqual(expect.arrayContaining([`${name}_email_first`, `${name}_email_second`, `${name}_label_first`, `${name}_label_second`]))
      expect(await schema.getForeignKeys(name)).toHaveLength(2)
    })

    it('refuses a column-form drop that no index or foreign key covers exactly', async () => {
      const { schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const name = `holo_cover_none_${randomUUID().replaceAll('-', '').slice(0, 16)}`
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, (table) => {
        table.integer('id').primaryKey()
        table.string('email')
        table.integer('tenant_id')
        table.index(['email'])
        table.unique(['tenant_id', 'email'])
        table.foreign('tenant_id').references('id').on(parent)
      })

      await expect(schema.table(name, (table) => { table.dropUnique(['email']) }))
        .rejects.toThrow(`Table "${name}" has no unique index on columns "email".`)
      await expect(schema.table(name, (table) => { table.dropIndex(['tenant_id']) }))
        .rejects.toThrow(`Table "${name}" has no index on columns "tenant_id".`)
      await expect(schema.table(name, (table) => { table.dropForeign(['email']) }))
        .rejects.toThrow(`Table "${name}" has no foreign key on columns "email".`)
      expect(await schema.getForeignKeys(name)).toHaveLength(1)
    })

    it('drops a legacy PostgreSQL foreign key by its database-assigned name', async () => {
      if (driver !== 'postgres') {
        return
      }
      const { db, schema } = await openDatabase(driver, { security: { allowUnsafeRawSql: true } })
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parent = `holo_fk_parent_${suffix}`
      const child = `holo_fk_child_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(child)
        await schema.dropTable(parent)
      })
      await schema.createTable(parent, table => { table.id() })
      await db.unsafeExecute(unsafeSql(`CREATE TABLE "${child}" ("id" serial PRIMARY KEY, "created_by_id" integer REFERENCES "${parent}" ("id"))`))
      await expect(db.table(child).insert({ created_by_id: 99 })).rejects.toThrow()

      await schema.table(child, table => { table.dropForeign(`${child}_created_by_id_fkey`) })

      await db.table(child).insert({ created_by_id: 99 })
      expect(await schema.getForeignKeys(child)).toEqual([])
    })

    it('drops a constrained foreign id column together with its key', async () => {
      const { db, schema } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parent = `holo_fk_parent_${suffix}`
      const child = `holo_fk_child_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(child)
        await schema.dropTable(parent)
      })
      await schema.createTable(parent, table => { table.id() })
      await schema.createTable(child, table => {
        table.id()
        table.string('name').nullable()
        table.foreignId('created_by_id').nullable().constrained(parent)
      })
      if (driver === 'mysql') {
        await expect(schema.table(child, table => { table.dropColumn('created_by_id') })).rejects.toThrow()
      }

      await schema.table(child, table => { table.dropConstrainedForeignId('created_by_id') })

      expect((await schema.getColumns(child)).map(column => column.name)).not.toContain('created_by_id')
      expect(await schema.getForeignKeys(child)).toEqual([])
      await db.table(child).insert({ name: 'Unconstrained' })
      expect(await db.table(child).pluck('name')).toEqual(['Unconstrained'])
    })

    it.runIf(driver === 'sqlite')('adds and drops a foreign key by rebuilding the table, keeping its columns, indexes, triggers, other keys and the rows of its children', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const members = `holo_members_${suffix}`
      const notes = `holo_notes_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(notes)
        await schema.dropTable(members)
        await schema.dropTable(parents)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${members}" (
        "id" INTEGER PRIMARY KEY AUTOINCREMENT,
        "parent_id" INTEGER,
        "owner_id" INTEGER CONSTRAINT "members_owner" REFERENCES "${parents}" ("id") ON DELETE CASCADE ON UPDATE RESTRICT,
        "email" TEXT NOT NULL UNIQUE,
        "status" TEXT NOT NULL DEFAULT 'active' CONSTRAINT "members_status_check" CHECK ("status" IN ('active', 'banned')),
        "visits" INTEGER NOT NULL DEFAULT 0
      )`)
      await adapter.execute(`CREATE INDEX "members_visits_index" ON "${members}" ("visits")`)
      await adapter.execute(`CREATE TRIGGER "members_count_visit" AFTER INSERT ON "${members}" BEGIN UPDATE "${members}" SET "visits" = "visits" + 1 WHERE "id" = NEW."id"; END`)
      await adapter.execute(`CREATE TABLE "${notes}" ("id" INTEGER PRIMARY KEY, "member_id" INTEGER NOT NULL REFERENCES "${members}" ("id") ON DELETE CASCADE)`)
      await db.table(parents).insert([{ id: 1 }, { id: 2 }])
      await db.table(members).insert({ parent_id: 1, owner_id: 2, email: 'a@example.com' })
      await db.table(notes).insert([{ id: 1, member_id: 1 }, { id: 2, member_id: 1 }])
      const reader = createSchemaReader(db)
      const before = (await reader.readTableStructure(members))!

      await schema.table(members, table => { table.foreign('parent_id').references('id').on(parents).cascadeOnDelete() })

      const added = (await reader.readTableStructure(members))!
      expect(added.columns).toEqual(before.columns)
      expect(added.enumChecks).toEqual(before.enumChecks)
      expect(added.indexes.map(index => [index.columns, index.unique])).toEqual(before.indexes.map(index => [index.columns, index.unique]))
      expect(added.foreignKeys).toEqual(expect.arrayContaining([
        ...before.foreignKeys,
        { name: `${members}_parent_id_foreign`, columns: ['parent_id'], table: parents, from: 'parent_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'CASCADE' },
      ]))
      expect(added.foreignKeys).toHaveLength(2)
      await expect(db.table(members).insert({ parent_id: 99, owner_id: 1, email: 'b@example.com' })).rejects.toThrow()
      await expect(db.table(members).insert({ status: 'unknown', owner_id: 1, email: 'b@example.com' })).rejects.toThrow()
      await db.table(members).insert({ parent_id: 2, owner_id: 1, email: 'b@example.com' })
      expect(await db.table(members).orderBy('id').select('id', 'parent_id', 'owner_id', 'email', 'visits').get()).toEqual([
        { id: 1, parent_id: 1, owner_id: 2, email: 'a@example.com', visits: 1 },
        { id: 2, parent_id: 2, owner_id: 1, email: 'b@example.com', visits: 1 },
      ])
      expect(await db.table(notes).orderBy('id').pluck('member_id')).toEqual([1, 1])

      await expect(schema.table(members, table => { table.dropForeign(`${members}_missing_foreign`) })).rejects.toThrow(SchemaError)
      await schema.table(members, table => { table.dropForeign(['parent_id']) })
      await schema.table(members, table => { table.dropForeign('members_owner') })

      const dropped = (await reader.readTableStructure(members))!
      expect(dropped.columns).toEqual(before.columns)
      expect(dropped.foreignKeys).toEqual([])
      expect(dropped.indexes.map(index => [index.columns, index.unique])).toEqual(before.indexes.map(index => [index.columns, index.unique]))
      await db.table(members).insert({ parent_id: 99, owner_id: 99, email: 'c@example.com' })
      expect(await db.table(members).where('email', 'c@example.com').pluck('visits')).toEqual([1])
      expect(await db.table(notes).orderBy('id').pluck('member_id')).toEqual([1, 1])
      await db.table(members).where('id', 1).delete()
      expect(await db.table(notes).count()).toBe(0)
    })

    it.runIf(driver === 'sqlite')('drops an unnamed foreign key from an earlier release by its column', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const suffix = randomUUID().replaceAll('-', '').slice(0, 20)
      const parents = `holo_parents_${suffix}`
      const members = `holo_members_${suffix}`
      onTestFinished(async () => {
        await schema.dropTable(members)
        await schema.dropTable(parents)
      })
      await adapter.execute(`CREATE TABLE "${parents}" ("id" INTEGER PRIMARY KEY)`)
      await adapter.execute(`CREATE TABLE "${members}" ("id" INTEGER PRIMARY KEY, "name" TEXT, "parent_id" INTEGER REFERENCES "${parents}" ("id") ON DELETE CASCADE)`)
      await db.table(parents).insert({ id: 1 })
      await db.table(members).insert({ id: 1, name: 'Kept', parent_id: 1 })

      await expect(schema.table(members, table => { table.dropForeign(`${members}_parent_id_fkey`) })).rejects.toThrow(SchemaError)
      await schema.table(members, table => { table.dropConstrainedForeignId('parent_id') })

      expect((await schema.getColumns(members)).map(column => column.name)).toEqual(['id', 'name'])
      expect(await schema.getForeignKeys(members)).toEqual([])
      await db.table(parents).where('id', 1).delete()
      expect(await db.table(members).pluck('name')).toEqual(['Kept'])
    })

    it.runIf(driver === 'sqlite')('adds a nullable constrained foreign id to an existing table', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = `holo_posts_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(async () => {
        await schema.dropTable(name)
        await schema.dropTable('owners')
      })
      await schema.createTable('owners', table => { table.id() })
      await schema.createTable(name, table => {
        table.id()
        table.string('title')
      })
      await db.table(name).insert({ title: 'Kept' })

      await schema.table(name, table => { table.foreignId('owner_id').nullable().constrained() })

      expect(await db.table(name).select('title', 'owner_id').get()).toEqual([{ title: 'Kept', owner_id: null }])
      expect(await schema.getForeignKeys(name)).toEqual([{ table: 'owners', from: 'owner_id', to: 'id', onUpdate: 'NO ACTION', onDelete: 'NO ACTION' }])
      await expect(db.table(name).insert({ title: 'Orphan', owner_id: 99 })).rejects.toThrow()
    })

    it.runIf(driver === 'sqlite')('drops uniques that an earlier release declared inline by their columns or their autoindex name', async () => {
      const { db, schema, adapter } = await openDatabase(driver)
      const name = `holo_unique_inline_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(name))
      await adapter.execute(`CREATE TABLE "${name}" (
        "id" INTEGER PRIMARY KEY,
        "email" VARCHAR(255) UNIQUE,
        "code" TEXT CONSTRAINT "code_unique" UNIQUE ON CONFLICT ABORT,
        "first" TEXT,
        "last" TEXT,
        UNIQUE ("first", "last")
      )`)
      await adapter.execute(`CREATE INDEX "${name}_last_index" ON "${name}" ("last")`)
      await db.table(name).insert({ id: 1, email: 'a@example.com', code: 'A', first: 'Ada', last: 'Byron' })
      const uniqueColumns = async () => (await schema.getIndexes(name)).filter(index => index.unique).map(index => index.columns)

      await schema.table(name, table => { table.dropUnique(['email']) })

      await db.table(name).insert({ id: 2, email: 'a@example.com', code: 'B', first: 'Ada', last: 'King' })
      expect(await uniqueColumns()).toEqual(expect.arrayContaining([['code'], ['first', 'last']]))
      expect(await uniqueColumns()).toHaveLength(2)
      await expect(db.table(name).insert({ id: 3, code: 'A' })).rejects.toThrow()
      const codeIndex = (await schema.getIndexes(name)).find(index => index.columns.join() === 'code')!.name
      expect(codeIndex).toMatch(/^sqlite_autoindex_/)

      await schema.table(name, table => {
        table.dropUnique(codeIndex)
        table.dropUnique(['first', 'last'])
      })

      await db.table(name).insert({ id: 3, email: 'a@example.com', code: 'A', first: 'Ada', last: 'Byron' })
      expect(await uniqueColumns()).toEqual([])
      expect((await schema.getIndexes(name)).map(index => [index.name, index.columns])).toEqual([[`${name}_last_index`, ['last']]])
      expect(await db.table(name).orderBy('id').pluck('code')).toEqual(['A', 'B', 'A'])
      await expect(schema.table(name, table => { table.dropUnique(['email']) })).rejects.toThrow()
    })

    it('names a foreign key declared by createTable with the given constraint name', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_fk_named_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      const constraint = `${child}_parent_fk`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => {
        table.id()
        table.integer('parent_id')
        table.foreign('parent_id', constraint).references('id').on(parent)
      })
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      expect((await createSchemaReader(db).readTableStructure(child))?.foreignKeys.map(foreignKey => foreignKey.name)).toEqual([constraint])
      await schema.table(child, table => { table.dropForeign(constraint) })
      await db.table(child).insert({ parent_id: 99 })
      expect(await db.table(child).pluck('parent_id')).toEqual([99])
      expect(await schema.getForeignKeys(child)).toEqual([])
    })

    it('enforces foreign keys and cascades deletes on the native engine', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_child_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => {
        table.id()
        table.integer('parent_id')
        table.foreign('parent_id').references('id').on(parent).cascadeOnDelete().restrictOnUpdate()
      })
      await db.table(table).insert({ id: 1, name: 'Parent' })
      await db.table(child).insert({ parent_id: 1 })
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      expect(await schema.getForeignKeys(child)).toEqual([{ table: parent, from: 'parent_id', to: 'id', onUpdate: 'RESTRICT', onDelete: 'CASCADE' }])
      await db.table(table).where('id', 1).delete()
      expect(await db.table(child).count()).toBe(0)
    })

    it('rejects malformed identifiers and incomplete foreign-key chains without creating tables', async () => {
      const { schema } = await openDatabase(driver)
      const name = `holo_invalid_${randomUUID().replaceAll('-', '')}`
      await expect(schema.createTable('users; DROP TABLE users', table => { table.id() })).rejects.toThrow(SchemaError)
      await expect(schema.getColumns('users; DROP TABLE users')).rejects.toThrow(SchemaError)
      await expect(schema.createTable(name, table => { table.foreign('owner_id').references('id') })).rejects.toThrow(SchemaError)
      expect(await schema.hasTable(name)).toBe(false)
      if (driver === 'mysql') {
        const longName = `holo_${'a'.repeat(50)}`
        await expect(schema.createTable(longName, table => { table.integer('parent_id'); table.foreign('parent_id').references('id').on(name) })).rejects.toThrow(SchemaError)
        expect(await schema.hasTable(longName)).toBe(false)
      }
    })

    it('restores foreign-key enforcement after a scoped callback fails', async () => {
      const { db, schema, table } = await openDatabase(driver)
      const parent = table.tableName.split('.').at(-1)!
      const child = `holo_child_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      onTestFinished(() => schema.dropTable(child))
      await schema.createTable(child, table => { table.id(); table.integer('parent_id'); table.foreign('parent_id').references('id').on(parent) })
      await expect(schema.withoutForeignKeyConstraints(async () => { throw new Error('callback failed') })).rejects.toThrow('callback failed')
      await expect(db.table(child).insert({ parent_id: 99 })).rejects.toThrow()
      expect(await db.table(child).count()).toBe(0)
    })

    it('rejects a plain write issued while a pinned-connection transaction is open, and keeps it out of that transaction', async () => {
      const { db, schema, table } = await openDatabase(driver)
      let transactionStarted!: () => void
      const started = new Promise<void>(resolve => { transactionStarted = resolve })
      let releaseTransaction!: () => void
      const held = new Promise<void>(resolve => { releaseTransaction = resolve })

      await schema.withoutForeignKeyConstraints(async () => {
        const failing = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'rolled back' })
          transactionStarted()
          await held
          throw new Error('transaction failed')
        })
        await started
        await expect(db.table(table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        releaseTransaction()
        await expect(failing).rejects.toThrow('transaction failed')
        await db.table(table).insert({ id: 3, name: 'after' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 3 }])
    })

    it('rejects a transaction that awaits a query started outside it instead of hanging', async () => {
      const { db, schema, table } = await openDatabase(driver)

      await schema.withoutForeignKeyConstraints(async () => {
        let transactionOpen!: () => void
        const opened = new Promise<void>(resolve => { transactionOpen = resolve })
        const outsideWrite = opened.then(() => db.table(table).insert({ id: 2, name: 'outside' }))
        outsideWrite.catch(() => undefined)
        const transaction = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'inside' })
          transactionOpen()
          await outsideWrite
        })
        await expect(transaction).rejects.toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 2_000)

    it('rejects a write scheduled from a finished transaction that runs while a later transaction is open', async () => {
      const { db, schema, table } = await openDatabase(driver)
      let releaseStray!: () => void
      const strayReleased = new Promise<void>(resolve => { releaseStray = resolve })
      let strayOutcome!: Promise<unknown>

      await schema.withoutForeignKeyConstraints(async () => {
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'first' })
          strayOutcome = strayReleased
            .then(() => db.table(table).insert({ id: 2, name: 'stray' }))
            .then(() => 'ran', (error: unknown) => error)
        })
        await expect(db.transaction(async tx => {
          await tx.table(table).insert({ id: 3, name: 'second' })
          releaseStray()
          await strayOutcome
          throw new Error('second failed')
        })).rejects.toThrow('second failed')
        expect(await strayOutcome).toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }])
    })

    it('rejects a write still running its query logger when a later transaction opens before it reaches the connection', async () => {
      let pauseNextQuery = false
      let secondTransactionOpen!: () => void
      const opened = new Promise<void>(resolve => { secondTransactionOpen = resolve })
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQueryStart: async () => {
            if (!pauseNextQuery) return
            pauseNextQuery = false
            await opened
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        let strayOutcome!: Promise<unknown>
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'first' })
          pauseNextQuery = true
          strayOutcome = db.table(table).insert({ id: 2, name: 'stray' }).then(() => 'ran', (error: unknown) => error)
        })
        let strayResult: unknown
        await expect(db.transaction(async tx => {
          secondTransactionOpen()
          await tx.table(table).insert({ id: 3, name: 'second' })
          strayResult = await strayOutcome
          throw new Error('second failed')
        })).rejects.toThrow('second failed')
        expect(strayResult).toBeInstanceOf(TransactionError)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }])
    })

    it('lets a query logger start a transaction on the pinned connection after a plain write succeeds', async () => {
      let loggedWrite = false
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQuerySuccess: async entry => {
            if (loggedWrite || !entry.source?.startsWith('query:insert')) return
            loggedWrite = true
            await db.transaction(async tx => {
              await tx.table(table).insert({ id: 2, name: 'from logger' })
            })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        await db.table(table).insert({ id: 1, name: 'plain' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('keeps a timed-out write counted until it reaches the connection, so a transaction cannot take it', async () => {
      let releaseSlow!: () => void
      const slowReleased = new Promise<void>(resolve => { releaseSlow = resolve })
      let slowLanded!: () => void
      const landed = new Promise<void>(resolve => { slowLanded = resolve })
      let delayNextExecute = true
      const delaySubmission = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'execute') {
            return async (...args: Parameters<DriverAdapter['execute']>) => {
              if (!delayNextExecute || !args[0].startsWith('insert into')) return target.execute(...args)
              delayNextExecute = false
              await slowReleased
              await new Promise<void>(resolve => { setImmediate(resolve) })
              const result = await target.execute(...args)
              slowLanded()
              return result
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table } = await openDatabase(driver, {
        security: { allowUnsafeRawSql: true },
        wrapAdapter: delaySubmission,
        logger: { onTransactionStart: () => { releaseSlow() } },
      })
      const placeholder = (index: number) => driver === 'postgres' ? `$${index}` : '?'

      await schema.withoutForeignKeyConstraints(async () => {
        const slow = db.unsafeExecute(unsafeSql(
          `insert into ${table.tableName} (id, name) values (${placeholder(1)}, ${placeholder(2)})`,
          [2, 'slow'],
        ), { timeoutMs: 5 })
        await expect(slow).rejects.toThrow()
        await db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'transaction' })
          await landed
          throw new Error('transaction failed')
        }).catch(() => undefined)
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 2 }])
    }, 5_000)

    it('does not hang when a query logger starts a transaction while foreign-key checks are restored', async () => {
      let loggedRestore = false
      const { db, schema } = await openDatabase(driver, {
        logger: {
          onQuerySuccess: async entry => {
            if (loggedRestore || entry.source !== 'schema:enableForeignKeys') return
            loggedRestore = true
            await db.transaction(async () => undefined)
          },
        },
      })

      await expect(schema.withoutForeignKeyConstraints(async () => undefined)).resolves.toBeUndefined()
    }, 2_000)

    it('does not let a transaction started from the restore query logger take a write the callback left running', async () => {
      let restoreLogged = false
      let restoreStarted!: () => void
      const restoring = new Promise<void>(resolve => { restoreStarted = resolve })
      let sibling!: Promise<unknown>
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQueryStart: entry => {
            if (entry.source === 'schema:enableForeignKeys') restoreStarted()
          },
          onQuerySuccess: async entry => {
            if (restoreLogged || entry.source !== 'schema:enableForeignKeys') return
            restoreLogged = true
            await db.transaction(async tx => {
              await tx.table(table).insert({ id: 3, name: 'restore' })
              await sibling
            })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        sibling = restoring.then(() => db.table(table).insert({ id: 2, name: 'sibling' }))
        sibling.catch(() => undefined)
      })
      const siblingOutcome = await sibling.then(() => 'committed' as const, (error: unknown) => error)
      const rows = (await db.table(table).select('id').orderBy('id').get()).map(row => row.id)

      expect(siblingOutcome).toBeInstanceOf(TransactionError)
      expect(rows).not.toContain(2)
      expect(rows).not.toContain(3)
    }, 2_000)

    it('keeps a write out of a transaction whose aborted BEGIN has not settled yet', async () => {
      let beginRunning!: () => void
      const beginStarted = new Promise<void>(resolve => { beginRunning = resolve })
      let releaseBegin!: () => void
      const beginReleased = new Promise<void>(resolve => { releaseBegin = resolve })
      const delayBegin = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'beginTransaction') {
            return async (...args: Parameters<DriverAdapter['beginTransaction']>) => {
              beginRunning()
              await beginReleased
              return target.beginTransaction(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table } = await openDatabase(driver, { wrapAdapter: delayBegin })

      await schema.withoutForeignKeyConstraints(async () => {
        const controller = new AbortController()
        const started = db.transaction(async tx => {
          await tx.table(table).insert({ id: 1, name: 'transaction' })
        }, { signal: controller.signal }).then(() => undefined, (error: unknown) => error)
        await beginStarted
        controller.abort()
        await expect(db.table(table).insert({ id: 2, name: 'during begin' })).rejects.toBeInstanceOf(TransactionError)
        releaseBegin()
        expect(await started).toBeInstanceOf(Error)
        await db.table(table).insert({ id: 3, name: 'after begin' })
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([{ id: 3 }])
    }, 5_000)

    it('keeps a pinned scope on one connection in place when a concurrent scope on another connection exits', async () => {
      const first = await openDatabase(driver)
      const second = await openDatabase(driver)
      let secondTransactionOpen!: () => void
      const transactionOpen = new Promise<void>(resolve => { secondTransactionOpen = resolve })
      let firstExited!: () => void
      const exited = new Promise<void>(resolve => { firstExited = resolve })

      await second.schema.withoutForeignKeyConstraints(async () => {
        const transaction = second.db.transaction(async tx => {
          await tx.table(second.table).insert({ id: 1, name: 'open' })
          secondTransactionOpen()
          await exited
          throw new Error('second failed')
        })
        await transactionOpen
        await first.schema.withoutForeignKeyConstraints(async () => undefined)
        firstExited()
        await expect(second.db.table(second.table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        await expect(transaction).rejects.toThrow('second failed')
      })

      expect(await second.db.table(second.table).select('id').orderBy('id').get()).toEqual([])
    }, 5_000)

    it('rejects a query outside a transaction whose rollback failed, instead of joining that transaction', async () => {
      let failNextRollback = true
      const failFirstRollback = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'rollback') {
            return async (...args: Parameters<DriverAdapter['rollback']>) => {
              if (failNextRollback) {
                failNextRollback = false
                throw new Error('rollback failed')
              }
              return target.rollback(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table, adapter } = await openDatabase(driver, { wrapAdapter: failFirstRollback })

      await schema.withoutForeignKeyConstraints(async () => {
        try {
          await expect(db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'failed' })
            throw new Error('callback failed')
          })).rejects.toThrow()
          await expect(db.table(table).insert({ id: 2, name: 'plain' })).rejects.toBeInstanceOf(TransactionError)
        } finally {
          await adapter.rollback().catch(() => undefined)
        }
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 5_000)

    it('rejects an unawaited write that resumes after the callback returned, and persists nothing while the restore is delayed', async () => {
      let pauseNextInsert = false
      let restored = false
      let restoreStarted!: () => void
      const restoring = new Promise<void>(resolve => { restoreStarted = resolve })
      let lateSettled!: () => void
      const lateDone = new Promise<void>(resolve => { lateSettled = resolve })
      const { db, schema, table } = await openDatabase(driver, {
        logger: {
          onQueryStart: async entry => {
            if (pauseNextInsert && entry.source?.startsWith('query:insert')) {
              pauseNextInsert = false
              await restoring
            }
            if (entry.source === 'schema:enableForeignKeys') {
              restoreStarted()
              await lateDone
            }
          },
          onQuerySuccess: entry => {
            if (entry.source === 'schema:enableForeignKeys') restored = true
          },
        },
      })
      let late!: Promise<unknown>

      await schema.withoutForeignKeyConstraints(async () => {
        pauseNextInsert = true
        late = db.table(table).insert({ id: 1, name: 'late' }).then(() => 'ran', (error: unknown) => error)
        late.then(() => lateSettled())
      })

      expect(await late).toBeInstanceOf(TransactionError)
      expect(restored).toBe(true)
      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 3_000)

    it('leaves no abort listener or timer behind when queries reusing one signal are rejected at submission', async () => {
      let restoreStarted!: () => void
      const restoring = new Promise<void>(resolve => { restoreStarted = resolve })
      let outcomesSettled: Promise<unknown> = Promise.resolve()
      let pendingTimersWhenSettled: number | undefined
      const { db, schema } = await openDatabase(driver, {
        security: { allowUnsafeRawSql: true },
        logger: {
          onQueryStart: async entry => {
            if (entry.source === 'schema:enableForeignKeys') {
              restoreStarted()
              await outcomesSettled
              pendingTimersWhenSettled = vi.getTimerCount()
            } else if (entry.kind === 'query') {
              await restoring
            }
          },
        },
      })
      const controller = new AbortController()
      const listenersBefore = getEventListeners(controller.signal, 'abort').length

      let outcomes!: Promise<unknown>[]
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await schema.withoutForeignKeyConstraints(async () => {
          outcomes = Array.from({ length: 20 }, () => db.unsafeQuery(unsafeSql('select 1'), { signal: controller.signal, timeoutMs: 60_000 })
            .then(() => 'ran', (error: unknown) => error))
          outcomesSettled = Promise.all(outcomes)
        })
        for (const outcome of await Promise.all(outcomes)) expect(outcome).toBeInstanceOf(TransactionError)
      } finally {
        vi.useRealTimers()
      }

      expect(pendingTimersWhenSettled).toBe(0)
      expect((await db.unsafeQuery<{ value: number }>(unsafeSql('select 1 as value'), { timeoutMs: 2_000 })).rows).toEqual([{ value: 1 }])
      expect(getEventListeners(controller.signal, 'abort').length).toBe(listenersBefore)
    }, 5_000)

    it('rejects a query issued from a rollback hook after the rollback failed', async () => {
      let failNextRollback = true
      const hookOutcomes: unknown[] = []
      const failFirstRollback = (adapter: DriverAdapter): DriverAdapter => new Proxy(adapter, {
        get(target, property) {
          if (property === 'rollback') {
            return async (...args: Parameters<DriverAdapter['rollback']>) => {
              if (failNextRollback) {
                failNextRollback = false
                throw new Error('rollback failed')
              }
              return target.rollback(...args)
            }
          }
          return Reflect.get(target, property, target)
        },
      })
      const { db, schema, table, adapter } = await openDatabase(driver, {
        wrapAdapter: failFirstRollback,
        logger: {
          onTransactionRollback: async () => {
            await db.table(table).insert({ id: 2, name: 'from hook' }).then(() => { hookOutcomes.push('ran') }, (error: unknown) => {
              hookOutcomes.push(error)
            })
          },
        },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        try {
          await expect(db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'failed' })
            throw new Error('callback failed')
          })).rejects.toThrow()
          expect(hookOutcomes[0]).toBeInstanceOf(TransactionError)
        } finally {
          await adapter.rollback().catch(() => undefined)
        }
      })

      expect(await db.table(table).select('id').orderBy('id').get()).toEqual([])
    }, 5_000)

    it('reports a failed rollback once inside withoutForeignKeyConstraints', async () => {
      let failNextRollback = true
      const rolledBack: Array<{ error?: unknown }> = []
      const { db, schema, table, adapter } = await openDatabase(driver, {
        wrapAdapter: real => new Proxy(real, {
          get(target, property) {
            if (property === 'rollback') {
              return async () => {
                if (failNextRollback) {
                  failNextRollback = false
                  throw new Error('rollback failed')
                }
                return target.rollback()
              }
            }
            return Reflect.get(target, property, target)
          },
        }),
        logger: { onTransactionRollback: entry => { rolledBack.push(entry) } },
      })

      await schema.withoutForeignKeyConstraints(async () => {
        try {
          const failure = await db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'failed' })
            throw new Error('callback failed')
          }).catch((error: unknown) => error)
          expect(failure).toBeInstanceOf(TransactionError)
          expect(rolledBack).toHaveLength(1)
          expect(rolledBack[0]?.error).toBe(failure)
        } finally {
          await adapter.rollback().catch(() => undefined)
        }
      })
    }, 5_000)

    if (driver !== 'sqlite') {
      it('applies foreign-key relaxation to every query in a scoped callback and restores pooled connections', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const readStates = async () => (await Promise.all(Array.from({ length: 6 }, () => db.queryCompiled(state))))
          .map(result => String(result.rows[0]!.state))
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const enforced = driver === 'postgres' ? 'origin' : '1'

        await schema.withoutForeignKeyConstraints(async () => {
          expect(await readStates()).toEqual(Array.from({ length: 6 }, () => relaxed))
        })
        expect(await readStates()).toEqual(Array.from({ length: 6 }, () => enforced))
      })

      it('keeps foreign-key checks off for the outer callback when a nested scoped call returns', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const readState = async () => String((await db.queryCompiled(state)).rows[0]!.state)
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const enforced = driver === 'postgres' ? 'origin' : '1'

        await schema.withoutForeignKeyConstraints(async () => {
          await schema.withoutForeignKeyConstraints(async () => {})
          expect(await readState()).toBe(relaxed)
        })
        expect(await readState()).toBe(enforced)
      })

      it('restores foreign-key checks when a logger fails after the checks are turned off', async () => {
        const { db, schema } = await openDatabase(driver, {
          logger: {
            onQuerySuccess: entry => {
              if (entry.source === 'schema:disableForeignKeys') throw new Error('logger failed')
            },
          },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }

        await expect(schema.withoutForeignKeyConstraints(async () => {})).rejects.toThrow('logger failed')
        expect(String((await db.queryCompiled(state)).rows[0]!.state)).toBe(driver === 'postgres' ? 'origin' : '1')
      })

      it('runs the standalone enable through the query logger', async () => {
        const sources: string[] = []
        const { schema } = await openDatabase(driver, {
          logger: {
            onQueryStart: entry => {
              sources.push(entry.source ?? '')
            },
          },
        })

        await schema.enableForeignKeyConstraints()
        expect(sources).toContain('schema:enableForeignKeys')
      })

      it('restores foreign-key checks when a logger fails before the restore statement starts, and reports the logger error', async () => {
        const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
        errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
        onTestFinished(() => { errorReportingInternals.configure(undefined) })
        const loggerError = new Error('logger failed')
        const { db, schema } = await openDatabase(driver, {
          logger: {
            onQueryStart: entry => {
              if (entry.source === 'schema:enableForeignKeys') throw loggerError
            },
          },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }

        await expect(schema.withoutForeignKeyConstraints(async () => {})).resolves.toBeUndefined()
        expect(String((await db.queryCompiled(state)).rows[0]!.state)).toBe(driver === 'postgres' ? 'origin' : '1')
        expect(reports).toEqual([{ error: loggerError, context: { capability: 'db', operation: 'schema.restoreForeignKeys' } }])
      })

      it('runs transactions started inside a scoped callback one at a time on the pinned connection', async () => {
        let requested = 0
        let bothRequested!: () => void
        const requests = new Promise<void>(resolve => { bothRequested = resolve })
        const { db, schema, table } = await openDatabase(driver, {
          logger: { onTransactionStart: () => { requested += 1; if (requested === 2) bothRequested() } },
        })
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        const events: string[] = []

        await schema.withoutForeignKeyConstraints(async () => {
          await Promise.all([
            db.transaction(async tx => {
              events.push('a:start')
              expect(String((await tx.queryCompiled(state)).rows[0]!.state)).toBe(relaxed)
              await requests
              await tx.table(table).insert({ id: 1, name: 'first' })
              events.push('a:end')
            }),
            db.transaction(async tx => {
              events.push('b:start')
              expect(String((await tx.queryCompiled(state)).rows[0]!.state)).toBe(relaxed)
              await tx.table(table).insert({ id: 2, name: 'second' })
              throw new Error('second failed')
            }).catch(() => {}),
          ])
        })

        expect(events).toEqual(['a:start', 'a:end', 'b:start'])
        expect((await db.table(table).select('id').orderBy('id').get())).toEqual([{ id: 1 }])
      })

      it('rejects transactions that reach the pinned connection after its callback has returned, without writing', async () => {
        const { db, schema, table } = await openDatabase(driver)
        let first!: Promise<unknown>
        let second!: Promise<unknown>

        await schema.withoutForeignKeyConstraints(async () => {
          first = db.transaction(async tx => {
            await tx.table(table).insert({ id: 1, name: 'first' })
          }).then(() => undefined, (error: unknown) => error)
          second = db.transaction(async tx => {
            await tx.table(table).insert({ id: 2, name: 'second' })
          }).then(() => undefined, (error: unknown) => error)
        })

        expect(String(await first)).toContain('must finish before the callback returns')
        expect(String(await second)).toContain('must finish before the callback returns')
        expect((await db.table(table).select('id').orderBy('id').get())).toEqual([])
      })

      it('disables foreign-key checks again for work that starts after a scoped callback has finished', async () => {
        const { db, schema } = await openDatabase(driver)
        const state = driver === 'postgres'
          ? { sql: 'SELECT current_setting(\'session_replication_role\') AS state', bindings: [] }
          : { sql: 'SELECT @@SESSION.FOREIGN_KEY_CHECKS AS state', bindings: [] }
        const relaxed = driver === 'postgres' ? 'replica' : '0'
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let laterState: string | undefined

        let later!: Promise<void>
        await schema.withoutForeignKeyConstraints(async () => {
          later = gate.then(() => schema.withoutForeignKeyConstraints(async () => {
            laterState = String((await db.queryCompiled(state)).rows[0]!.state)
          }))
        })
        release()
        await later
        expect(laterState).toBe(relaxed)
      })
    }

    if (driver !== 'postgres') {
      it('rejects unsupported vectors before executing a migration', async () => {
        const { schema } = await openDatabase(driver)
        const name = `holo_vector_${randomUUID().replaceAll('-', '')}`
        await expect(schema.createTable(name, table => { table.vector('embedding', { dimensions: 3 }) })).rejects.toThrow(SchemaError)
        expect(await schema.hasTable(name)).toBe(false)
      })
    }
  })
}
