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
  const db = setupDatabase()
  await createSchemaService(db).createTable('collection_owner_members', (table) => {
    table.integer('id').primaryKey()
    table.string('name')
  })
  const Member = defineModel(members, { name: 'Member' })
  const Visitor = defineModel(members, { name: 'Visitor' })
  const foreign = ModelRepository.from(Visitor).hydrate({ id: 1, name: 'Ada' })

  await expect(ModelRepository.from(Member).saveMany([foreign])).rejects.toThrow(HydrationError)
  expect(await db.table('collection_owner_members').count()).toBe(0)
})
