import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { DB, belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasManyThrough, hasOne, hasOneThrough, morphMany, morphOne, morphTo, morphToMany, morphedByMany, resetDB, type Entity, type TableDefinition } from '../src'
import { integrationDrivers, mysqlTestConnection, openDatabase } from './support/database'

type Driver = 'sqlite' | 'postgres' | 'mysql'
type KeyKind = 'decimal' | 'text' | 'integer'
type Loaded = Entity<TableDefinition>
type Schema = Awaited<ReturnType<typeof openDatabase>>['schema']
type Blueprint = Parameters<Parameters<Schema['createTable']>[1]>[0]
type FilterableModel = {
  query(): {
    with(relation: string): { orderBy(column: string): { get(): Promise<readonly Loaded[]> } }
    has(relation: string): { orderBy(column: string): { get(): Promise<readonly Loaded[]> } }
    whereHas(relation: string, constraint: (query: unknown) => unknown): { orderBy(column: string): { get(): Promise<readonly Loaded[]> } }
    whereDoesntHave(relation: string): { orderBy(column: string): { get(): Promise<readonly Loaded[]> } }
    withCount(relation: string): { orderBy(column: string): { get(): Promise<readonly Loaded[]> } }
  }
}

function suffix(): string {
  return randomUUID().replaceAll('-', '').slice(0, 12)
}

function valuesOf(entities: readonly { get(attribute: never): unknown }[], attribute = 'name'): unknown[] {
  return entities.map(entity => entity.get(attribute as never))
}

async function createTable(schema: Schema, name: string, callback: (table: Blueprint) => void) {
  await schema.createTable(name, callback)
  onTestFinished(() => schema.dropTable(name))
}

function keyColumn(table: Blueprint, kind: KeyKind, name: string) {
  if (kind === 'decimal') return table.decimal(name)
  if (kind === 'integer') return table.bigInteger(name)
  return table.string(name)
}

function keyDefinition(kind: KeyKind) {
  if (kind === 'decimal') return column.decimal()
  if (kind === 'integer') return column.bigInteger()
  return column.string()
}

type FilterResults = { readonly has: unknown[], readonly whereHas: unknown[], readonly whereDoesntHave: unknown[], readonly counts: number[] }

async function readFilters(model: unknown, relation: string): Promise<FilterResults> {
  const query = () => (model as FilterableModel).query()
  return {
    has: valuesOf(await query().has(relation).orderBy('name').get()),
    whereHas: valuesOf(await query().whereHas(relation, constrained => constrained).orderBy('name').get()),
    whereDoesntHave: valuesOf(await query().whereDoesntHave(relation).orderBy('name').get()),
    counts: valuesOf(await query().withCount(relation).orderBy('name').get(), `${relation}_count`).map(Number),
  }
}

async function expectFiltersMatchEagerLoading(model: unknown, relation: string, expected: readonly string[], filters?: FilterResults) {
  const filtered = filters ?? await readFilters(model, relation)
  const loaded = await (model as FilterableModel).query().with(relation).orderBy('name').get()
  const eagerCounts = loaded.map((entity) => {
    const value = entity.getRelation<Loaded | readonly Loaded[] | null>(relation)
    return Array.isArray(value) ? value.length : value ? 1 : 0
  })
  const names = valuesOf(loaded)

  expect(names.filter((_, index) => eagerCounts[index]! > 0)).toEqual(expected)
  expect(filtered.has).toEqual(expected)
  expect(filtered.whereHas).toEqual(expected)
  expect(filtered.whereDoesntHave).toEqual(names.filter((_, index) => eagerCounts[index] === 0))
  expect(filtered.counts).toEqual(eagerCounts)
}

type Scenario = {
  readonly parentKind: KeyKind
  readonly childKind: KeyKind
  readonly parentKeys: readonly string[]
  readonly childKeys: readonly string[]
}

type PivotSpelling = 'registered' | 'unregistered' | 'qualified'

