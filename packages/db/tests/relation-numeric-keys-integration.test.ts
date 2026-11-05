import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

type KeyKind = 'decimal' | 'text'

function relation<TRelation>(entity: { getRelation<T>(name: string): T | undefined } | undefined, name: string): TRelation {
  if (!entity) throw new Error(`expected a loaded parent before reading ${name}`)
  return entity.getRelation<TRelation>(name) as TRelation
}

function ids(entities: readonly Entity<TableDefinition>[]): unknown[] {
  return entities.map(entity => entity.get('id' as never)).sort()
}

async function openKeyFixtures(driver: 'sqlite' | 'postgres' | 'mysql', kind: KeyKind) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { owners: `nk_owners_${suffix}`, items: `nk_items_${suffix}`, tags: `nk_tags_${suffix}`, pivot: `nk_owner_tags_${suffix}` }
  const keyColumn = (table: Parameters<Parameters<typeof schema.createTable>[1]>[0], name: string) => kind === 'decimal' ? table.decimal(name) : table.string(name)
  const keyDefinition = () => kind === 'decimal' ? column.decimal() : column.string()
  await schema.createTable(names.owners, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.owners))
  await schema.createTable(names.items, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'owner_id')
  })
  onTestFinished(() => schema.dropTable(names.items))
  await schema.createTable(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.tags))
  await schema.createTable(names.pivot, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'owner_id')
    keyColumn(table, 'tag_id')
  })
  onTestFinished(() => schema.dropTable(names.pivot))

  const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey(), name: column.string() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_id: keyDefinition() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), name: column.string() })
  const pivot = defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), owner_id: keyDefinition(), tag_id: keyDefinition() })
  const key = (value: number) => kind === 'decimal' ? `${value}.00` : String(value)

  await DB.table(owners).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }, { id: 3, name: 'empty' }])
  await DB.table(items).insert([{ id: 10, owner_id: key(1) }, { id: 11, owner_id: key(1) }, { id: 20, owner_id: key(2) }, { id: 30, owner_id: '1.50' }])
  await DB.table(tags).insert([{ id: 1, name: 'red' }, { id: 2, name: 'blue' }])
  await DB.table(pivot).insert([{ id: 1, owner_id: key(1), tag_id: key(1) }, { id: 2, owner_id: key(1), tag_id: key(2) }, { id: 3, owner_id: key(2), tag_id: key(2) }, { id: 4, owner_id: key(2), tag_id: '1.50' }])

  const Tag = defineModel(tags, { timestamps: false })
  const Item = defineModel(items, { timestamps: false })
  const Owner = defineModel(owners, {
    timestamps: false,
    relations: {
      items: hasMany(() => Item, 'owner_id'),
      item: hasOne(() => Item, 'owner_id'),
      tags: belongsToMany(() => Tag, pivot, 'owner_id', 'tag_id'),
    },
  })
  const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_id') } })
  return { Owner, Item: ItemWithOwner }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation keys across numeric column kinds on %s', (driver) => {
  describe.each(['decimal', 'text'] as const)('with a %s foreign key to an integer id', (kind) => {
    it('eager loads hasMany and hasOne', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('items', 'item').orderBy('id').get()

      expect(ids(relation(first, 'items'))).toEqual([10, 11])
      expect(ids(relation(second, 'items'))).toEqual([20])
      expect(relation(empty, 'items')).toEqual([])
      expect([10, 11]).toContain(relation<Entity<TableDefinition>>(first, 'item').get('id' as never))
      expect(relation<Entity<TableDefinition>>(second, 'item').get('id' as never)).toBe(20)
      expect(relation(empty, 'item')).toBeNull()
    })

    it('eager loads belongsTo', async () => {
      const { Item } = await openKeyFixtures(driver, kind)

      const items = await Item.with('owner').orderBy('id').get()

      expect(items.map(item => relation<Entity<TableDefinition> | null>(item, 'owner')?.get('name' as never))).toEqual(['first', 'first', 'second', undefined])
    })

    it('eager loads belongsToMany through the pivot', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('tags').orderBy('id').get()

      expect(ids(relation(first, 'tags'))).toEqual([1, 2])
      expect(ids(relation(second, 'tags'))).toEqual([2])
      expect(relation(empty, 'tags')).toEqual([])
    })
  })
})
