import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Entity, belongsTo, column, hasMany, latestOfMany, type TableDefinition } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { openDatabase } from './support/database'

const keyA = Buffer.from('owner-a')
const keyB = Buffer.from('owner-b')

function defineBinaryRelationScenario(driver: 'postgres' | 'mysql') {
  it('attaches hasMany, belongsTo and hasOneOfMany rows across blob keys on the real database', async () => {
    const { db, schema } = await openDatabase(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = { owners: `bk_owners_${suffix}`, items: `bk_items_${suffix}` }
    const qualify = (name: string) => driver === 'postgres'
      ? name
      : `${process.env.HOLO_MYSQL_DATABASE ?? 'mysql'}.${name}`

    try {
      await schema.createTable(names.owners, table => {
        table.integer('id').primaryKey()
        table.blob('key')
        table.string('name')
      })
      await schema.createTable(names.items, table => {
        table.integer('id').primaryKey()
        table.blob('ownerKey')
        table.string('label')
      })

      const owners = defineTable(qualify(names.owners), { id: column.integer().primaryKey(), key: column.blob(), name: column.string() })
      const items = defineTable(qualify(names.items), { id: column.integer().primaryKey(), ownerKey: column.blob(), label: column.string() })
      await db.table(owners).insert([{ id: 1, key: keyA, name: 'A' }, { id: 2, key: keyB, name: 'B' }])
      await db.table(items).insert([
        { id: 1, ownerKey: keyA, label: 'old' },
        { id: 2, ownerKey: keyA, label: 'new' },
      ])

      const Item = defineModelFromTable(items)
      const Owner = defineModelFromTable(owners, {
        relations: {
          items: hasMany(() => Item, 'ownerKey', 'key'),
          latestItem: latestOfMany(() => Item, 'ownerKey', 'key'),
        },
      })
      const ItemWithOwner = defineModelFromTable(items, {
        relations: { owner: belongsTo(() => Owner, 'ownerKey', 'key') },
      })

      const [a, b] = await Owner.with('items', 'latestItem').orderBy('name').get()
      const [item] = await ItemWithOwner.with('owner').where('id', 1).get()

      expect((a!.getRelation<Entity<TableDefinition>[]>('items') ?? []).map(entity => entity.get('id'))).toEqual([1, 2])
      expect(b!.getRelation<Entity<TableDefinition>[]>('items')).toEqual([])
      expect(a!.getRelation<Entity<TableDefinition>>('latestItem')?.get('id')).toBe(2)
      expect(item!.getRelation<Entity<TableDefinition>>('owner')?.get('name')).toBe('A')
    } finally {
      await schema.dropTable(names.items)
      await schema.dropTable(names.owners)
    }
  })
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('binary relation keys on postgres', () => {
  defineBinaryRelationScenario('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('binary relation keys on mysql', () => {
  defineBinaryRelationScenario('mysql')
})
