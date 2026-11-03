import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { holoRuntimeInternals, SchemaError } from '../src'
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
