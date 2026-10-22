import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  resetDB,
  type DatabaseContext,
  type Entity,
  type TableDefinition,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

async function openDatabase(): Promise<DatabaseContext> {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  return db
}

const accounts = defineTable('accounts', {
  id: column.id(),
  name: column.string(),
})

type EntityConstructorFromSecondCopy = new (
  repository: unknown,
  attributes: Record<string, unknown>,
  exists: boolean,
) => Entity<TableDefinition>

async function loadEntityFromSecondCopy(): Promise<EntityConstructorFromSecondCopy> {
  const secondCopyEntityModulePath = '../src/model/Entity.ts?second-copy'
  const secondCopy = await import(secondCopyEntityModulePath) as { Entity: EntityConstructorFromSecondCopy }
  return secondCopy.Entity
}

function repositoryOf(model: unknown): unknown {
  return (model as { getRepository(): unknown }).getRepository()
}

describe('entities minted by another copy of the Entity module', () => {
  beforeEach(() => resetDB())

  it('inserts through the repository that received an entity from a second module copy', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    const Account = defineModelFromTable(accounts, { fillable: ['name'] })
    const repository = repositoryOf(Account)

    const Entity = await loadEntityFromSecondCopy()
    const entity = new Entity(repository, { name: 'Ada' }, false)

    const saved = await (repository as { saveEntity(entity: unknown): Promise<Entity<TableDefinition>> }).saveEntity(entity)

    expect(saved.exists()).toBe(true)
    expect(await db.table('accounts').where('name', 'Ada').get()).toMatchObject([{ name: 'Ada' }])
  })

  it('restores a foreign entity when its insert fails', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    const Account = defineModelFromTable(accounts, {
      fillable: ['name'],
      events: {
        creating: [(entity: unknown) => {
          (entity as { set(key: string, value: string): unknown }).set('name', 'Changed')
          throw new Error('insert blocked')
        }],
      },
    })
    const repository = repositoryOf(Account)

    const Entity = await loadEntityFromSecondCopy()
    const entity = new Entity(repository, { name: 'Ada' }, false)

    await expect((repository as { saveEntity(entity: unknown): Promise<unknown> }).saveEntity(entity)).rejects.toThrow('insert blocked')

    expect(entity.exists()).toBe(false)
    expect(entity.get('name' as never)).toBe('Ada')
    expect(await db.table('accounts').get()).toEqual([])
  })

  it('updates through the repository that received a persisted entity from a second module copy', async () => {
    const db = await openDatabase()
    await createTestTable(db, accounts)
    const Account = defineModelFromTable(accounts, { fillable: ['name'] })
    const repository = repositoryOf(Account)
    const created = await Account.create({ name: 'Ada' })

    const Entity = await loadEntityFromSecondCopy()
    const entity = new Entity(repository, { id: created.get('id'), name: 'Ada' }, true)
    entity.set('name' as never, 'Grace' as never)

    await (repository as { saveEntity(entity: unknown): Promise<Entity<TableDefinition>> }).saveEntity(entity)

    expect(await db.table('accounts').where('id', created.get('id')).get()).toMatchObject([{ name: 'Grace' }])
  })
})
