import { expect, it, onTestFinished } from 'vitest'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  createSchemaService,
  defineGeneratedTable,
  defineModel,
  HydrationError,
  ModelRepository,
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
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const foreign = ModelRepository.from(Visitor).hydrate({ id: 1, name: 'Ada' })

  await expect(ModelRepository.from(Member).saveMany([foreign])).rejects.toThrow(HydrationError)
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

it('builds a query from an owned empty collection', async () => {
  const db = await setupMembersTable()
  await db.table('collection_owner_members').insert([{ id: 1, name: 'Ada' }])
  const Member = defineModel(members, { name: 'Member' })
  const memberRepository = ModelRepository.from(Member)

  expect(await memberRepository.createCollection([]).toQuery().get()).toHaveLength(0)
  expect(await (await memberRepository.query().where('id', 99).get()).toQuery().get()).toHaveLength(0)
})

it('keeps the owner out of array keys and serialization', () => {
  setupDatabase()
  const Member = defineModel(members, { name: 'Member' })
  const memberRepository = ModelRepository.from(Member)
  const collection = memberRepository.createCollection([memberRepository.hydrate({ id: 1, name: 'Ada' })])

  expect(Object.keys(collection)).toEqual(['0'])
  expect(JSON.stringify(collection)).toBe(JSON.stringify([...collection]))
})
