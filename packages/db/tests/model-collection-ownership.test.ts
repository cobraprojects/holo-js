import { expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createModelCollection,
  createSchemaService,
  defineGeneratedTable,
  defineModel,
  HydrationError,
  ModelRepository,
  type Entity,
  type ModelCollection,
  type RelationMap,
} from '../src'

const members = defineGeneratedTable('collection_owner_members', { id: column.id(), name: column.string() })

function setupDatabase() {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  onTestFinished(() => db.disconnect())
  return db
}

async function setupMembersTable() {
  const db = setupDatabase()
  await createSchemaService(db).createTable('collection_owner_members', (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  return db
}

it('rejects a foreign-model entity that shares the table when a collection is created', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const memberRepository = ModelRepository.from(Member)
  const foreign = ModelRepository.from(Visitor).hydrate({ id: 1, name: 'Ada' })

  expect(() => memberRepository.createCollection([foreign])).toThrow(HydrationError)
  expect(() => memberRepository.createCollection([foreign])).toThrow(
    'Cannot create a Member collection from a Visitor entity.',
  )
})

it('creates a collection from entities of the repository model', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const memberRepository = ModelRepository.from(Member)
  const owned = memberRepository.hydrate({ id: 1, name: 'Ada' })

  expect(memberRepository.createCollection([owned])).toHaveLength(1)
  expect(memberRepository.createCollection([])).toHaveLength(0)
})

it('rejects foreign-model entities in saveMany before any row is written', async () => {
  const db = await setupMembersTable()
  const Member = defineModel(members, { name: 'Member', fillable: ['name'] })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const memberRepository = ModelRepository.from(Member)
  const owned = memberRepository.make({ name: 'Bea' })
  const foreign = ModelRepository.from(Visitor).hydrate({ id: 1, name: 'Ada' })

  await expect(memberRepository.saveMany([owned, foreign])).rejects.toThrow(HydrationError)
  expect(await db.table('collection_owner_members').count()).toBe(0)
})

it('rejects a foreign entity assigned into a collection when toQuery() is called', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const memberRepository = ModelRepository.from(Member)
  const collection = memberRepository.createCollection([memberRepository.hydrate({ id: 1, name: 'Ada' })])

  collection[0] = ModelRepository.from(Visitor).hydrate({ id: 2, name: 'Bea' })

  expect(() => collection.toQuery()).toThrow(HydrationError)
  expect(() => collection.toQuery()).toThrow('Cannot create a Member collection from a Visitor entity.')
})

it('rejects a foreign entity unshifted into a collection when toQuery() is called', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const memberRepository = ModelRepository.from(Member)
  const collection = memberRepository.createCollection([memberRepository.hydrate({ id: 1, name: 'Ada' })])

  collection.unshift(ModelRepository.from(Visitor).hydrate({ id: 2, name: 'Bea' }))

  expect(() => collection.toQuery()).toThrow('Cannot create a Member collection from a Visitor entity.')
})

it('keeps the owning model on a collection derived by fresh()', async () => {
  const db = await setupMembersTable()
  await db.table('collection_owner_members').insert([{ id: 1, name: 'Ada' }])
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const memberRepository = ModelRepository.from(Member)
  const owned = await memberRepository.query().get()

  const derived = await owned.fresh()
  expect(await derived.toQuery().get()).toHaveLength(1)

  derived[0] = ModelRepository.from(Visitor).hydrate({ id: 2, name: 'Bea' })
  expect(() => derived.toQuery()).toThrow('Cannot create a Member collection from a Visitor entity.')
})

it('throws from toQuery() on an owned empty collection', async () => {
  await setupMembersTable()
  const Member = defineModel(members, { name: 'Member' })
  const memberRepository = ModelRepository.from(Member)
  const empty = await memberRepository.query().where('id', 99).get()

  expect(() => memberRepository.createCollection([]).toQuery()).toThrow('Cannot create a query from an empty model collection.')
  expect(() => empty.toQuery()).toThrow('Cannot create a query from an empty model collection.')
})

it('keeps the owner out of array keys and serialization', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const memberRepository = ModelRepository.from(Member)
  const collection = memberRepository.createCollection([memberRepository.hydrate({ id: 1, name: 'Ada' })])

  expect(Object.keys(collection)).toEqual(['0'])
  expect(JSON.stringify(collection)).toBe(JSON.stringify([...collection]))
})

async function openTenantDatabase(connectionName: string) {
  const db = createDatabase({ connectionName, adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
  onTestFinished(() => db.disconnect())
  await createSchemaService(db).createTable('collection_owner_members', (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  return db
}

it('rejects a tenant-B entity in tenant-A createCollection, saveMany and toQuery, and writes nothing', async () => {
  const tenantA = await openTenantDatabase('tenant-a')
  const tenantB = await openTenantDatabase('tenant-b')
  configureDB(createConnectionManager({ defaultConnection: 'tenant-a', connections: { 'tenant-a': tenantA, 'tenant-b': tenantB } }))
  const Member = defineModel(members, { name: 'Member', fillable: ['name'] })
  const tenantARepository = ModelRepository.from(Member, tenantA)
  const tenantBRepository = ModelRepository.from(Member, tenantB)
  const foreign = tenantBRepository.hydrate({ id: 1, name: 'Ada' })

  expect(() => tenantARepository.createCollection([foreign])).toThrow(HydrationError)

  const collection = tenantARepository.createCollection([tenantARepository.hydrate({ id: 2, name: 'Bea' })])
  collection[0] = foreign
  expect(() => collection.toQuery()).toThrow(HydrationError)

  await expect(tenantARepository.saveMany([tenantARepository.make({ name: 'Cy' }), foreign])).rejects.toThrow(HydrationError)
  expect(await tenantA.table('collection_owner_members').count()).toBe(0)
  expect(await tenantB.table('collection_owner_members').count()).toBe(0)
})

it('keeps a frozen custom collection working for get() and toQuery()', async () => {
  const db = await setupMembersTable()
  await db.table('collection_owner_members').insert([{ id: 1, name: 'Ada' }])
  const Frozen = defineModel(members, {
    name: 'Frozen',
    collection<TItem extends Entity<typeof members>>(items: readonly TItem[]) {
      return Object.freeze(createModelCollection<typeof members, RelationMap, TItem>(items)) as ModelCollection<typeof members, RelationMap, TItem>
    },
  })

  const rows = await ModelRepository.from(Frozen).query().get()

  expect(Object.isFrozen(rows)).toBe(true)
  expect(await rows.toQuery().get()).toHaveLength(1)
})
