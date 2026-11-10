import { randomUUID } from 'node:crypto'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { describe, expect, it, onTestFinished } from 'vitest'
import { belongsTo, belongsToMany, column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, DB, defineGeneratedTable, defineModel, hasMany, hasManyThrough, generateUuidV7, generateUlid, generateSnowflake, latestOfMany, oldestOfMany, resetDB, scopeRelation } from '../src'
import { integrationDrivers, openDatabase } from './support/database'

async function openExtremaFixture(driver: 'sqlite' | 'postgres' | 'mysql', collated = false) {
  const queries: string[] = []
  const { schema, adapter } = await openDatabase(driver, { security: { debugSqlInLogs: true }, logger: { onQueryStart: entry => { queries.push(entry.sql) } } })
  onTestFinished(() => resetDB())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const ownersName = `extrema_owners_${suffix}`
  const itemsName = `extrema_items_${suffix}`
  await schema.createTable(ownersName, table => { table.integer('id').primaryKey() })
  onTestFinished(() => schema.dropTable(ownersName))
  await schema.createTable(itemsName, table => {
    table.integer('id').primaryKey()
    table.integer('ownerId')
    table.string('label').nullable()
    table.integer('score').nullable()
    table.timestamp('occurredAt').nullable()
    table.timestamp('deleted_at').nullable()
    table.integer('tenantId').default(1)
  })
  onTestFinished(() => schema.dropTable(itemsName))
  if (collated) {
    const collation = driver === 'sqlite' ? 'NOCASE' : driver === 'postgres' ? '"C"' : 'utf8mb4_0900_ai_ci'
    await adapter.execute(`ALTER TABLE ${itemsName} ADD COLUMN collated VARCHAR(255) COLLATE ${collation}`)
  }
  const items = defineGeneratedTable(itemsName, {
    id: column.integer().primaryKey(), ownerId: column.integer(), label: column.string().nullable(),
    score: column.integer().nullable(), occurredAt: column.timestamp().nullable(),
    deleted_at: column.timestamp().nullable(), tenantId: column.integer(),
    ...(collated ? { collated: column.string().nullable() } : {}),
  })
  const Item = defineModel(items, {
    timestamps: false, softDeletes: true,
    globalScopes: { tenant: query => query.where('tenantId', 1) },
  })
  const Owner = defineModel(defineGeneratedTable(ownersName, { id: column.integer().primaryKey() }), {
    timestamps: false,
    relations: {
      items: hasMany(() => Item, 'ownerId'),
      highItems: scopeRelation(hasMany(() => Item, 'ownerId'), query => query.where('score', '>=', 2)),
      latestItem: latestOfMany(() => Item, 'ownerId'),
    },
  })
  await DB.table(ownersName).insert([{ id: 1 }, { id: 2 }, { id: 3 }])
  return { Owner, Item, items, ownersName, itemsName, queries }
}

