import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { clearGeneratedTables, defineModel, holoRuntimeInternals, queryCacheInternals, registerGeneratedTables, renderGeneratedSchemaModule, renderGeneratedSchemaRuntimeModule, resetDB, SchemaError, type DatabaseContext, type DatabaseDependencyInvalidationEvent, type TableDefinition } from '../src'
import type { DatabaseMutationEvent } from '../src/cache'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

function uniqueTableName(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 20)}`
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`native ${driver} primary keys`, () => {
    it('creates a composite primary key that rejects duplicate pairs', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))

      await schema.createTable(name, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.primary(['post_id', 'tag_id'])
      })

      await db.table(name).insert({ post_id: 1, tag_id: 1 })
      await db.table(name).insert({ post_id: 1, tag_id: 2 })
      await expect(db.table(name).insert({ post_id: 1, tag_id: 1 })).rejects.toThrow()
      expect(await db.table(name).count()).toBe(2)
      const columns = (await createSchemaReader(db).readTable(name))!.columns
      expect([columns.post_id?.primaryKey, columns.tag_id?.primaryKey]).toEqual([true, true])
    })

    it('keeps a unique column that is part of a composite primary key unique on its own', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('post_id').unique()
        table.integer('tag_id')
        table.primary(['post_id', 'tag_id'])
      })

      await db.table(name).insert({ post_id: 1, tag_id: 1 })

      await expect(db.table(name).insert({ post_id: 1, tag_id: 2 })).rejects.toThrow()
    })

    it('drops the primary key and keeps the data', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.string('note').nullable()
        table.primary(['post_id', 'tag_id'])
        table.index(['tag_id'])
      })
      await db.table(name).insert([{ post_id: 1, tag_id: 1, note: 'first' }, { post_id: 2, tag_id: 1, note: null }])

      await schema.table(name, table => { table.dropPrimary() })

      await db.table(name).insert({ post_id: 1, tag_id: 1, note: 'again' })
      expect(await db.table(name).orderBy('post_id').orderBy('note').get()).toEqual([
        { post_id: 1, tag_id: 1, note: 'again' },
        { post_id: 1, tag_id: 1, note: 'first' },
        { post_id: 2, tag_id: 1, note: null },
      ])
      const structure = (await createSchemaReader(db).readTableStructure(name))!
      expect(structure.columns.some(column => column.primaryKey)).toBe(false)
      expect(structure.indexes.map(index => index.columns)).toEqual([['tag_id']])
    })

    it('replaces an inline key with a composite key on an existing table and keeps the data', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_codes')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.string('code').primaryKey()
        table.string('region')
      })
      await db.table(name).insert([{ code: 'a', region: 'eu' }, { code: 'b', region: 'eu' }])

      await schema.table(name, table => {
        table.dropPrimary()
        table.primary(['code', 'region'])
      })

      await db.table(name).insert({ code: 'a', region: 'us' })
      await expect(db.table(name).insert({ code: 'a', region: 'eu' })).rejects.toThrow()
      expect(await db.table(name).orderBy('code').orderBy('region').get()).toEqual([
        { code: 'a', region: 'eu' },
        { code: 'a', region: 'us' },
        { code: 'b', region: 'eu' },
      ])
      const columns = (await createSchemaReader(db).readTable(name))!.columns
      expect([columns.code?.primaryKey, columns.region?.primaryKey]).toEqual([true, true])
    })

    it('refuses to add a primary key that existing rows violate and keeps the table unchanged', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('post_id')
        table.integer('tag_id')
      })
      await db.table(name).insert([{ post_id: 1, tag_id: 1 }, { post_id: 1, tag_id: 1 }])

      await expect(schema.table(name, table => { table.primary(['post_id', 'tag_id']) })).rejects.toThrow()

      expect(await db.table(name).count()).toBe(2)
      const structure = (await createSchemaReader(db).readTableStructure(name))!
      expect(structure.columns.some(column => column.primaryKey)).toBe(false)
    })

    it('accepts a primary key name when creating and adding the key', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.primary(['post_id', 'tag_id'], `${name}_pk`)
      })
      await schema.table(name, table => { table.dropPrimary() })

      await schema.table(name, table => { table.primary(['tag_id', 'post_id'], `${name}_pk`) })

      await db.table(name).insert({ post_id: 1, tag_id: 2 })
      await expect(db.table(name).insert({ post_id: 1, tag_id: 2 })).rejects.toThrow()
      const columns = (await createSchemaReader(db).readTable(name))!.columns
      expect([columns.post_id?.primaryKey, columns.tag_id?.primaryKey]).toEqual([true, true])
    })

    it.runIf(driver === 'sqlite')('never reuses the id of a deleted row when the id() primary key is named, and drops that key', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_named_id')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.id()
        table.string('title')
        table.primary(['id'], `${name}_pk`)
      })
      await db.table(name).insert([{ title: 'first' }, { title: 'second' }])
      await db.table(name).where('id', 2).delete()

      expect(Number(await db.table(name).insertGetId({ title: 'third' }))).toBe(3)

      await schema.table(name, table => { table.dropPrimary(`${name}_pk`) })
      await db.table(name).insert({ id: 1, title: 'duplicate' })
      expect(await db.table(name).where('id', 1).count()).toBe(2)
      expect((await createSchemaReader(db).readTableStructure(name))!.columns.some(column => column.primaryKey)).toBe(false)
    })

    it('raises when the table has no primary key to drop', async () => {
      const { schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_keyless')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => { table.integer('value') })

      await expect(schema.table(name, table => { table.dropPrimary() })).rejects.toThrow(SchemaError)
    })

    it('drops the primary key of a renamed table', async () => {
      const { db, schema } = await openDatabase(driver)
      const original = uniqueTableName('holo_post_tag')
      const renamed = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(renamed))
      await schema.createTable(original, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.primary(['post_id', 'tag_id'])
      })
      await schema.renameTable(original, renamed)
      await db.table(renamed).insert({ post_id: 1, tag_id: 1 })

      await schema.table(renamed, table => { table.dropPrimary() })

      await db.table(renamed).insert({ post_id: 1, tag_id: 1 })
      expect(await db.table(renamed).count()).toBe(2)
    })

    it.runIf(driver === 'postgres')('names the PostgreSQL primary key and drops only the named key', async () => {
      const { db, schema } = await openDatabase(driver)
      const name = uniqueTableName('holo_post_tag')
      onTestFinished(() => schema.dropTable(name))
      await schema.createTable(name, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.primary(['post_id', 'tag_id'], `${name}_custom_pk`)
      })
      const primaryIndex = async () => (await createSchemaReader(db).readTableStructure(name))!.indexes.find(index => index.primary)

      expect(await primaryIndex()).toMatchObject({ name: `${name}_custom_pk`, columns: ['post_id', 'tag_id'] })
      await expect(schema.table(name, table => { table.dropPrimary(`${name}_pkey`) })).rejects.toThrow(SchemaError)
      expect(await primaryIndex()).toMatchObject({ name: `${name}_custom_pk` })

      await schema.table(name, table => { table.dropPrimary(`${name}_custom_pk`) })

      expect(await primaryIndex()).toBeUndefined()
    })
  })
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`${driver} composite primary keys in the Generated schema`, () => {
    const pivotTable = `primary_keys_post_tag_${driver}`

    beforeEach(() => {
      resetDB()
      clearGeneratedTables()
    })

    async function openPivotDatabase() {
      const { db, schema } = await openDatabase(driver)
      await schema.dropTable(pivotTable)
      onTestFinished(() => schema.dropTable(pivotTable))
      await schema.createTable(pivotTable, table => {
        table.integer('post_id')
        table.integer('tag_id')
        table.integer('weight').default(0)
        table.primary(['post_id', 'tag_id'])
      })
      const table = (await createSchemaReader(db).readTable(pivotTable))!
      registerGeneratedTables({ [pivotTable]: table })
      await db.table(pivotTable).insert([
        { post_id: 2, tag_id: 1, weight: 0 },
        { post_id: 1, tag_id: 2, weight: 0 },
        { post_id: 1, tag_id: 1, weight: 0 },
        { post_id: 2, tag_id: 2, weight: 0 },
      ])
      return { db, table }
    }

    it('writes the Generated schema module the composite-key type tests compile against', async () => {
      const { table } = await openPivotDatabase()

      await expect(renderGeneratedSchemaModule([table])).toMatchFileSnapshot(`./fixtures/primary-keys/${driver}.generated.ts`)
    })

    it('chunks and cursor-paginates every row of a composite-key table in key order', async () => {
      const { db, table } = await openPivotDatabase()
      const chunked: unknown[] = []

      await db.table(table).chunk(1, rows => { chunked.push(...rows.map(row => [row.post_id, row.tag_id])) })
      const firstPage = await db.table(pivotTable).cursorPaginate(3)
      const secondPage = await db.table(pivotTable).cursorPaginate(3, firstPage.nextCursor)

      const ordered = [[1, 1], [1, 2], [2, 1], [2, 2]]
      expect(chunked).toEqual(ordered)
      expect([...firstPage.data, ...secondPage.data].map(row => [row.post_id, row.tag_id])).toEqual(ordered)
    })

    it('increments matching rows of a composite-key table and publishes each row by its full key', async () => {
      const { db } = await openPivotDatabase()
      const mutations: DatabaseMutationEvent[] = []
      onTestFinished(() => queryCacheInternals.resetDatabaseDependencyInvalidationListeners())
      queryCacheInternals.onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { mutations?: readonly DatabaseMutationEvent[] }) => {
        mutations.push(...event.mutations ?? [])
      })

      await db.table(pivotTable).where('post_id', 1).increment('weight', 2)

      expect(mutations.map(mutation => ({
        key: mutation.predicates?.map(predicate => 'column' in predicate ? [predicate.column, predicate.value] : []),
        weight: mutation.values?.weight,
      })).sort((left, right) => JSON.stringify(left.key).localeCompare(JSON.stringify(right.key)))).toEqual([
        { key: [['post_id', 1], ['tag_id', 1]], weight: 2 },
        { key: [['post_id', 1], ['tag_id', 2]], weight: 2 },
      ])

      expect((await db.table(pivotTable).orderBy('post_id').orderBy('tag_id').get()).map(row => Number(row.weight))).toEqual([2, 2, 0, 0])
    })

    it('rejects insertGetId and models on a composite-key table', async () => {
      const { db } = await openPivotDatabase()

      await expect(db.table(pivotTable).insertGetId({ post_id: 3, tag_id: 3, weight: 0 })).rejects.toThrow(SchemaError)
      const PostTag = defineModel(pivotTable)
      expect(() => PostTag.query()).toThrow(SchemaError)
      expect(await db.table(pivotTable).count()).toBe(4)
    })
  })
}

for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
  describe(`${driver} composite primary key column order`, () => {
    beforeEach(() => {
      resetDB()
      clearGeneratedTables()
    })

    async function createReversedKeyTable(declare: 'createTable' | 'schema.table') {
      const opened = await openDatabase(driver)
      const { db, schema } = opened
      const parent = uniqueTableName('holo_key_order')
      const child = uniqueTableName('holo_key_order_child')
      onTestFinished(async () => {
        await schema.dropTable(child)
        await schema.dropTable(parent)
      })
      await schema.createTable(parent, (table) => {
        table.integer('a')
        table.integer('b')
        if (declare === 'createTable') table.primary(['b', 'a'])
      })
      if (declare === 'schema.table') await schema.table(parent, (table) => { table.primary(['b', 'a']) })
      const reference = driver === 'mysql' ? `${db.getDialect().quoteIdentifier(parent)} (b, a)` : db.getDialect().quoteIdentifier(parent)
      await db.executeCompiled({ sql: `CREATE TABLE ${db.getDialect().quoteIdentifier(child)} (parent_b integer NOT NULL, parent_a integer NOT NULL, FOREIGN KEY (parent_b, parent_a) REFERENCES ${reference})`, source: 'schema' })
      await db.table(parent).insert([{ a: 1, b: 2 }, { a: 2, b: 1 }])
      return { ...opened, parent, child }
    }

    async function chunkedKeys(db: DatabaseContext, table: string | TableDefinition) {
      const keys: number[][] = []
      await db.table(table).chunk(1, (rows) => { keys.push(...rows.map(row => [Number(row.b), Number(row.a)])) })
      return keys
    }

    for (const declare of ['createTable', 'schema.table'] as const) {
      it(`creates the key in the order primary() lists its columns through ${declare}`, async () => {
        const { db, parent, child } = await createReversedKeyTable(declare)

        await db.table(child).insert({ parent_b: 2, parent_a: 1 })
        const definition = (await createSchemaReader(db).readTable(parent))!

        expect(await db.table(child).count()).toBe(1)
        expect(await chunkedKeys(db, definition)).toEqual([[1, 2], [2, 1]])
      })
    }

    it.runIf(driver !== 'mysql')('chunks and cursor-paginates a string table name in the key order of its Generated schema', async () => {
      const { db, parent } = await createReversedKeyTable('createTable')
      registerGeneratedTables({ [parent]: (await createSchemaReader(db).readTable(parent))! })

      const firstPage = await db.table(parent).cursorPaginate(1)
      const secondPage = await db.table(parent).cursorPaginate(1, firstPage.nextCursor)

      expect(await chunkedKeys(db, parent)).toEqual([[1, 2], [2, 1]])
      expect([...firstPage.data, ...secondPage.data].map(row => [Number(row.b), Number(row.a)])).toEqual([[1, 2], [2, 1]])
    })

    it('keeps the key column order through the Generated schema', async () => {
      const { db, parent } = await createReversedKeyTable('createTable')
      const definition = (await createSchemaReader(db).readTable(parent))!
      const directory = await mkdtemp(join(tmpdir(), 'holo-generated-schema-'))
      onTestFinished(() => rm(directory, { recursive: true, force: true }))
      const modulePath = join(directory, 'schema.generated.ts')
      await writeFile(modulePath, renderGeneratedSchemaRuntimeModule([definition]))

      await import(pathToFileURL(modulePath).href)

      expect(await chunkedKeys(db, parent)).toEqual([[1, 2], [2, 1]])
    })
  })
}
