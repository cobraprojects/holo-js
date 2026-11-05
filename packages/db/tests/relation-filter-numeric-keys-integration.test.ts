import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, hasOneThrough, morphMany, morphOne, morphTo, morphToMany, morphedByMany, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

type KeyKind = 'decimal' | 'text'
type Driver = 'sqlite' | 'postgres' | 'mysql'
type Loaded = Entity<TableDefinition>
type Schema = Awaited<ReturnType<typeof openDatabase>>['schema']
type Blueprint = Parameters<Parameters<Schema['createTable']>[1]>[0]

function suffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function valuesOf(entities: readonly { get(attribute: never): unknown }[], attribute = 'id'): unknown[] {
  return entities.map(entity => entity.get(attribute as never))
}

async function createTable(schema: Schema, name: string, callback: (table: Blueprint) => void) {
  await schema.createTable(name, callback)
  onTestFinished(() => schema.dropTable(name))
}

async function openKeyFixtures(driver: Driver, kind: KeyKind) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = suffix()
  const names = { owners: `fk_owners_${tag}`, items: `fk_items_${tag}`, parts: `fk_parts_${tag}`, tags: `fk_tags_${tag}`, pivot: `fk_owner_tags_${tag}`, notes: `fk_notes_${tag}`, taggables: `fk_taggables_${tag}` }
  const keyColumn = (table: Blueprint, name: string) => kind === 'decimal' ? table.decimal(name) : table.string(name)
  const keyDefinition = () => kind === 'decimal' ? column.decimal() : column.string()
  await createTable(schema, names.owners, (table) => {
    table.bigInteger('id').primaryKey()
    table.string('name')
  })
  await createTable(schema, names.items, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'owner_id')
  })
  await createTable(schema, names.parts, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'item_id')
  })
  await createTable(schema, names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  await createTable(schema, names.pivot, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'owner_id')
    keyColumn(table, 'tag_id')
  })
  await createTable(schema, names.notes, (table) => {
    table.integer('id').primaryKey()
    table.string('noteable_type')
    keyColumn(table, 'noteable_id')
  })
  await createTable(schema, names.taggables, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'tag_id')
    table.string('taggable_type')
    keyColumn(table, 'taggable_id')
  })

  const owners = defineGeneratedTable(names.owners, { id: column.bigInteger().primaryKey(), name: column.string() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_id: keyDefinition() })
  const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_id: keyDefinition() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), name: column.string() })
  const pivot = defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), owner_id: keyDefinition(), tag_id: keyDefinition() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: keyDefinition() })
  const taggables = defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_id: keyDefinition(), taggable_type: column.string(), taggable_id: keyDefinition() })
  const key = (value: number) => kind === 'decimal' ? `${value}.00` : String(value)
  const ownerType = `FkOwner${tag}`

  await DB.table(owners).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }, { id: 3, name: 'empty' }])
  await DB.table(items).insert([{ id: 10, owner_id: key(1) }, { id: 11, owner_id: key(1) }, { id: 20, owner_id: key(2) }, { id: 30, owner_id: '1.50' }])
  await DB.table(parts).insert([{ id: 100, item_id: key(10) }, { id: 101, item_id: key(11) }, { id: 200, item_id: key(20) }, { id: 300, item_id: key(30) }, { id: 999, item_id: '10.50' }])
  await DB.table(tags).insert([{ id: 1, name: 'red' }, { id: 2, name: 'blue' }, { id: 3, name: 'unused' }])
  await DB.table(pivot).insert([{ id: 1, owner_id: key(1), tag_id: key(1) }, { id: 2, owner_id: key(1), tag_id: key(2) }, { id: 3, owner_id: key(2), tag_id: key(2) }, { id: 4, owner_id: '3.50', tag_id: key(3) }])
  await DB.table(notes).insert([
    { id: 10, noteable_type: ownerType, noteable_id: key(1) },
    { id: 11, noteable_type: ownerType, noteable_id: key(1) },
    { id: 20, noteable_type: ownerType, noteable_id: key(2) },
    { id: 30, noteable_type: ownerType, noteable_id: '1.50' },
  ])
  await DB.table(taggables).insert([
    { id: 1, tag_id: key(1), taggable_type: ownerType, taggable_id: key(1) },
    { id: 2, tag_id: key(2), taggable_type: ownerType, taggable_id: key(1) },
    { id: 3, tag_id: key(2), taggable_type: ownerType, taggable_id: key(2) },
    { id: 4, tag_id: key(3), taggable_type: ownerType, taggable_id: '3.50' },
  ])

  const Tag = defineModel(tags, { timestamps: false })
  const Part = defineModel(parts, { timestamps: false })
  const Item = defineModel(items, { timestamps: false })
  const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
  const Owner = defineModel(owners, {
    morphClass: ownerType,
    timestamps: false,
    relations: {
      items: hasMany(() => Item, 'owner_id'),
      item: hasOne(() => Item, 'owner_id'),
      tags: belongsToMany(() => Tag, pivot, 'owner_id', 'tag_id'),
      notes: morphMany(() => Note, 'noteable'),
      note: morphOne(() => Note, 'noteable'),
      morphTags: morphToMany(() => Tag, 'taggable', taggables, 'tag_id'),
      parts: hasManyThrough(() => Part, () => Item, 'owner_id', 'item_id'),
      part: hasOneThrough(() => Part, () => Item, 'owner_id', 'item_id'),
    },
  })
  const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_id') } })
  const TagWithOwners = defineModel(tags, {
    timestamps: false,
    relations: {
      owners: belongsToMany(() => Owner, pivot, 'tag_id', 'owner_id'),
      morphOwners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_id'),
    },
  })
  return { Owner, Item: ItemWithOwner, Note, Tag: TagWithOwners, partsTable: names.parts, tagsTable: names.tags, ownersTable: names.owners }
}