function pivotQualifier(driver: Driver): string {
  if (driver === 'postgres') return 'public'
  if (driver === 'mysql') return mysqlTestConnection().database
  return 'main'
}

async function openScenario(driver: Driver, scenario: Scenario, spelling: PivotSpelling = 'registered') {
  const { schema } = await openDatabase(driver)
  onTestFinished(() => resetDB())
  const tag = suffix()
  const names = { owners: `dt_owners_${tag}`, items: `dt_items_${tag}`, parts: `dt_parts_${tag}`, tags: `dt_tags_${tag}`, pivot: `dt_owner_tags_${tag}`, notes: `dt_notes_${tag}`, taggables: `dt_taggables_${tag}` }
  const { parentKind, childKind, parentKeys, childKeys } = scenario
  await createTable(schema, names.owners, (table) => {
    keyColumn(table, parentKind, 'code').primaryKey()
    table.string('name')
  })
  await createTable(schema, names.items, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
    keyColumn(table, childKind, 'owner_code')
    keyColumn(table, parentKind, 'code')
  })
  await createTable(schema, names.parts, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, childKind, 'item_code')
  })
  await createTable(schema, names.tags, (table) => {
    keyColumn(table, parentKind, 'code').primaryKey()
    table.string('name')
  })
  await createTable(schema, names.pivot, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, childKind, 'owner_code')
    keyColumn(table, childKind, 'tag_code')
  })
  await createTable(schema, names.notes, (table) => {
    table.integer('id').primaryKey()
    table.string('name')
    table.string('noteable_type')
    keyColumn(table, childKind, 'noteable_id')
  })
  await createTable(schema, names.taggables, (table) => {
    table.integer('id').primaryKey()
    keyColumn(table, childKind, 'tag_code')
    table.string('taggable_type')
    keyColumn(table, childKind, 'taggable_id')
  })

  const owners = defineGeneratedTable(names.owners, { code: keyDefinition(parentKind).primaryKey(), name: column.string() })
  const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), name: column.string(), owner_code: keyDefinition(childKind), code: keyDefinition(parentKind) })
  const parts = defineGeneratedTable(names.parts, { id: column.integer().primaryKey(), item_code: keyDefinition(childKind) })
  const tags = defineGeneratedTable(names.tags, { code: keyDefinition(parentKind).primaryKey(), name: column.string() })
  const notes = defineGeneratedTable(names.notes, { id: column.integer().primaryKey(), name: column.string(), noteable_type: column.string(), noteable_id: keyDefinition(childKind) })
  const registeredPivot = spelling === 'unregistered' ? undefined : defineGeneratedTable(names.pivot, { id: column.integer().primaryKey(), owner_code: keyDefinition(childKind), tag_code: keyDefinition(childKind) })
  const registeredTaggables = spelling === 'unregistered' ? undefined : defineGeneratedTable(names.taggables, { id: column.integer().primaryKey(), tag_code: keyDefinition(childKind), taggable_type: column.string(), taggable_id: keyDefinition(childKind) })
  const pivot = spelling === 'registered' ? registeredPivot! : spelling === 'qualified' ? `${pivotQualifier(driver)}.${names.pivot}` : names.pivot
  const taggables = spelling === 'registered' ? registeredTaggables! : spelling === 'qualified' ? `${pivotQualifier(driver)}.${names.taggables}` : names.taggables
  const ownerType = `DtOwner${tag}`

  await DB.table(owners).insert(parentKeys.map((code, index) => ({ code, name: `owner ${index}` })))
  await DB.table(tags).insert(parentKeys.map((code, index) => ({ code, name: `tag ${index}` })))
  await DB.table(items).insert(childKeys.map((ownerCode, index) => ({ id: index + 1, name: `item ${index}`, owner_code: ownerCode, code: parentKeys[index % parentKeys.length] })))
  await DB.table(parts).insert(childKeys.map((itemCode, index) => ({ id: index + 1, item_code: itemCode })))
  await DB.table(names.pivot).insert(childKeys.map((code, index) => ({ id: index + 1, owner_code: code, tag_code: code })))
  await DB.table(notes).insert(childKeys.map((code, index) => ({ id: index + 1, name: `note ${index}`, noteable_type: ownerType, noteable_id: code })))
  await DB.table(names.taggables).insert(childKeys.map((code, index) => ({ id: index + 1, tag_code: code, taggable_type: ownerType, taggable_id: code })))

  const Part = defineModel(parts, { timestamps: false })
  const Item = defineModel(items, { timestamps: false })
  const Tag = defineModel(tags, { primaryKey: 'code', timestamps: false })
  const Note = defineModel(notes, { timestamps: false, relations: { noteable: morphTo('noteable') } })
  const Owner = defineModel(owners, {
    morphClass: ownerType,
    primaryKey: 'code',
    fillable: ['name'],
    timestamps: false,
    relations: {
      items: hasMany(() => Item, 'owner_code', 'code'),
      item: hasOne(() => Item, 'owner_code', 'code'),
      tags: belongsToMany(() => Tag, pivot, 'owner_code', 'tag_code', 'code', 'code'),
      notes: morphMany(() => Note, 'noteable', 'noteable_type', 'noteable_id', 'code'),
      note: morphOne(() => Note, 'noteable', 'noteable_type', 'noteable_id', 'code'),
      morphTags: morphToMany(() => Tag, 'taggable', taggables, 'tag_code', 'code', 'code'),
      parts: hasManyThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
      part: hasOneThrough(() => Part, () => Item, 'owner_code', 'item_code', 'code', 'code'),
    },
  })
  const TagWithOwners = defineModel(tags, {
    primaryKey: 'code',
    timestamps: false,
    relations: {
      owners: belongsToMany(() => Owner, pivot, 'tag_code', 'owner_code', 'code', 'code'),
      morphOwners: morphedByMany(() => Owner, 'taggable', taggables, 'tag_code', 'code', 'code'),
    },
  })
  const ItemWithOwner = defineModel(items, { fillable: ['name'], timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })
  return { Owner, Tag: TagWithOwners, Note, Item: ItemWithOwner }
}

