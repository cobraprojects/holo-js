import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, hasManyThrough, hasOneThrough, latestMorphOne, morphMany, morphOne, morphTo, morphToMany, morphedByMany, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

type KeyKind = 'decimal' | 'text'
type Driver = 'sqlite' | 'postgres' | 'mysql'
type Loaded = Entity<TableDefinition>

function relation<TRelation>(entity: { getRelation<T>(name: string): T | undefined } | undefined, name: string): TRelation {
  if (!entity) throw new Error(`expected a loaded parent before reading ${name}`)
  return entity.getRelation<TRelation>(name) as TRelation
}

function ids(entities: readonly Loaded[]): number[] {
  return entities.map(entity => entity.get('id' as never) as number).sort((left, right) => left - right)
}

function suffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

async function openKeyFixtures(driver: Driver, kind: KeyKind) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = suffix()
  const names = { owners: `mk_owners_${tag}`, notes: `mk_notes_${tag}`, tags: `mk_tags_${tag}`, taggables: `mk_taggables_${tag}`, items: `mk_items_${tag}`, parts: `mk_parts_${tag}` }
  const keyColumn = (table: Parameters<Parameters<typeof schema.createTable>[1]>[0], name: string) => kind === 'decimal' ? table.decimal(name) : table.string(name)
  const keyDefinition = () => kind === 'decimal' ? column.decimal() : column.string()
  await schema.createTable(names.owners, (table) => {
    table.bigInteger('id').primaryKey()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.owners))
  await schema.createTable(names.notes, (table) => {
    table.integer('id').primaryKey()
    table.string('noteable_type')
    keyColumn(table, 'noteable_id')
  })
  onTestFinished(() => schema.dropTable(names.notes))
  await schema.createTable(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.tags))
  await schema.createTable(names.taggables, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'tag_id')
    table.string('taggable_type')
    keyColumn(table, 'taggable_id')
  })
  onTestFinished(() => schema.dropTable(names.taggables))
  await schema.createTable(names.items, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'owner_id')
  })
  onTestFinished(() => schema.dropTable(names.items))
  await schema.createTable(names.parts, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, 'item_id')
  })
  onTestFinished(() => schema.dropTable(names.parts))

  const owners = defineGeneratedTable(names.owners, { id: column.bigInteger().primaryKey(), name: column.string() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: keyDefinition() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), name: column.string() })
  const taggables = defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_id: keyDefinition(), taggable_type: column.string(), taggable_id: keyDefinition() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_id: keyDefinition() })
  const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_id: keyDefinition() })
  const key = (value: number) => kind === 'decimal' ? `${value}.00` : String(value)
  const ownerType = `MkOwner${tag}`

  await DB.table(owners).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }, { id: 3, name: 'empty' }])
  await DB.table(notes).insert([
    { id: 10, noteable_type: ownerType, noteable_id: key(1) },
    { id: 11, noteable_type: ownerType, noteable_id: key(1) },
    { id: 20, noteable_type: ownerType, noteable_id: key(2) },
    { id: 30, noteable_type: ownerType, noteable_id: '1.50' },
  ])
  await DB.table(tags).insert([{ id: 1, name: 'red' }, { id: 2, name: 'blue' }])
  await DB.table(taggables).insert([
    { id: 1, tag_id: key(1), taggable_type: ownerType, taggable_id: key(1) },
    { id: 2, tag_id: key(2), taggable_type: ownerType, taggable_id: key(1) },
    { id: 3, tag_id: key(2), taggable_type: ownerType, taggable_id: key(2) },
    { id: 4, tag_id: '1.50', taggable_type: ownerType, taggable_id: key(2) },
    { id: 5, tag_id: key(1), taggable_type: ownerType, taggable_id: '1.50' },
  ])
  await DB.table(items).insert([{ id: 10, owner_id: key(1) }, { id: 11, owner_id: key(1) }, { id: 20, owner_id: key(2) }, { id: 30, owner_id: '1.50' }])
  await DB.table(parts).insert([{ id: 100, item_id: key(10) }, { id: 101, item_id: key(11) }, { id: 200, item_id: key(20) }, { id: 300, item_id: key(30) }, { id: 999, item_id: '10.50' }])

  const Item = defineModel(items, { timestamps: false })
  const Part = defineModel(parts, { timestamps: false })
  const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(owners, {
    morphClass: ownerType,
    timestamps: false,
    relations: {
      notes: morphMany(() => Note, 'noteable'),
      note: morphOne(() => Note, 'noteable'),
      latestNote: latestMorphOne(() => Note, 'noteable'),
      tags: morphToMany(() => Tag, 'taggable', taggables, 'tag_id'),
      parts: hasManyThrough(() => Part, () => Item, 'owner_id', 'item_id'),
      part: hasOneThrough(() => Part, () => Item, 'owner_id', 'item_id'),
    },
  })
  const TagWithOwners = defineModel(tags, { timestamps: false, relations: { owners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_id') } })
  return { Owner, Note, Tag: TagWithOwners }
}

async function openDecimalOwnerFixtures(driver: Driver) {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = suffix()
  const names = { owners: `md_owners_${tag}`, notes: `md_notes_${tag}`, tags: `md_tags_${tag}`, taggables: `md_taggables_${tag}`, items: `md_items_${tag}`, parts: `md_parts_${tag}` }
  await schema.createTable(names.owners, (table) => {
    table.decimal('code').primaryKey()
    table.string('name')
  })
  onTestFinished(() => schema.dropTable(names.owners))
  await schema.createTable(names.notes, (table) => {
    table.integer('id').primaryKey()
    table.string('noteable_type')
    table.integer('noteable_id')
  })
  onTestFinished(() => schema.dropTable(names.notes))
  await schema.createTable(names.tags, (table) => {
    table.integer('id').primaryKey()
    table.decimal('code')
  })
  onTestFinished(() => schema.dropTable(names.tags))
  await schema.createTable(names.taggables, (table) => {
    table.integer('id').primaryKey()
    table.integer('tag_code')
    table.string('taggable_type')
    table.integer('taggable_id')
  })
  onTestFinished(() => schema.dropTable(names.taggables))
  await schema.createTable(names.items, (table) => {
    table.integer('id').primaryKey()
    table.integer('owner_code')
    table.decimal('code')
  })
  onTestFinished(() => schema.dropTable(names.items))
  await schema.createTable(names.parts, (table) => {
    table.integer('id').primaryKey()
    table.integer('item_code')
  })
  onTestFinished(() => schema.dropTable(names.parts))

  const owners = defineGeneratedTable(names.owners, { code: column.decimal().primaryKey(), name: column.string() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: column.integer() })
  const tags = defineGeneratedTable(names.tags, { id: column.integer().primaryKey(), code: column.decimal() })
  const taggables = defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_code: column.integer(), taggable_type: column.string(), taggable_id: column.integer() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), owner_code: column.integer(), code: column.decimal() })
  const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_code: column.integer() })
  const ownerType = `MdOwner${tag}`

  await DB.table(owners).insert([{ code: '5.00', name: 'first' }, { code: '5.50', name: 'fractional' }, { code: '6.00', name: 'second' }])
  await DB.table(notes).insert([
    { id: 10, noteable_type: ownerType, noteable_id: 5 },
    { id: 11, noteable_type: ownerType, noteable_id: 5 },
    { id: 20, noteable_type: ownerType, noteable_id: 6 },
  ])
  await DB.table(tags).insert([{ id: 1, code: '7.00' }, { id: 2, code: '8.00' }, { id: 3, code: '7.50' }])
  await DB.table(taggables).insert([
    { id: 1, tag_code: 7, taggable_type: ownerType, taggable_id: 5 },
    { id: 2, tag_code: 8, taggable_type: ownerType, taggable_id: 5 },
    { id: 3, tag_code: 8, taggable_type: ownerType, taggable_id: 6 },
  ])
  await DB.table(items).insert([{ id: 10, owner_code: 5, code: '50.00' }, { id: 11, owner_code: 5, code: '51.00' }, { id: 20, owner_code: 6, code: '60.00' }, { id: 21, owner_code: 6, code: '60.50' }])
  await DB.table(parts).insert([{ id: 100, item_code: 50 }, { id: 101, item_code: 51 }, { id: 200, item_code: 60 }])

  const Item = defineModel(items, { timestamps: false })
  const Part = defineModel(parts, { timestamps: false })
  const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
  const Tag = defineModel(tags, { timestamps: false })
  const Owner = defineModel(owners, {
    morphClass: ownerType,
    primaryKey: 'code',
    timestamps: false,
    relations: {
      notes: morphMany(() => Note, 'noteable', 'noteable_type', 'noteable_id', 'code'),
      latestNote: latestMorphOne(() => Note, 'noteable', 'id', 'noteable_type', 'noteable_id', 'code'),
      tags: morphToMany(() => Tag, 'taggable', taggables, 'tag_code', 'code', 'code'),
      parts: hasManyThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
      part: hasOneThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
    },
  })
  const TagWithOwners = defineModel(tags, { timestamps: false, relations: { owners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_code', 'code', 'code') } })
  return { Owner, Note, Tag: TagWithOwners }
}

function codes(entities: readonly Loaded[]): string[] {
  return entities.map(entity => entity.get('name' as never) as string).sort()
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('morph and through relation keys across numeric column kinds on %s', (driver) => {
  describe.each(['decimal', 'text'] as const)('with %s keys to a bigint id', (kind) => {
    it('eager loads morphMany, morphOne and latestMorphOne', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('notes', 'note', 'latestNote').orderBy('id').get()

      expect(ids(relation(first, 'notes'))).toEqual([10, 11])
      expect(ids(relation(second, 'notes'))).toEqual([20])
      expect(relation(empty, 'notes')).toEqual([])
      expect([10, 11]).toContain(relation<Loaded>(first, 'note').get('id' as never))
      expect(relation<Loaded>(second, 'note').get('id' as never)).toBe(20)
      expect(relation(empty, 'note')).toBeNull()
      expect(relation<Loaded>(first, 'latestNote').get('id' as never)).toBe(11)
      expect(relation<Loaded>(second, 'latestNote').get('id' as never)).toBe(20)
      expect(relation(empty, 'latestNote')).toBeNull()
    })

    it('eager loads morphTo', async () => {
      const { Note } = await openKeyFixtures(driver, kind)

      const notes = await Note.with('noteable').orderBy('id').get()

      expect(notes.map(note => relation<Loaded | null>(note, 'noteable')?.get('name' as never))).toEqual(['first', 'first', 'second', undefined])
    })

    it('eager loads morphToMany and morphedByMany', async () => {
      const { Owner, Tag } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('tags').orderBy('id').get()
      const [red, blue] = await Tag.with('owners').orderBy('id').get()

      expect(ids(relation(first, 'tags'))).toEqual([1, 2])
      expect(ids(relation(second, 'tags'))).toEqual([2])
      expect(relation(empty, 'tags')).toEqual([])
      expect(codes(relation(red, 'owners'))).toEqual(['first'])
      expect(codes(relation(blue, 'owners'))).toEqual(['first', 'second'])
    })

    it('eager loads hasManyThrough and hasOneThrough', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const [first, second, empty] = await Owner.with('parts', 'part').orderBy('id').get()

      expect(ids(relation(first, 'parts'))).toEqual([100, 101])
      expect(ids(relation(second, 'parts'))).toEqual([200])
      expect(relation(empty, 'parts')).toEqual([])
      expect([100, 101]).toContain(relation<Loaded>(first, 'part').get('id' as never))
      expect(relation<Loaded>(second, 'part').get('id' as never)).toBe(200)
      expect(relation(empty, 'part')).toBeNull()
    })

    it('counts morph and through relations of loaded models', async () => {
      const { Owner, Note, Tag } = await openKeyFixtures(driver, kind)

      const owners = await (await Owner.orderBy('id').get()).loadCount('notes', 'tags', 'parts')
      const notes = await (await Note.orderBy('id').get()).loadCount('noteable')
      const tags = await (await Tag.orderBy('id').get()).loadCount('owners')

      expect(owners.map(owner => [owner.get('notes_count' as never), owner.get('tags_count' as never), owner.get('parts_count' as never)])).toEqual([[2, 2, 2], [1, 1, 1], [0, 0, 0]])
      expect(notes.map(note => note.get('noteable_count' as never))).toEqual([1, 1, 1, 0])
      expect(tags.map(item => item.get('owners_count' as never))).toEqual([1, 2])
    })

    it('filters by morph and through relation existence', async () => {
      const { Owner } = await openKeyFixtures(driver, kind)

      const withNotes = await (await Owner.orderBy('id').get()).loadExists('notes', 'tags', 'parts')

      expect(withNotes.map(owner => [owner.get('notes_exists' as never), owner.get('tags_exists' as never), owner.get('parts_exists' as never)])).toEqual([[true, true, true], [true, true, true], [false, false, false]])
    })
  })

  describe('with integer keys referencing decimal keys', () => {
    it('eager loads morphMany and latestMorphOne from a decimal local key', async () => {
      const { Owner } = await openDecimalOwnerFixtures(driver)

      const [first, fractional, second] = await Owner.with('notes', 'latestNote').orderBy('code').get()

      expect(ids(relation(first, 'notes'))).toEqual([10, 11])
      expect(relation(fractional, 'notes')).toEqual([])
      expect(ids(relation(second, 'notes'))).toEqual([20])
      expect(relation<Loaded>(first, 'latestNote').get('id' as never)).toBe(11)
      expect(relation(fractional, 'latestNote')).toBeNull()
      expect(relation<Loaded>(second, 'latestNote').get('id' as never)).toBe(20)
    })

    it('eager loads morphTo to a decimal primary key', async () => {
      const { Note } = await openDecimalOwnerFixtures(driver)

      const notes = await Note.with('noteable').orderBy('id').get()

      expect(notes.map(note => relation<Loaded | null>(note, 'noteable')?.get('name' as never))).toEqual(['first', 'first', 'second'])
    })

    it('eager loads morphToMany and morphedByMany through integer pivot columns', async () => {
      const { Owner, Tag } = await openDecimalOwnerFixtures(driver)

      const [first, fractional, second] = await Owner.with('tags').orderBy('code').get()
      const [seven, eight, fractionalTag] = await Tag.with('owners').orderBy('id').get()

      expect(ids(relation(first, 'tags'))).toEqual([1, 2])
      expect(relation(fractional, 'tags')).toEqual([])
      expect(ids(relation(second, 'tags'))).toEqual([2])
      expect(codes(relation(seven, 'owners'))).toEqual(['first'])
      expect(codes(relation(eight, 'owners'))).toEqual(['first', 'second'])
      expect(relation(fractionalTag, 'owners')).toEqual([])
    })

    it('eager loads hasManyThrough and hasOneThrough across decimal local keys', async () => {
      const { Owner } = await openDecimalOwnerFixtures(driver)

      const [first, fractional, second] = await (await Owner.with('parts', 'part').orderBy('code').get()).loadCount('parts')

      expect(ids(relation(first, 'parts'))).toEqual([100, 101])
      expect(relation(fractional, 'parts')).toEqual([])
      expect(ids(relation(second, 'parts'))).toEqual([200])
      expect(relation(fractional, 'part')).toBeNull()
      expect(relation<Loaded>(second, 'part').get('id' as never)).toBe(200)
      expect([first, fractional, second].map(owner => owner?.get('parts_count' as never))).toEqual([2, 0, 1])
    })
  })

  it('loads the morph one-of-many row whose text key is the exact integer text', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `ml_owners_${tag}`, notes: `ml_notes_${tag}` }
    await schema.createTable(names.owners, (table) => {
      table.integer('id').primaryKey()
    })
    onTestFinished(() => schema.dropTable(names.owners))
    await schema.createTable(names.notes, (table) => {
      table.integer('id').primaryKey()
      table.string('noteable_type')
      table.string('noteable_id')
    })
    onTestFinished(() => schema.dropTable(names.notes))
    const owners = defineGeneratedTable(names.owners, { id: column.integer().primaryKey() })
    const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: column.string() })
    const ownerType = `MlOwner${tag}`
    await DB.table(owners).insert([{ id: 1 }])
    await DB.table(notes).insert([{ id: 10, noteable_type: ownerType, noteable_id: '1' }, { id: 20, noteable_type: ownerType, noteable_id: '1.00' }])
    const Note = defineModel(notes, { timestamps: false })
    const Owner = defineModel(owners, { morphClass: ownerType, timestamps: false, relations: { latestNote: latestMorphOne(() => Note, 'noteable') } })

    const [owner] = await Owner.with('latestNote').get()
    expect(relation<Loaded>(owner, 'latestNote').get('id' as never)).toBe(10)
  })

  it('keeps distinct numeric-looking text keys apart for morph and through relations', async () => {
    const { schema } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `mt_owners_${tag}`, notes: `mt_notes_${tag}`, items: `mt_items_${tag}`, parts: `mt_parts_${tag}`, tags: `mt_tags_${tag}`, taggables: `mt_taggables_${tag}` }
    await schema.createTable(names.owners, (table) => {
      table.string('code').primaryKey()
    })
    onTestFinished(() => schema.dropTable(names.owners))
    await schema.createTable(names.notes, (table) => {
      table.integer('id').primaryKey()
      table.string('noteable_type')
      table.string('noteable_id')
    })
    onTestFinished(() => schema.dropTable(names.notes))
    await schema.createTable(names.items, (table) => {
      table.string('code').primaryKey()
      table.string('owner_code')
    })
    onTestFinished(() => schema.dropTable(names.items))
    await schema.createTable(names.parts, (table) => {
      table.integer('id').primaryKey()
      table.string('item_code')
    })
    onTestFinished(() => schema.dropTable(names.parts))
    await schema.createTable(names.tags, (table) => {
      table.string('code').primaryKey()
    })
    onTestFinished(() => schema.dropTable(names.tags))
    await schema.createTable(names.taggables, (table) => {
      table.integer('id').primaryKey()
      table.string('tag_code')
      table.string('taggable_type')
      table.string('taggable_id')
    })
    onTestFinished(() => schema.dropTable(names.taggables))
    const owners = defineGeneratedTable(names.owners, { code: column.string().primaryKey() })
    const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), noteable_type: column.string(), noteable_id: column.string() })
    const items = defineGeneratedTable(names.items, { code: column.string().primaryKey(), owner_code: column.string() })
    const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_code: column.string() })
    const tags = defineGeneratedTable(names.tags, { code: column.string().primaryKey() })
    const taggables = defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_code: column.string(), taggable_type: column.string(), taggable_id: column.string() })
    const ownerType = `MtOwner${tag}`
    await DB.table(owners).insert([{ code: '1' }, { code: '1.0' }])
    await DB.table(notes).insert([{ id: 10, noteable_type: ownerType, noteable_id: '1' }, { id: 20, noteable_type: ownerType, noteable_id: '1.0' }])
    await DB.table(items).insert([{ code: '2', owner_code: '1' }, { code: '2.0', owner_code: '1.0' }])
    await DB.table(parts).insert([{ id: 100, item_code: '2' }, { id: 200, item_code: '2.0' }])
    await DB.table(tags).insert([{ code: '3' }, { code: '3.0' }])
    await DB.table(taggables).insert([{ id: 1, tag_code: '3', taggable_type: ownerType, taggable_id: '1' }, { id: 2, tag_code: '3.0', taggable_type: ownerType, taggable_id: '1.0' }])
    const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
    const Tag = defineModel(tags, { primaryKey: 'code', timestamps: false })
    const Item = defineModel(items, { primaryKey: 'code', timestamps: false })
    const Part = defineModel(parts, { timestamps: false })
    const Owner = defineModel(owners, {
      morphClass: ownerType,
      primaryKey: 'code',
      timestamps: false,
      relations: {
        notes: morphMany(() => Note, 'noteable', 'noteable_type', 'noteable_id', 'code'),
        parts: hasManyThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
        part: hasOneThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
        tags: morphToMany(() => Tag, 'taggable', taggables, 'tag_code', 'code', 'code'),
      },
    })
    const TagWithOwners = defineModel(tags, { primaryKey: 'code', timestamps: false, relations: { owners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_code', 'code', 'code') } })
    const keysOf = (entities: readonly Loaded[]) => entities.map(entity => entity.get('code' as never))

    const loaded = await Owner.with('notes', 'parts', 'part', 'tags').orderBy('code').get()
    const loadedNotes = await Note.with('noteable').orderBy('id').get()
    const loadedTags = await TagWithOwners.with('owners').orderBy('code').get()

    expect(loaded.map(owner => ids(relation(owner, 'notes')))).toEqual([[10], [20]])
    expect(loaded.map(owner => ids(relation(owner, 'parts')))).toEqual([[100], [200]])
    expect(loaded.map(owner => relation<Loaded>(owner, 'part').get('id' as never))).toEqual([100, 200])
    expect(loaded.map(owner => keysOf(relation(owner, 'tags')))).toEqual([['3'], ['3.0']])
    expect(loadedNotes.map(note => relation<Loaded>(note, 'noteable').get('code' as never))).toEqual(['1', '1.0'])
    expect(loadedTags.map(item => keysOf(relation(item, 'owners')))).toEqual([['1'], ['1.0']])
  })
})
