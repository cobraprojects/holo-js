import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne, latestOfMany, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

type KeyKind = 'decimal' | 'text'

function relation<TRelation>(entity: { getRelation<T>(name: string): T | undefined } | undefined, name: string): TRelation {
  if (!entity) throw new Error(`expected a loaded parent before reading ${name}`)
  return entity.getRelation<TRelation>(name) as TRelation
}

function ids(entities: readonly Entity<TableDefinition>[]): number[] {
  return entities.map(entity => entity.get('id' as never) as number).sort((left, right) => left - right)
}

async function openKeyFixtures(driver: 'sqlite' | 'postgres' | 'mysql', kind: KeyKind) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const names = { owners: `nk_owners_${suffix}`, items: `nk_items_${suffix}`, tags: `nk_tags_${suffix}`, pivot: `nk_owner_tags_${suffix}` }
  const keyColumn = (table: Parameters<Parameters<typeof schema.createTable>[1]>[0], name: string) => kind === 'decimal' ? table.decimal(name) : table.string(name)
  const keyDefinition = () => kind === 'decimal' ? column.decimal() : column.string()
  await schema.createTable(names.owners, (table) => {
    table.bigInteger('id').primaryKey()
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

  const owners = defineGeneratedTable(names.owners, { id: column.bigInteger().primaryKey(), name: column.string() })
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
      latestItem: latestOfMany(() => Item, 'owner_id'),
      tags: belongsToMany(() => Tag, pivot, 'owner_id', 'tag_id'),
    },
  })
  const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_id') } })
  return { Owner, Item: ItemWithOwner }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('text relation keys on %s', (driver) => {
  it('keeps distinct numeric-looking text keys apart', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = { owners: `tk_owners_${suffix}`, items: `tk_items_${suffix}` }
    await schema.createTable(names.owners, (table) => {
      table.string('code').primaryKey()
    })
    onTestFinished(() => schema.dropTable(names.owners))
    await schema.createTable(names.items, (table) => {
      table.integer('id').primaryKey()
      table.string('owner_code')
    })
    onTestFinished(() => schema.dropTable(names.items))
    const owners = defineGeneratedTable(names.owners, { code: column.string().primaryKey() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_code: column.string() })
    await DB.table(owners).insert([{ code: '1' }, { code: '1.0' }])
    await DB.table(items).insert([{ id: 10, owner_code: '1' }, { id: 20, owner_code: '1.0' }])
    const Item = defineModel(items, { timestamps: false })
    const Owner = defineModel(owners, { primaryKey: 'code', timestamps: false, relations: { items: hasMany(() => Item, 'owner_code', 'code') } })
    const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })

    const loadedOwners = await Owner.with('items').orderBy('code').get()
    const loadedItems = await ItemWithOwner.with('owner').orderBy('id').get()

    expect(loadedOwners.map(owner => ids(relation(owner, 'items')))).toEqual([[10], [20]])
    expect(loadedItems.map(item => relation<Entity<TableDefinition>>(item, 'owner').get('code' as never))).toEqual(['1', '1.0'])
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation keys across numeric column kinds on %s', (driver) => {
  describe.each(['decimal', 'text'] as const)('with a %s foreign key to a bigint id', (kind) => {
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

    it('eager loads hasOneOfMany', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('latestItem').orderBy('id').get()

      expect(relation<Entity<TableDefinition>>(first, 'latestItem').get('id' as never)).toBe(11)
      expect(relation<Entity<TableDefinition>>(second, 'latestItem').get('id' as never)).toBe(20)
      expect(relation(empty, 'latestItem')).toBeNull()
    })

    it('counts hasMany and belongsTo relations of loaded models', async () => {
      const { Owner, Item } = await openKeyFixtures(driver, kind)

      const owners = await (await Owner.orderBy('id').get()).loadCount('items')
      const items = await (await Item.orderBy('id').get()).loadCount('owner')

      expect(owners.map(owner => owner.get('items_count' as never))).toEqual([2, 1, 0])
      expect(items.map(item => item.get('owner_count' as never))).toEqual([1, 1, 1, 0])
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

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation keys referenced by integer columns on %s', (driver) => {
  async function openDecimalOwnerFixtures(kind: KeyKind = 'decimal') {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = { owners: `dk_owners_${suffix}`, items: `dk_items_${suffix}`, tags: `dk_tags_${suffix}`, pivot: `dk_owner_tags_${suffix}` }
    await schema.createTable(names.owners, (table) => {
      table.integer('id').primaryKey()
      if (kind === 'decimal') table.decimal('code')
      else table.string('code')
    })
    onTestFinished(() => schema.dropTable(names.owners))
    await schema.createTable(names.items, (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_code')
    })
    onTestFinished(() => schema.dropTable(names.items))
    await schema.createTable(names.tags, (table) => {
      table.integer('id').primaryKey()
      table.decimal('code')
    })
    onTestFinished(() => schema.dropTable(names.tags))
    await schema.createTable(names.pivot, (table) => {
      table.integer('id').primaryKey()
      table.integer('owner_code')
      table.integer('tag_code')
    })
    onTestFinished(() => schema.dropTable(names.pivot))

    const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey(), code: kind === 'decimal' ? column.decimal() : column.string() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_code: column.integer() })
    const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), code: column.decimal() })
    const pivot = defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), owner_code: column.integer(), tag_code: column.integer() })
    await DB.table(owners).insert([{ id: 1, code: '5.00' }, { id: 2, code: '6.00' }, { id: 3, code: '5.50' }])
    await DB.table(items).insert([{ id: 10, owner_code: 5 }, { id: 11, owner_code: 5 }, { id: 20, owner_code: 6 }])
    await DB.table(tags).insert([{ id: 1, code: '7.00' }, { id: 2, code: '8.00' }])
    await DB.table(pivot).insert([{ id: 1, owner_code: 5, tag_code: 7 }, { id: 2, owner_code: 5, tag_code: 8 }, { id: 3, owner_code: 6, tag_code: 8 }])

    const Tag = defineModel(tags, { timestamps: false })
    const Item = defineModel(items, { timestamps: false })
    const Owner = defineModel(owners, {
      timestamps: false,
      relations: {
        items: hasMany(() => Item, 'owner_code', 'code'),
        latestItem: latestOfMany(() => Item, 'owner_code', 'code'),
        tags: belongsToMany(() => Tag, pivot, 'owner_code', 'tag_code', 'code', 'code'),
      },
    })
    const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })
    return { Owner, Item: ItemWithOwner }
  }

  it('eager loads hasMany from a decimal local key', async () => {
    const { Owner } = await openDecimalOwnerFixtures()

    const [first, second, fractional] = await Owner.with('items').orderBy('id').get()

    expect(ids(relation(first, 'items'))).toEqual([10, 11])
    expect(ids(relation(second, 'items'))).toEqual([20])
    expect(relation(fractional, 'items')).toEqual([])
  })

  it('eager loads hasOneOfMany from a decimal local key', async () => {
    const { Owner } = await openDecimalOwnerFixtures()

    const [first, second, fractional] = await Owner.with('latestItem').orderBy('id').get()

    expect(relation<Entity<TableDefinition>>(first, 'latestItem').get('id' as never)).toBe(11)
    expect(relation<Entity<TableDefinition>>(second, 'latestItem').get('id' as never)).toBe(20)
    expect(relation(fractional, 'latestItem')).toBeNull()
  })

  it('counts belongsToMany through integer pivot columns from decimal keys', async () => {
    const { Owner } = await openDecimalOwnerFixtures()

    const owners = await (await Owner.orderBy('id').get()).loadCount('tags')

    expect(owners.map(owner => owner.get('tags_count' as never))).toEqual([2, 1, 0])
  })

  it.each(['decimal', 'text'] as const)('eager loads hasMany and belongsToMany from a %s key holding decimal text', async (kind) => {
    const { Owner } = await openDecimalOwnerFixtures(kind)

    const [first, second, fractional] = await Owner.with('items', 'tags').orderBy('id').get()

    expect(ids(relation(first, 'items'))).toEqual([10, 11])
    expect(ids(relation(second, 'items'))).toEqual([20])
    expect(relation(fractional, 'items')).toEqual([])
    expect(ids(relation(first, 'tags'))).toEqual([1, 2])
    expect(ids(relation(second, 'tags'))).toEqual([2])
    expect(relation(fractional, 'tags')).toEqual([])
  })

  it('eager loads belongsTo to a decimal owner key', async () => {
    const { Item } = await openDecimalOwnerFixtures()

    const items = await Item.with('owner').orderBy('id').get()

    expect(items.map(item => relation<Entity<TableDefinition> | null>(item, 'owner')?.get('id' as never))).toEqual([1, 1, 2])
  })

  it('eager loads belongsToMany through integer pivot columns from decimal keys', async () => {
    const { Owner } = await openDecimalOwnerFixtures()

    const [first, second, fractional] = await Owner.with('tags').orderBy('id').get()

    expect(ids(relation(first, 'tags'))).toEqual([1, 2])
    expect(ids(relation(second, 'tags'))).toEqual([2])
    expect(relation(fractional, 'tags')).toEqual([])
  })
})