const decimalParents: Scenario = {
  parentKind: 'decimal',
  childKind: 'text',
  parentKeys: ['5.00', '5.50', '6.00', '7.00'],
  childKeys: ['5.00', '5', '5.5', '6.000', 'abc', '05.00', '5.50'],
}

const textParents: Scenario = {
  parentKind: 'text',
  childKind: 'decimal',
  parentKeys: ['5', '5.50', '6.000', 'abc', '05.00', '7.00'],
  childKeys: ['5.00', '5.50', '6.00', '8.00'],
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation filters between decimal and text keys on %s', (driver) => {
  it('matches text keys by the decimal key text and decimal keys by the value of decimal key text', async () => {
    const { Owner, Item, Tag, Note } = await openScenario(driver, decimalParents)

    await expectFiltersMatchEagerLoading(Owner, 'items', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Owner, 'item', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Item, 'owner', ['item 0', 'item 1', 'item 2', 'item 3', 'item 6'])
    await expectFiltersMatchEagerLoading(Owner, 'tags', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Tag, 'owners', ['tag 0', 'tag 1'])
    await expectFiltersMatchEagerLoading(Owner, 'notes', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Owner, 'note', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Note, 'noteable', ['note 0', 'note 1', 'note 2', 'note 3', 'note 6'])
    await expectFiltersMatchEagerLoading(Owner, 'morphTags', ['owner 0', 'owner 1'])
    await expectFiltersMatchEagerLoading(Tag, 'morphOwners', ['tag 0', 'tag 1'])
    await expectFiltersMatchEagerLoading(Owner, 'parts', ['owner 0'])
    await expectFiltersMatchEagerLoading(Owner, 'part', ['owner 0'])
  })

  it('matches decimal keys against text parents by the decimal key text, and text parents against decimal keys by value', async () => {
    const { Owner, Item, Tag, Note } = await openScenario(driver, textParents)

    await expectFiltersMatchEagerLoading(Owner, 'items', ['owner 0', 'owner 1', 'owner 2'])
    await expectFiltersMatchEagerLoading(Owner, 'item', ['owner 0', 'owner 1', 'owner 2'])
    await expectFiltersMatchEagerLoading(Item, 'owner', ['item 1'])
    await expectFiltersMatchEagerLoading(Owner, 'tags', ['owner 1'])
    await expectFiltersMatchEagerLoading(Tag, 'owners', ['tag 1'])
    await expectFiltersMatchEagerLoading(Owner, 'notes', ['owner 0', 'owner 1', 'owner 2'])
    await expectFiltersMatchEagerLoading(Owner, 'note', ['owner 0', 'owner 1', 'owner 2'])
    await expectFiltersMatchEagerLoading(Note, 'noteable', ['note 1'])
    await expectFiltersMatchEagerLoading(Owner, 'morphTags', ['owner 1'])
    await expectFiltersMatchEagerLoading(Tag, 'morphOwners', ['tag 1'])
    await expectFiltersMatchEagerLoading(Owner, 'parts', ['owner 0', 'owner 1', 'owner 2'])
    await expectFiltersMatchEagerLoading(Owner, 'part', ['owner 0', 'owner 1', 'owner 2'])
    await Owner.query().has('items').update({ name: 'matched owner' })
    await Item.query().has('owner').update({ name: 'matched item' })
    expect(await Owner.query().where('name', 'matched owner').count()).toBe(3)
    expect(await Item.query().where('name', 'matched item').count()).toBe(1)
  })
})