async function openDecimalOwnerFixtures(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = suffix()
  const names = { owners: `fd_owners_${tag}`, items: `fd_items_${tag}`, parts: `fd_parts_${tag}`, tags: `fd_tags_${tag}`, pivot: `fd_owner_tags_${tag}`, notes: `fd_notes_${tag}`, taggables: `fd_taggables_${tag}` }
  await createTable(schema, names.owners, (table) => {
    table.decimal('code').primaryKey()
    table.string('name')
  })
  await createTable(schema, names.items, (table) => {
    table.integer('id').primaryKey()
    table.integer('owner_code')
    table.decimal('code')
  })
  await createTable(schema, names.parts, (table) => {
    table.integer('id').primaryKey()
    table.integer('item_code')
  })
  await createTable(schema, names.tags, (table) => {
    table.integer('id').primaryKey()
    table.decimal('code')
  })
  await createTable(schema, names.pivot, (table) => {
    table.integer('id').primaryKey()
    table.integer('owner_code')
    table.integer('tag_code')
  })
  await createTable(schema, names.notes, (table) => {
    table.integer('id').primaryKey()
    table.string('noteable_type')
    table.integer('noteable_id')
  })
  await createTable(schema, names.taggables, (table) => {
    table.integer('id').primaryKey()
    table.integer('tag_code')
    table.string('taggable_type')
    table.integer('taggable_id')
  })

  const owners = defineGeneratedTable(names.owners, { code: column.decimal().primaryKey(), name: column.string() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_code: column.integer(), code: column.decimal() })
  const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_code: column.integer() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), code: column.decimal() })
  const pivot = defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), owner_code: column.integer(), tag_code: column.integer() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: column.integer() })
  const taggables = defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_code: column.integer(), taggable_type: column.string(), taggable_id: column.integer() })
  const ownerType = `FdOwner${tag}`

  await DB.table(owners).insert([{ code: '5.00', name: 'first' }, { code: '5.50', name: 'fractional' }, { code: '6.00', name: 'second' }])
  await DB.table(items).insert([{ id: 10, owner_code: 5, code: '50.00' }, { id: 11, owner_code: 5, code: '51.00' }, { id: 20, owner_code: 6, code: '60.00' }, { id: 21, owner_code: 6, code: '60.50' }, { id: 30, owner_code: 9, code: '90.00' }])
  await DB.table(parts).insert([{ id: 100, item_code: 50 }, { id: 101, item_code: 51 }, { id: 200, item_code: 60 }])
  await DB.table(tags).insert([{ id: 1, code: '7.00' }, { id: 2, code: '8.00' }, { id: 3, code: '7.50' }])
  await DB.table(pivot).insert([{ id: 1, owner_code: 5, tag_code: 7 }, { id: 2, owner_code: 5, tag_code: 8 }, { id: 3, owner_code: 6, tag_code: 8 }])
  await DB.table(notes).insert([{ id: 10, noteable_type: ownerType, noteable_id: 5 }, { id: 11, noteable_type: ownerType, noteable_id: 5 }, { id: 20, noteable_type: ownerType, noteable_id: 6 }, { id: 30, noteable_type: ownerType, noteable_id: 9 }])
  await DB.table(taggables).insert([{ id: 1, tag_code: 7, taggable_type: ownerType, taggable_id: 5 }, { id: 2, tag_code: 8, taggable_type: ownerType, taggable_id: 5 }, { id: 3, tag_code: 8, taggable_type: ownerType, taggable_id: 6 }])

  const Part = defineModel(parts, { timestamps: false })
  const Item = defineModel(items, { timestamps: false })
  const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(owners, {
    morphClass: ownerType,
    primaryKey: 'code',
    timestamps: false,
    relations: {
      items: hasMany(() => Item, 'owner_code', 'code'),
      tags: belongsToMany(() => Tag, pivot, 'owner_code', 'tag_code', 'code', 'code'),
      notes: morphMany(() => Note, 'noteable', 'noteable_type', 'noteable_id', 'code'),
      morphTags: morphToMany(() => Tag, 'taggable', taggables, 'tag_code', 'code', 'code'),
      parts: hasManyThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
    },
  })
  const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })
  const TagWithOwners = defineModel(tags, { timestamps: false, relations: { morphOwners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_code', 'code', 'code') } })
  return { Owner, Item: ItemWithOwner, Note, Tag: TagWithOwners }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation filters across numeric key kinds on %s', (driver) => {
  describe.each(['decimal', 'text'] as const)('with %s keys to a bigint id', (kind) => {
    it('filters and counts hasMany, hasOne and belongsTo', async () => {
      const { Owner, Item } = await openKeyFixtures(driver, kind)

      expect(valuesOf(await Owner.has('items').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.has('item').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereHas('items', query => query.where('id', 20)).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Owner.whereDoesntHave('items').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('items').orderBy('id').get(), 'items_count')).toEqual([2, 1, 0])
      expect(valuesOf(await Item.has('owner').orderBy('id').get())).toEqual([10, 11, 20])
      expect(valuesOf(await Item.whereHas('owner', query => query.where('name', 'second')).orderBy('id').get())).toEqual([20])
      expect(valuesOf(await Item.whereDoesntHave('owner').orderBy('id').get())).toEqual([30])
      expect(valuesOf(await Item.withCount('owner').orderBy('id').get(), 'owner_count')).toEqual([1, 1, 1, 0])
    })

    it('filters and counts belongsToMany', async () => {
      const { Owner, Tag, tagsTable, ownersTable } = await openKeyFixtures(driver, kind)

      expect(valuesOf(await Owner.has('tags').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereHas('tags', query => query.from(`${tagsTable} as t`).where('t.name', 'red')).orderBy('id').get())).toEqual([1])
      expect(valuesOf(await Tag.whereHas('owners', query => query.from(`${ownersTable} as o`).where('o.name', 'second')).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Owner.whereHas('tags', query => query.where('name', 'red')).orderBy('id').get())).toEqual([1])
      expect(valuesOf(await Owner.whereDoesntHave('tags').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('tags').orderBy('id').get(), 'tags_count')).toEqual([2, 1, 0])
      expect(valuesOf(await Tag.has('owners').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Tag.withCount('owners').orderBy('id').get(), 'owners_count')).toEqual([1, 2, 0])
    })

    it('filters and counts morphMany, morphOne and morphTo', async () => {
      const { Owner, Note } = await openKeyFixtures(driver, kind)

      expect(valuesOf(await Owner.has('notes').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.has('note').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereHas('notes', query => query.where('id', 20)).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Owner.whereDoesntHave('notes').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('notes').orderBy('id').get(), 'notes_count')).toEqual([2, 1, 0])
      expect(valuesOf(await Note.has('noteable').orderBy('id').get())).toEqual([10, 11, 20])
      expect(valuesOf(await Note.whereHas('noteable', query => query.where('id', 2)).orderBy('id').get())).toEqual([20])
      expect(valuesOf(await Note.whereDoesntHave('noteable').orderBy('id').get())).toEqual([30])
      expect(valuesOf(await Note.withCount('noteable').orderBy('id').get(), 'noteable_count')).toEqual([1, 1, 1, 0])
    })

    it('filters and counts morphToMany and morphedByMany', async () => {
      const { Owner, Tag, tagsTable, ownersTable } = await openKeyFixtures(driver, kind)

      expect(valuesOf(await Owner.has('morphTags').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereHas('morphTags', query => query.from(`${tagsTable} as t`).where('t.name', 'red')).orderBy('id').get())).toEqual([1])
      expect(valuesOf(await Tag.whereHas('morphOwners', query => query.from(`${ownersTable} as o`).where('o.name', 'second')).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Owner.whereHas('morphTags', query => query.where('name', 'red')).orderBy('id').get())).toEqual([1])
      expect(valuesOf(await Owner.whereDoesntHave('morphTags').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('morphTags').orderBy('id').get(), 'morphTags_count')).toEqual([2, 1, 0])
      expect(valuesOf(await Tag.has('morphOwners').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Tag.whereHas('morphOwners', query => query.where('name', 'second')).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Tag.withCount('morphOwners').orderBy('id').get(), 'morphOwners_count')).toEqual([1, 2, 0])
    })

    it('filters and counts hasManyThrough and hasOneThrough', async () => {
      const { Owner, partsTable } = await openKeyFixtures(driver, kind)

      expect(valuesOf(await Owner.has('parts').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.has('part').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereHas('parts', query => query.where(`${partsTable}.id`, 200)).orderBy('id').get())).toEqual([2])
      expect(valuesOf(await Owner.whereDoesntHave('parts').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('parts').orderBy('id').get(), 'parts_count')).toEqual([2, 1, 0])
    })
  })

  describe('with integer keys referencing decimal keys', () => {
    it('filters and counts hasMany, belongsTo and belongsToMany', async () => {
      const { Owner, Item } = await openDecimalOwnerFixtures(driver)

      expect(valuesOf(await Owner.has('items').orderBy('code').get(), 'name')).toEqual(['first', 'second'])
      expect(valuesOf(await Owner.whereDoesntHave('items').orderBy('code').get(), 'name')).toEqual(['fractional'])
      expect(valuesOf(await Owner.withCount('items').orderBy('code').get(), 'items_count')).toEqual([2, 0, 2])
      expect(valuesOf(await Item.has('owner').orderBy('id').get())).toEqual([10, 11, 20, 21])
      expect(valuesOf(await Item.whereDoesntHave('owner').orderBy('id').get())).toEqual([30])
      expect(valuesOf(await Owner.has('tags').orderBy('code').get(), 'name')).toEqual(['first', 'second'])
      expect(valuesOf(await Owner.withCount('tags').orderBy('code').get(), 'tags_count')).toEqual([2, 0, 1])
    })

    it('filters and counts morph and through relations', async () => {
      const { Owner, Note, Tag } = await openDecimalOwnerFixtures(driver)

      expect(valuesOf(await Owner.has('notes').orderBy('code').get(), 'name')).toEqual(['first', 'second'])
      expect(valuesOf(await Owner.withCount('notes').orderBy('code').get(), 'notes_count')).toEqual([2, 0, 1])
      expect(valuesOf(await Note.has('noteable').orderBy('id').get())).toEqual([10, 11, 20])
      expect(valuesOf(await Note.whereDoesntHave('noteable').orderBy('id').get())).toEqual([30])
      expect(valuesOf(await Owner.has('morphTags').orderBy('code').get(), 'name')).toEqual(['first', 'second'])
      expect(valuesOf(await Tag.has('morphOwners').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Tag.withCount('morphOwners').orderBy('id').get(), 'morphOwners_count')).toEqual([1, 2, 0])
      expect(valuesOf(await Owner.has('parts').orderBy('code').get(), 'name')).toEqual(['first', 'second'])
      expect(valuesOf(await Owner.withCount('parts').orderBy('code').get(), 'parts_count')).toEqual([2, 0, 1])
    })
  })

  describe('with text morph ids pointing at an integer key type', () => {
    async function openTextMorphFixtures() {
      const { schema } = await openDatabase(driver)
      onTestFinished(() => resetDB())
      const tag = suffix()
      const names = { owners: `fm_owners_${tag}`, notes: `fm_notes_${tag}` }
      await createTable(schema, names.owners, (table) => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      await createTable(schema, names.notes, (table) => {
        table.integer('id').primaryKey()
        table.string('noteable_type')
        table.string('noteable_id')
      })
      const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey(), name: column.string() })
      const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: column.string() })
      const ownerType = `FmOwner${tag}`
      await DB.table(owners).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }, { id: 3, name: 'third' }])
      await DB.table(notes).insert([
        { id: 10, noteable_type: ownerType, noteable_id: '1' },
        { id: 20, noteable_type: ownerType, noteable_id: '3.0' },
        { id: 30, noteable_type: ownerType, noteable_id: 'abc' },
        { id: 40, noteable_type: ownerType, noteable_id: '1.5' },
        { id: 50, noteable_type: ownerType, noteable_id: '99999999999999999999999' },
        { id: 60, noteable_type: ownerType, noteable_id: '2' },
        { id: 70, noteable_type: ownerType, noteable_id: '2x' },
        { id: 80, noteable_type: ownerType, noteable_id: '1\n' },
        { id: 90, noteable_type: ownerType, noteable_id: '３' },
        ...(driver === 'postgres' ? [] : [{ id: 100, noteable_type: ownerType, noteable_id: '1\u0000abc' }]),
      ])
      const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
      const Owner = defineModel(owners, { morphClass: ownerType, timestamps: false, relations: { notes: morphMany(() => Note, 'noteable') } })
      return { Owner, Note }
    }

    it('matches text ids by integral value and integer keys by exact text, as eager loading does', async () => {
      const { Owner, Note } = await openTextMorphFixtures()

      const loaded = await Note.with('noteable').orderBy('id').get()

      expect(loaded.map(note => (note.getRelation<Loaded | null>('noteable') ?? undefined)?.get('name' as never))).toEqual(['first', 'third', undefined, undefined, undefined, 'second', undefined, undefined, undefined, ...(driver === 'postgres' ? [] : [undefined])])
      expect(valuesOf(await Note.has('noteable').orderBy('id').get())).toEqual([10, 20, 60])
      expect(valuesOf(await Note.whereDoesntHave('noteable').orderBy('id').get())).toEqual([30, 40, 50, 70, 80, 90, ...(driver === 'postgres' ? [] : [100])])
      expect(valuesOf(await Note.withCount('noteable').orderBy('id').get(), 'noteable_count')).toEqual([1, 1, 0, 0, 0, 1, 0, 0, 0, ...(driver === 'postgres' ? [] : [0])])
      expect((await Owner.with('notes').orderBy('id').get()).map(owner => valuesOf(owner.getRelation<Loaded[]>('notes') ?? []))).toEqual([[10], [60], []])
      expect(valuesOf(await Owner.has('notes').orderBy('id').get())).toEqual([1, 2])
      expect(valuesOf(await Owner.whereDoesntHave('notes').orderBy('id').get())).toEqual([3])
      expect(valuesOf(await Owner.withCount('notes').orderBy('id').get(), 'notes_count')).toEqual([1, 1, 0])
    })
  })

  it.runIf(driver === 'sqlite')('matches 64-bit keys stored in integer columns and nothing beyond them', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `fw_owners_${tag}`, codes: `fw_codes_${tag}`, items: `fw_items_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
    })
    await createTable(schema, names.codes, (table) => {
      table.integer('id').primaryKey()
      table.bigInteger('code')
    })
    await createTable(schema, names.items, (table) => {
      table.integer('id').primaryKey()
      table.string('owner_id')
      table.string('owner_code')
    })
    const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey(), name: column.string() })
    const codes = defineGeneratedTable(names.codes, { id: column.integer().primaryKey(), code: column.bigInteger() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_id: column.string(), owner_code: column.string() })
    await DB.table(owners).insert([{ id: 3000000000, name: 'wide' }])
    await DB.table(codes).insert([{ id: 1, code: '-9223372036854775808' }])
    await DB.table(items).insert([{ id: 10, owner_id: '3000000000', owner_code: '-9223372036854775808' }, { id: 20, owner_id: '1', owner_code: '-9223372036854775809' }])
    const Owner = defineModel(owners, { timestamps: false })
    const Code = defineModel(codes, { timestamps: false })
    const Item = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_id'), coded: belongsTo(() => Code, 'owner_code', 'code') } })

    const loaded = await Item.with('owner').orderBy('id').get()

    expect(loaded.map(item => item.getRelation<Loaded | null>('owner')?.get('name' as never))).toEqual(['wide', undefined])
    expect(valuesOf(await Item.has('owner').get())).toEqual([10])
    expect(valuesOf(await Item.has('coded').get())).toEqual([10])
  })

  it.runIf(driver === 'postgres')('matches nothing for a text key too long for a number', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `fl_owners_${tag}`, items: `fl_items_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.bigInteger('id').primaryKey()
    })
    await createTable(schema, names.items, (table) => {
      table.integer('id').primaryKey()
      table.text('owner_id')
    })
    const owners = defineGeneratedTable(names.owners, { id: column.bigInteger().primaryKey() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_id: column.text() })
    await DB.table(owners).insert([{ id: 1 }])
    await DB.table(items).insert([{ id: 10, owner_id: '1' }, { id: 20, owner_id: '9'.repeat(131073) }])
    const Owner = defineModel(owners, { timestamps: false })
    const Item = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_id') } })

    expect(valuesOf(await Item.has('owner').orderBy('id').get())).toEqual([10])
    expect(valuesOf(await Item.whereDoesntHave('owner').orderBy('id').get())).toEqual([20])
  })
})
