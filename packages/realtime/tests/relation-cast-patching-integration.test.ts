import { randomUUID } from 'node:crypto'
import { belongsTo, belongsToMany, column, defineGeneratedTable, defineModel, hasMany, hasOne, serializeModels, type ModelCastDefinition } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

const scalarColumns = {
  active: column.boolean(),
  flag: column.integer(),
  big: column.bigInteger(),
  secret: column.string(),
}

const datedColumns = {
  ...scalarColumns,
  born_on: column.date(),
  settings: column.json(),
  meta: column.text(),
}

const modelCasts: Record<string, ModelCastDefinition> = {
  flag: 'boolean',
  born_on: 'date',
  settings: 'json',
  meta: 'json',
  secret: { get: value => `secret:${String(value)}`, set: value => value },
}

const variants = drivers.flatMap(driver => [
  { driver, label: 'scalar columns', dated: false, casts: {}, patches: true },
  { driver, label: 'date and JSON columns', dated: true, casts: {}, patches: false },
  { driver, label: 'model casts', dated: true, casts: modelCasts, patches: false },
])

type Variant = typeof variants[number]

function rowValues(variant: Variant, seed: number) {
  return {
    active: seed % 2 === 1,
    flag: seed % 2,
    big: seed * 10,
    secret: `s${seed}`,
    ...variant.dated
      ? {
          born_on: `2024-0${(seed % 9) + 1}-1${seed % 10}`,
          settings: JSON.stringify({ seed, tags: [seed] }),
          meta: JSON.stringify({ meta: seed }),
        }
      : {},
  }
}

async function openFixture(variant: Variant) {
  const { db, schema } = await openDatabase(variant.driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const ownersName = `holo_cast_owners_${suffix}`
  const itemsName = `holo_cast_items_${suffix}`
  const tagsName = `holo_cast_tags_${suffix}`
  const pivotName = `holo_cast_owner_tags_${suffix}`
  const addColumns = (table: Parameters<Parameters<typeof schema.createTable>[1]>[0]) => {
    table.boolean('active')
    table.integer('flag')
    table.bigInteger('big')
    table.string('secret')
    if (variant.dated) {
      table.date('born_on')
      table.json('settings')
      table.text('meta')
    }
  }
  await schema.createTable(ownersName, (table) => {
    table.id()
    addColumns(table)
  })
  await schema.createTable(itemsName, (table) => {
    table.id()
    table.bigInteger('owner_id')
    addColumns(table)
  })
  await schema.createTable(tagsName, (table) => {
    table.id()
    addColumns(table)
  })
  await schema.createTable(pivotName, (table) => {
    table.id()
    table.bigInteger('owner_id')
    table.bigInteger('tag_id')
    table.boolean('pinned')
  })
  onTestFinished(async () => {
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(itemsName)
    await schema.dropTable(ownersName)
  })
  const columns = variant.dated ? datedColumns : scalarColumns
  const owners = defineGeneratedTable(ownersName, { id: column.id(), ...columns })
  const items = defineGeneratedTable(itemsName, { id: column.id(), owner_id: column.bigInteger(), ...columns })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), ...columns })
  const ownerTags = defineGeneratedTable(pivotName, { id: column.id(), owner_id: column.bigInteger(), tag_id: column.bigInteger(), pinned: column.boolean() })
  await db.table(owners).insert([{ id: 1, ...rowValues(variant, 1) }, { id: 2, ...rowValues(variant, 2) }])
  await db.table(items).insert([
    { id: 1, owner_id: 1, ...rowValues(variant, 3) },
    { id: 2, owner_id: 1, ...rowValues(variant, 4) },
    { id: 3, owner_id: 2, ...rowValues(variant, 5) },
  ])
  await db.table(tags).insert([{ id: 1, ...rowValues(variant, 6) }, { id: 2, ...rowValues(variant, 7) }, { id: 3, ...rowValues(variant, 8) }])
  await db.table(ownerTags).insert([{ id: 1, owner_id: 1, tag_id: 1, pinned: true }])
  if (variant.driver === 'postgres') {
    await db.executeCompiled({ sql: `SELECT setval(pg_get_serial_sequence('"${itemsName}"', 'id'), 40)`, source: 'schema' })
  }
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const casts = variant.casts
  const Tag = defineModel(tags, { timestamps: false, casts })
  const Owner = defineModel(owners, { timestamps: false, casts })
  const Item = defineModel(items, { timestamps: false, casts, fillable: ['owner_id', ...Object.keys(columns)], relations: { owner: belongsTo(() => Owner, 'owner_id') } })
  const ActiveItem = defineModel(items, { timestamps: false, casts, globalScopes: { active: query => query.where('active', true) } })
  const Parent = defineModel(owners, { timestamps: false, casts, relations: {
    activeItems: hasMany(() => ActiveItem, 'owner_id'),
    firstActiveItem: hasOne(() => ActiveItem, 'owner_id'),
    items: hasMany(() => Item, 'owner_id'),
    firstItem: hasOne(() => Item, 'owner_id'),
    tags: belongsToMany(() => Tag, ownerTags, 'owner_id', 'tag_id').withPivot('pinned').orderByPivot('tag_id'),
  } })
  return { db, owners, items, tags, ownerTags, Item, Parent }
}

