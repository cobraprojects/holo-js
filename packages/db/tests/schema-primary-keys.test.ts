import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { holoRuntimeInternals } from '../src'
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
  })
}