describe.each(integrationDrivers(['sqlite', 'postgres', 'mysql']))('relation extrema on %s', driver => {
  it('preserves text ordering, including numeric-looking strings and empty strings', async () => {
    const { Owner, items } = await openExtremaFixture(driver)
    await DB.table(items).insert([
      { id: 1, ownerId: 1, label: 'Zulu' }, { id: 2, ownerId: 1, label: 'Alpha' },
      { id: 3, ownerId: 2, label: '2' }, { id: 4, ownerId: 2, label: '10' },
      { id: 5, ownerId: 3, label: '' }, { id: 6, ownerId: 3, label: 'text' },
    ])
    expect((await DB.table(items).where('ownerId', 1).orderBy('label').get()).map(row => row.label)).toEqual(['Alpha', 'Zulu'])
    const owners = await Owner.query().withMin('items', 'label').withMax('items', 'label').orderBy('id').getJson()
    expect(owners).toMatchObject([
      { items_min_label: 'Alpha', items_max_label: 'Zulu' },
      { items_min_label: '10', items_max_label: '2' },
      { items_min_label: '', items_max_label: 'text' },
    ])
    await expect(Owner.query().withSum('items', 'label').findOrFail(1)).rejects.toThrow('requires numeric values')
  })

  it('loads extrema from projected relation keys without the parent primary key', async () => {
    const { Item, items } = await openExtremaFixture(driver)
    const Parent = defineModel(items, {
      timestamps: false,
      relations: { matching: hasMany(() => Item, 'ownerId', 'ownerId'), owner: belongsTo(() => Item, 'ownerId') },
    })
    await DB.table(items).insert([
      { id: 1, ownerId: 9, label: 'Zulu' }, { id: 2, ownerId: 9, label: 'Alpha' }, { id: 9, ownerId: 99, label: 'Owner' },
    ])
    expect(await Parent.query().where('id', 1).select('ownerId').withMin('matching', 'label').withMax('owner', 'label').getJson())
      .toEqual([{ ownerId: 9, matching_min_label: 'Alpha', owner_max_label: 'Owner' }])
  })

  it('loads extrema on self-referencing latest and oldest relations', async () => {
    const { Item, items } = await openExtremaFixture(driver)
    const Node = defineModel(items, {
      timestamps: false,
      relations: { latestChild: latestOfMany(() => Item, 'ownerId'), oldestChild: oldestOfMany(() => Item, 'ownerId') },
    })
    await DB.table(items).insert([
      { id: 1, ownerId: 9, label: 'Parent' }, { id: 2, ownerId: 1, label: 'Alpha' }, { id: 3, ownerId: 1, label: 'Zulu' },
    ])
    const node = await Node.query().withMin('latestChild', 'label').withMax('oldestChild', 'label').findOrFail(1)
    expect(node.toAttributes()).toMatchObject({ latestChild_min_label: 'Zulu', oldestChild_max_label: 'Alpha' })
  })

  it('keeps OR constraints within the requested parent', async () => {
    const { items, Owner } = await openExtremaFixture(driver)
    const Item = defineModel(items, { timestamps: false })
    const Parent = defineModel(Owner.definition.table, { timestamps: false, relations: { children: hasMany(() => Item, 'ownerId') } })
    await DB.table(items).insert([{ id: 1, ownerId: 1, label: 'Zulu', score: 1 }, { id: 2, ownerId: 2, label: 'Alpha', score: 1 }])
    expect(await Parent.query().where('id', 1).withMin({ children: query => query.where('score', 1).orWhere('score', 2) }, 'label').getJson())
      .toEqual([{ id: 1, children_min_label: 'Zulu' }])
  })

  it('handles dense pivot relations with integer and text keys', async () => {
    const { items, Owner, itemsName } = await openExtremaFixture(driver)
    const schema = createSchemaService(DB.connection())
    const linksName = `${itemsName}_dense`
    await schema.createTable(linksName, table => { table.integer('ownerId'); table.integer('childId'); table.string('childLabel') })
    onTestFinished(() => schema.dropTable(linksName))
    const links = defineGeneratedTable(linksName, { ownerId: column.integer(), childId: column.integer(), childLabel: column.string() })
    const Item = defineModel(items, { timestamps: false })
    const Parent = defineModel(Owner.definition.table, {
      timestamps: false,
      relations: {
        numeric: belongsToMany(() => Item, links, 'ownerId', 'childId'),
        textual: belongsToMany(() => Item, links, 'ownerId', 'childLabel', 'id', 'label'),
      },
    })
    const count = driver === 'sqlite' ? 33000 : 300
    for (let offset = 0; offset < count; offset += 250) {
      const rows = Array.from({ length: Math.min(250, count - offset) }, (_, index) => ({ id: offset + index + 1, ownerId: 1, label: `label_${String(offset + index).padStart(5, '0')}` }))
      await DB.table(items).insert(rows)
      await DB.table(links).insert(rows.map(row => ({ ownerId: 1, childId: row.id, childLabel: row.label })))
    }
    const parent = await Parent.query().withMin('numeric', 'label').withMax('textual', 'label').findOrFail(1)
    expect(parent.toAttributes()).toMatchObject({ numeric_min_label: 'label_00000', textual_max_label: `label_${String(count - 1).padStart(5, '0')}` })
  })

  it('preserves typed relation keys across the large-key boundary', async () => {
    const { Owner, itemsName } = await openExtremaFixture(driver)
    const schema = createSchemaService(DB.connection())
    const childrenName = `${itemsName}_typed`
    const linksName = `${itemsName}_typed_links`
    await schema.createTable(childrenName, table => {
      table.integer('id').primaryKey(); table.timestamp('moment'); table.real('fraction'); table.blob('binaryKey'); table.string('label')
    })
    await schema.createTable(linksName, table => {
      table.integer('ownerId'); table.timestamp('moment'); table.real('fraction'); table.blob('binaryKey')
    })
    onTestFinished(async () => { await schema.dropTable(linksName); await schema.dropTable(childrenName) })
    const children = defineGeneratedTable(childrenName, { id: column.integer().primaryKey(), moment: column.timestamp(), fraction: column.real(), binaryKey: column.blob(), label: column.string() })
    const links = defineGeneratedTable(linksName, { ownerId: column.integer(), moment: column.timestamp(), fraction: column.real(), binaryKey: column.blob() })
    const Child = defineModel(children, { timestamps: false })
    const Parent = defineModel(Owner.definition.table, {
      timestamps: false,
      relations: {
        temporal: belongsToMany(() => Child, links, 'ownerId', 'moment', 'id', 'moment'),
        fractional: belongsToMany(() => Child, links, 'ownerId', 'fraction', 'id', 'fraction'),
        binary: belongsToMany(() => Child, links, 'ownerId', 'binaryKey', 'id', 'binaryKey'),
      },
    })
    const rows = Array.from({ length: 257 }, (_, index) => ({ id: index + 1, moment: new Date(Date.UTC(2026, 0, index + 1)), fraction: index + 0.5, binaryKey: Buffer.from(`key_${index}`), label: `label_${String(index).padStart(3, '0')}` }))
    await DB.table(children).insert(rows)
    await DB.table(links).insert(rows.map(row => ({ ownerId: 1, moment: row.moment, fraction: row.fraction, binaryKey: row.binaryKey })))
    await DB.table(links).insert(rows.slice(0, 256).map(row => ({ ownerId: 2, moment: row.moment, fraction: row.fraction, binaryKey: row.binaryKey })))
    const parents = await Parent.query().whereIn('id', [1, 2]).withMin('temporal', 'label').withMax('fractional', 'label').withMin('binary', 'label').orderBy('id').getJson()
    expect(parents).toMatchObject([
      { id: 1, temporal_min_label: 'label_000', fractional_max_label: 'label_256', binary_min_label: 'label_000' },
      { id: 2, temporal_min_label: 'label_000', fractional_max_label: 'label_255', binary_min_label: 'label_000' },
    ])
  })

  it.each(['uuid', 'ulid', 'snowflake'] as const)('preserves %s primary and foreign keys in projected and large relation loads', async kind => {
    const { schema, db } = await openDatabase(driver)
    onTestFinished(() => resetDB())
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = { parents: `extrema_id_parents_${suffix}`, children: `extrema_id_children_${suffix}`, links: `extrema_id_links_${suffix}` }
    await schema.createTable(names.parents, table => { table[kind]('id').primaryKey(); table.string('name') })
    await schema.createTable(names.children, table => { table[kind]('id').primaryKey(); table[kind]('parentId'); table.string('label') })
    await schema.createTable(names.links, table => { table[kind]('parentId'); table[kind]('childId') })
    onTestFinished(async () => { await schema.dropTable(names.links); await schema.dropTable(names.children); await schema.dropTable(names.parents) })
    const parents = defineGeneratedTable(names.parents, { id: column[kind]().primaryKey(), name: column.string() })
    const children = defineGeneratedTable(names.children, { id: column[kind]().primaryKey(), parentId: column[kind](), label: column.string() })
    const links = defineGeneratedTable(names.links, { parentId: column[kind](), childId: column[kind]() })
    const ParentBase = defineModel(parents, { timestamps: false })
    const Child = defineModel(children, { timestamps: false, relations: { parent: belongsTo(() => ParentBase, 'parentId') } })
    const Parent = defineModel(parents, { timestamps: false, relations: { children: hasMany(() => Child, 'parentId'), linked: belongsToMany(() => Child, links, 'parentId', 'childId') } })
    const generate = { uuid: generateUuidV7, ulid: generateUlid, snowflake: generateSnowflake }[kind]
    const parentId = generate()
    const rows = Array.from({ length: 257 }, (_, index) => ({ id: generate(), parentId, label: `label_${String(index).padStart(3, '0')}` }))
    if (kind === 'snowflake') expect(BigInt(parentId)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    await db.table(parents).insert({ id: parentId, name: 'Owner' })
    await db.table(children).insert(rows)
    await db.table(links).insert(rows.map(row => ({ parentId, childId: row.id })))
    const owner = await Parent.query().withMin('children', 'label').withMax('linked', 'label').findOrFail(parentId)
    expect(owner.toAttributes()).toMatchObject({ id: parentId, children_min_label: 'label_000', linked_max_label: 'label_256' })
    expect(await Child.query().where('id', rows[0]!.id).select('parentId').withMax('parent', 'name').getJson())
      .toEqual([{ parentId, parent_max_name: 'Owner' }])
  })

  it('ignores nulls and returns null for all-null or empty relations', async () => {
    const { Owner, items } = await openExtremaFixture(driver)
    await DB.table(items).insert([
      { id: 1, ownerId: 1, label: null, score: null }, { id: 2, ownerId: 1, label: 'Alpha', score: 4 },
      { id: 3, ownerId: 2, label: null, score: null },
    ])
    const owners = await Owner.query().withMin('items', 'label').withMax('items', 'label')
      .withMin('items', 'score').withMax('items', 'score').withSum('items', 'score').withAvg('items', 'score').orderBy('id').getJson()
    expect(owners).toMatchObject([
      { items_min_label: 'Alpha', items_max_label: 'Alpha', items_min_score: 4, items_max_score: 4, items_sum_score: 4, items_avg_score: 4 },
      { items_min_label: null, items_max_label: null, items_min_score: null, items_max_score: null, items_sum_score: 0, items_avg_score: null },
      { items_min_label: null, items_max_label: null, items_min_score: null, items_max_score: null, items_sum_score: 0, items_avg_score: null },
    ])
  })

  it('retains tenant, soft-delete, relation and caller constraints', async () => {
    const { Owner, items } = await openExtremaFixture(driver)
    await DB.table(items).insert([
      { id: 1, ownerId: 1, label: 'Zulu', score: 3, tenantId: 1, deleted_at: null }, { id: 2, ownerId: 1, label: 'Alpha', score: 1, tenantId: 1, deleted_at: null },
      { id: 3, ownerId: 1, label: 'Aardvark', score: 5, tenantId: 2, deleted_at: null },
      { id: 4, ownerId: 1, label: 'Zzz', score: 9, tenantId: 1, deleted_at: new Date('2026-01-01T00:00:00Z') },
    ])
    const owner = await Owner.query().withMin('items', 'label').withMax('items', 'label')
      .withMin('highItems', 'label').withMax({ 'items as selected': query => query.where('score', 1) }, 'label')
      .withMin('latestItem', 'label').findOrFail(1)
    expect(owner.toAttributes()).toMatchObject({
      items_min_label: 'Alpha', items_max_label: 'Zulu', highItems_min_label: 'Zulu', selected: 'Alpha', latestItem_min_label: 'Alpha',
    })
  })

  it('returns temporal extrema as model dates while preserving numeric aggregates', async () => {
    const { Owner, items } = await openExtremaFixture(driver)
    const early = new Date('2026-01-01T10:00:00Z')
    const late = new Date('2026-02-01T10:00:00Z')
    await DB.table(items).insert([
      { id: 1, ownerId: 1, occurredAt: late, score: 10 },
      { id: 2, ownerId: 1, occurredAt: early, score: 2 },
    ])
    const owner = await Owner.query().withMin('items', 'occurredAt').withMax('items', 'occurredAt')
      .withSum('items', 'score').withAvg('items', 'score').withMin('items', 'score').withMax('items', 'score').findOrFail(1)
    expect(owner.toAttributes()).toMatchObject({
      items_min_occurredAt: early, items_max_occurredAt: late, items_sum_score: 12, items_avg_score: 6, items_min_score: 2, items_max_score: 10,
    })
  })

  it('uses scoped SQL extrema for pivot and through relations', async () => {
    const { items, ownersName, itemsName } = await openExtremaFixture(driver)
    const schema = createSchemaService(DB.connection())
    const linksName = `${ownersName}_links`
    await schema.createTable(linksName, table => {
      table.integer('ownerId')
      table.integer('itemId')
    })
    onTestFinished(() => schema.dropTable(linksName))
    const links = defineGeneratedTable(linksName, { ownerId: column.integer(), itemId: column.integer() })
    const Link = defineModel(links, { timestamps: false })
    const Item = defineModel(items, {
      timestamps: false, softDeletes: true,
      globalScopes: { tenant: query => query.where('tenantId', 1), aliased: query => query.from(`${itemsName} as scoped_items`) },
    })
    const Owner = defineModel(defineGeneratedTable(ownersName, { id: column.integer().primaryKey() }), {
      timestamps: false,
      relations: {
        linked: belongsToMany(() => Item, links, 'ownerId', 'itemId'),
        through: hasManyThrough(() => Item, () => Link, 'ownerId', 'id', 'id', 'itemId'),
      },
    })
    await DB.table(items).insert([
      { id: 1, ownerId: 9, label: '2', tenantId: 1 }, { id: 2, ownerId: 9, label: '10', tenantId: 1 },
      { id: 3, ownerId: 9, label: '99', tenantId: 2 },
    ])
    await DB.table(links).insert([{ ownerId: 1, itemId: 1 }, { ownerId: 1, itemId: 2 }, { ownerId: 1, itemId: 3 }])
    const owners = await Owner.query().withMin('linked', 'label').withMax('linked', 'label')
      .withMin('through', 'label').withMax('through', 'label').orderBy('id').getJson()
    expect(owners[0]).toMatchObject({ linked_min_label: '10', linked_max_label: '2', through_min_label: '10', through_max_label: '2' })
    expect(owners[1]).toMatchObject({ linked_min_label: null, linked_max_label: null, through_min_label: null, through_max_label: null })
  })

  it('batches parents and returns fresh comparable extrema after writes', async () => {
    const { Owner, items, ownersName, itemsName, queries } = await openExtremaFixture(driver)
    await DB.table(ownersName).insert(Array.from({ length: 257 }, (_, index) => ({ id: index + 4 })))
    await DB.table(items).insert([{ id: 1, ownerId: 1, label: 'Alpha' }, { id: 2, ownerId: 260, label: 'Zulu' }])
    queries.length = 0
    const owners = await Owner.query().withMin('items', 'label').withMax('items', 'label').orderBy('id').getJson()
    expect(owners[0]).toMatchObject({ items_min_label: 'Alpha', items_max_label: 'Alpha' })
    expect(owners.at(-1)).toMatchObject({ items_min_label: 'Zulu', items_max_label: 'Zulu' })
    expect(queries.filter(sql => /^select/i.test(sql))).toHaveLength(5)
    await DB.table(items).where('id', 1).update({ label: 'Updated' })
    expect((await Owner.query().withMin('items', 'label').findOrFail(1)).toAttributes()).toMatchObject({ items_min_label: 'Updated' })
  })
  it('matches native column ordering and collation for text extrema', async () => {
    const { Owner, itemsName } = await openExtremaFixture(driver, true)
    await DB.table(itemsName).insert([{ id: 1, ownerId: 1, collated: 'a' }, { id: 2, ownerId: 1, collated: 'Z' }])
    const ordered = await DB.table(itemsName).select('collated').orderBy('collated').get()
    const owner = await Owner.query().withMin('items', 'collated').withMax('items', 'collated').findOrFail(1)
    expect(owner.toAttributes()).toMatchObject({ items_min_collated: ordered[0]?.collated, items_max_collated: ordered.at(-1)?.collated })
  })
})

it('loads comparable extrema across independent connections, including pivot and through relations', async () => {
  const { db: parent, schema } = await openDatabase('sqlite')
  const related = createDatabase({ adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite'), connectionName: 'related' })
  onTestFinished(async () => { await related.disconnect(); resetDB() })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: parent, related } }))
  await schema.createTable('extrema_parents', table => { table.integer('id').primaryKey() })
  await schema.createTable('extrema_links', table => { table.integer('parentId'); table.integer('childId') })
  await createSchemaService(related).createTable('extrema_children', table => {
    table.integer('id').primaryKey(); table.integer('parentId'); table.string('label'); table.timestamp('occurredAt')
  })
  const parents = defineGeneratedTable('extrema_parents', { id: column.integer().primaryKey() })
  const links = defineGeneratedTable('extrema_links', { parentId: column.integer(), childId: column.integer() })
  const children = defineGeneratedTable('extrema_children', { id: column.integer().primaryKey(), parentId: column.integer(), label: column.string(), occurredAt: column.timestamp() })
  const Child = defineModel(children, { timestamps: false, connectionName: 'related' })
  const Link = defineModel(links, { timestamps: false })
  const Parent = defineModel(parents, {
    timestamps: false,
    relations: {
      children: hasMany(() => Child, 'parentId'),
      linked: belongsToMany(() => Child, links, 'parentId', 'childId'),
      through: hasManyThrough(() => Child, () => Link, 'parentId', 'id', 'id', 'childId'),
    },
  })
  await parent.table(parents).insert([{ id: 1 }, { id: 2 }])
  const early = new Date('2026-01-01T00:00:00Z')
  const late = new Date('2026-02-01T00:00:00Z')
  await related.table(children).insert([{ id: 1, parentId: 1, label: '10', occurredAt: late }, { id: 2, parentId: 1, label: '2', occurredAt: early }])
  await parent.table(links).insert([{ parentId: 1, childId: 1 }, { parentId: 1, childId: 2 }])
  const rows = await Parent.query().withMin('children', 'label').withMax('children', 'label').withMin('children', 'occurredAt')
    .withMin('linked', 'label').withMax('through', 'label').orderBy('id').get()
  expect(rows.map(row => row.toAttributes())).toMatchObject([
    { id: 1, children_min_label: '10', children_max_label: '2', children_min_occurredAt: early, linked_min_label: '10', through_max_label: '2' },
    { id: 2, children_min_label: null, children_max_label: null, children_min_occurredAt: null, linked_min_label: null, through_max_label: null },
  ])
})