async function subscribeAll(variant: Variant, queries: Record<string, () => Promise<unknown>>) {
  const runs = Object.fromEntries(Object.keys(queries).map(name => [name, 0]))
  const subscriptions = await Promise.all(Object.entries(queries).map(([name, handler]) => subscribeRealtimeQuery(
    defineRealtimeQuery({ access: 'public', handler: () => {
      runs[name]! += 1
      return handler()
    } }),
    {},
    { onData: () => {}, onError: (error) => { throw error } },
  )))
  return async (patched = variant.patches) => {
    const fresh = await Promise.all(Object.values(queries).map(handler => handler()))
    expect(Object.fromEntries(Object.keys(queries).map((name, index) => [name, subscriptions[index]!.current.data])))
      .toEqual(Object.fromEntries(Object.keys(queries).map((name, index) => [name, serializeModels(fresh[index])])))
    if (patched) expect(runs).toEqual(Object.fromEntries(Object.keys(queries).map(name => [name, 1])))
  }
}

describe.each(variants)('realtime relation patches on $driver with $label', (variant) => {
  it('keeps eager-loaded belongsTo owners equal to a fresh read', async () => {
    const { db, owners, items, Item } = await openFixture(variant)
    const expectFresh = await subscribeAll(variant, {
      json: () => db.model(Item).query().with('owner').orderBy('id').getJson(),
      models: () => db.model(Item).query().with('owner').orderBy('id').get(),
    })

    await mutate(() => db.table(items).insert({ id: 4, owner_id: 2, ...rowValues(variant, 9) }))
    await expectFresh()
    await mutate(() => db.table(items).where('id', 1).update({ owner_id: 2, ...rowValues(variant, 10) }))
    await expectFresh()
    await mutate(() => db.table(owners).where('id', 2).update(rowValues(variant, 11)))
    await expectFresh()
    await mutate(() => db.model(Item).create({ owner_id: 1, ...rowValues(variant, 12) }))
    await expectFresh()
  })

  it('keeps eager-loaded hasOne and hasMany rows equal to a fresh read', async () => {
    const { db, owners, items, Item, Parent } = await openFixture(variant)
    const expectFresh = await subscribeAll(variant, {
      many: () => db.model(Parent).query().with('items', query => query.orderBy('id')).orderBy('id').getJson(),
      one: () => db.model(Parent).query().with('firstItem', query => query.orderBy('id')).orderBy('id').getJson(),
      models: () => db.model(Parent).query().with('items', query => query.orderBy('id')).with('firstItem', query => query.orderBy('id')).orderBy('id').get(),
    })

    await mutate(() => db.table(items).insert({ id: 4, owner_id: 2, ...rowValues(variant, 9) }))
    await expectFresh()
    await mutate(() => db.table(items).where('id', 3).update(rowValues(variant, 10)))
    await expectFresh()
    await mutate(() => db.table(owners).where('id', 1).update(rowValues(variant, 11)))
    await expectFresh()
    await mutate(() => db.table(owners).insert({ id: 3, ...rowValues(variant, 12) }))
    await expectFresh()
    await mutate(() => db.model(Item).create({ owner_id: 3, ...rowValues(variant, 13) }))
    await expectFresh()
  })

  it('keeps hasOne and hasMany rows hidden by a related global scope out of patched results', async () => {
    const { db, owners, items, Parent } = await openFixture(variant)
    const expectFresh = await subscribeAll(variant, {
      many: () => db.model(Parent).query().with('activeItems').orderBy('id').getJson(),
      one: () => db.model(Parent).query().with('firstActiveItem').orderBy('id').getJson(),
    })

    await mutate(() => db.table(owners).where('id', 2).update(rowValues(variant, 10)))
    await expectFresh(false)
    await mutate(() => db.table(items).where('id', 1).update({ active: false }))
    await expectFresh(false)
    await mutate(() => db.table(items).where('id', 3).update({ active: false }))
    await expectFresh(false)
  })

  it('keeps eager-loaded belongsToMany rows equal to a fresh read', async () => {
    const { db, owners, tags, ownerTags, Parent } = await openFixture(variant)
    const expectFresh = await subscribeAll(variant, {
      json: () => db.model(Parent).query().with('tags').orderBy('id').getJson(),
      models: () => db.model(Parent).query().with('tags').orderBy('id').get(),
    })

    await mutate(() => db.table(ownerTags).insert({ id: 2, owner_id: 1, tag_id: 2, pinned: false }))
    await expectFresh()
    await mutate(() => db.table(ownerTags).insert({ id: 3, owner_id: 2, tag_id: 3, pinned: true }))
    await expectFresh()
    await mutate(() => db.table(tags).where('id', 2).update(rowValues(variant, 9)))
    await expectFresh()
    await mutate(() => db.table(ownerTags).where('id', 1).update({ pinned: false }))
    await expectFresh()
    await mutate(() => db.table(owners).where('id', 2).update(rowValues(variant, 10)))
    await expectFresh(false)
  })
})