describe('relation filters between decimal and text keys on sqlite', () => {
  it('matches decimal keys that need more than fifteen digits by the text eager loading reads back', async () => {
    const { schema } = await openDatabase('sqlite')
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `dl_owners_${tag}`, items: `dl_items_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.decimal('code').primaryKey()
      table.string('name')
    })
    await createTable(schema, names.items, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
      table.string('owner_code')
    })
    const owners = defineGeneratedTable(names.owners, { code: column.decimal().primaryKey(), name: column.string() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), name: column.string(), owner_code: column.string() })
    await DB.table(owners).insert([{ code: '1000000000000000.00', name: 'owner 0' }, { code: '123456789012345.50', name: 'owner 1' }, { code: '0.10', name: 'owner 2' }, { code: '0.25', name: 'owner 3' }, { code: '100000000000000000000.00', name: 'owner 4' }, { code: '0.30000000000000004', name: 'owner 5' }, { code: '0.0000001', name: 'owner 6' }, { code: '1000000000000000100000.00', name: 'owner 7' }, { code: '0.000000000000000000001', name: 'owner 8' }])
    await DB.table(items).insert(['1000000000000000.00', '123456789012345.50', '123456789012345.5', '0.1000000000000000055511151231257827', '0.1', '1000000000000000', '0.25000', '100000000000000000000.00', '0.30000000000000004', '0.3', '0.0000001', '1000000000000000100000.00', '0.000000000000000000001'].map((ownerCode, index) => ({ id: index + 1, name: `item ${index}`, owner_code: ownerCode })))
    const Item = defineModel(items, { timestamps: false })
    const Owner = defineModel(owners, { primaryKey: 'code', timestamps: false, relations: { items: hasMany(() => Item, 'owner_code', 'code') } })
    const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })

    await expectFiltersMatchEagerLoading(Owner, 'items', ['owner 0', 'owner 1', 'owner 4', 'owner 5', 'owner 6', 'owner 7', 'owner 8'])
    await expectFiltersMatchEagerLoading(ItemWithOwner, 'owner', ['item 0', 'item 1', 'item 10', 'item 11', 'item 12', 'item 2', 'item 4', 'item 5', 'item 6', 'item 7', 'item 8'])
  })
})

describe('relation filters from text keys to decimal keys on sqlite', () => {
  it('matches text that eager loading reads as the same decimal, at any precision or size', async () => {
    const { schema } = await openDatabase('sqlite')
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `dp_owners_${tag}`, items: `dp_items_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.string('code').primaryKey()
      table.string('name')
    })
    await createTable(schema, names.items, (table) => {
      table.integer('id').primaryKey()
      table.string('name')
      table.decimal('owner_code')
    })
    const owners = defineGeneratedTable(names.owners, { code: column.string().primaryKey(), name: column.string() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), name: column.string(), owner_code: column.decimal() })
    await DB.table(owners).insert(['1.234567890123456', '0.000000000000001', '10000000000000000000', '0.0000001', '1.2345678901234561', '9.99'].map((code, index) => ({ code, name: `owner ${index}` })))
    await DB.table(items).insert(['1.234567890123456', '0.000000000000001', '10000000000000000000', '0.0000001'].map((ownerCode, index) => ({ id: index + 1, name: `item ${index}`, owner_code: ownerCode })))
    const Item = defineModel(items, { timestamps: false })
    const Owner = defineModel(owners, { primaryKey: 'code', timestamps: false, relations: { items: hasMany(() => Item, 'owner_code', 'code') } })
    const ItemWithOwner = defineModel(items, { timestamps: false, relations: { owner: belongsTo(() => Owner, 'owner_code', 'code') } })

    await expectFiltersMatchEagerLoading(Owner, 'items', ['owner 0', 'owner 1', 'owner 2', 'owner 3'])
    await expectFiltersMatchEagerLoading(ItemWithOwner, 'owner', ['item 0', 'item 1', 'item 3'])
  })

  it('loads big integer keys from an unregistered pivot between text keys', async () => {
    const { schema } = await openDatabase('sqlite')
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `bp_owners_${tag}`, tags: `bp_tags_${tag}`, pivot: `bp_owner_tags_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.string('code').primaryKey()
      table.string('name')
    })
    await createTable(schema, names.tags, (table) => {
      table.string('code').primaryKey()
      table.string('name')
    })
    await createTable(schema, names.pivot, (table) => {
      table.integer('id').primaryKey()
      table.bigInteger('owner_code')
      table.bigInteger('tag_code')
    })
    const owners = defineGeneratedTable(names.owners, { code: column.string().primaryKey(), name: column.string() })
    const tags = defineGeneratedTable(names.tags, { code: column.string().primaryKey(), name: column.string() })
    await DB.table(owners).insert([{ code: '9007199254740993', name: 'owner 0' }, { code: '7', name: 'owner 1' }])
    await DB.table(tags).insert([{ code: '9007199254740993', name: 'tag 0' }])
    await DB.table(names.pivot).insert([{ id: 1, owner_code: '9007199254740993', tag_code: '9007199254740993' }])
    const Tag = defineModel(tags, { primaryKey: 'code', timestamps: false })
    const Owner = defineModel(owners, { primaryKey: 'code', timestamps: false, relations: { tags: belongsToMany(() => Tag, names.pivot, 'owner_code', 'tag_code', 'code', 'code') } })

    await expectFiltersMatchEagerLoading(Owner, 'tags', ['owner 0'])
  })
})

describe.each(integrationDrivers(['mysql'] as const))('relation filters from text keys to wide decimal keys on %s', (driver) => {
  it('matches text by value against decimal columns with more than thirty-five integer digits', async () => {
    const { schema, db } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const tag = suffix()
    const names = { owners: `dw_owners_${tag}`, items: `dw_items_${tag}` }
    await createTable(schema, names.owners, (table) => {
      table.string('code').primaryKey()
      table.string('name')
    })
    await db.executeCompiled({ sql: `CREATE TABLE \`${names.items}\` (id INT PRIMARY KEY, name VARCHAR(255) NOT NULL, whole_code DECIMAL(65, 0) NULL, fractional_code DECIMAL(65, 2) NULL)`, source: 'schema' })
    onTestFinished(() => schema.dropTable(names.items))
    const owners = defineGeneratedTable(names.owners, { code: column.string().primaryKey(), name: column.string() })
    const items = defineGeneratedTable(names.items, { id: column.integer().primaryKey(), name: column.string(), whole_code: column.decimal().nullable(), fractional_code: column.decimal().nullable() })
    const whole = '123456789012345678901234567890123456'
    const fractional = '1234567890123456789012345678901234567890.5'
    await DB.table(owners).insert([{ code: whole, name: 'owner 0' }, { code: fractional, name: 'owner 1' }, { code: `${whole}.00`, name: 'owner 2' }, { code: '1234567890123456789012345678901234567890.51', name: 'owner 3' }])
    await DB.table(items).insert([{ id: 1, name: 'item 0', whole_code: whole, fractional_code: null }, { id: 2, name: 'item 1', whole_code: null, fractional_code: `${fractional}0` }])
    const Item = defineModel(items, { timestamps: false })
    const Owner = defineModel(owners, { primaryKey: 'code', timestamps: false, relations: { wholeItems: hasMany(() => Item, 'whole_code', 'code'), fractionalItems: hasMany(() => Item, 'fractional_code', 'code') } })

    await expectFiltersMatchEagerLoading(Owner, 'wholeItems', ['owner 0', 'owner 2'])
    await expectFiltersMatchEagerLoading(Owner, 'fractionalItems', ['owner 1'])
  })
})

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql'] as const))('relation filters through pivot tables without a resolved definition on %s', (driver) => {
  const scenarios = [
    ['integer parents with text pivot keys', { parentKind: 'integer', childKind: 'text', parentKeys: ['5', '6', '7'], childKeys: ['5', '5.0', '6.00', 'abc', '05', '8'] }, ['owner 0'], ['tag 0']],
    ['text parents with integer pivot keys', { parentKind: 'text', childKind: 'integer', parentKeys: ['5', '6.00', '05', 'abc', '7', '6'], childKeys: ['5', '6', '8'] }, ['owner 0', 'owner 1', 'owner 5'], ['tag 0', 'tag 1', 'tag 5']],
    ['decimal parents with text pivot keys', decimalParents, ['owner 0', 'owner 1'], ['tag 0', 'tag 1']],
    ['text parents with decimal pivot keys', textParents, ['owner 1'], ['tag 1']],
  ] as const

  it.each(scenarios.flatMap(([name, scenario, owners, tags]) => (['unregistered', 'qualified'] as const).map(spelling => [`${name} through ${spelling === 'qualified' ? 'a schema-qualified spelling of a registered' : 'an unregistered'} pivot`, scenario, owners, tags, spelling] as const)))('filters belongsToMany, morphToMany and morphedByMany for %s as eager loading does', async (_, scenario, owners, tags, spelling) => {
    const { Owner, Tag } = await openScenario(driver, scenario, spelling)

    const unloaded = {
      tags: await readFilters(Owner, 'tags'),
      morphTags: await readFilters(Owner, 'morphTags'),
      owners: await readFilters(Tag, 'owners'),
      morphOwners: await readFilters(Tag, 'morphOwners'),
    }
    await expectFiltersMatchEagerLoading(Owner, 'tags', owners, unloaded.tags)
    await expectFiltersMatchEagerLoading(Owner, 'morphTags', owners, unloaded.morphTags)
    await expectFiltersMatchEagerLoading(Tag, 'owners', tags, unloaded.owners)
    await expectFiltersMatchEagerLoading(Tag, 'morphOwners', tags, unloaded.morphOwners)
    await expectFiltersMatchEagerLoading(Owner, 'tags', owners)
    await expectFiltersMatchEagerLoading(Owner, 'morphTags', owners)
    await expectFiltersMatchEagerLoading(Tag, 'owners', tags)
    await expectFiltersMatchEagerLoading(Tag, 'morphOwners', tags)
  })
})
