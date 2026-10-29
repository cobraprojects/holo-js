import authorization, { authorizationInternals, definePolicy } from '@holo-js/authorization'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import {
  DB,
  clearGeneratedTables,
  column,
  configureDB,
  createConnectionManager,
  createDatabase,
  createDialect,
  hasMany,
  resetDB,
  resetGlobalModelRegistry,
  type DatabaseContext,
  type ModelRecord,
} from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

const tenants = defineTable('tenants', {
  id: column.id(),
  name: column.string(),
  active: column.boolean(),
  settings: column.json<{ plan: string }>(),
})

const members = defineTable('members', {
  id: column.id(),
  tenant_id: column.foreignId(),
  email: column.string(),
})

function openDatabase(): DatabaseContext {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  return createDatabase({ adapter, dialect: createDialect('sqlite') })
}

describe('Model.hydrate()', () => {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
    resetGlobalModelRegistry()
    authorizationInternals.resetAuthorizationRuntimeState()
  })

  it('builds a persisted model from a row read in a transaction on another connection', async () => {
    const defaultDb = openDatabase()
    const platformDb = openDatabase()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: defaultDb, platform: platformDb },
    }))
    await createTestTable(defaultDb, tenants)
    await defaultDb.table(tenants).insert({ id: 7, name: 'Acme', active: true, settings: { plan: 'pro' } })
    const retrieved: unknown[] = []
    const Tenant = defineModelFromTable(tenants, {
      connectionName: 'platform',
      fillable: ['name'],
      events: { retrieved: [entity => { retrieved.push(entity) }] },
    })

    const tenant = await DB.transaction(async (tx) => {
      const row = await tx.table(Tenant.definition.table).where('id', 7).lockForUpdate().first()
      if (!row) {
        throw new Error('Expected the tenant row.')
      }

      return Tenant.hydrate(row)
    })

    expectTypeOf(tenant.toAttributes()).toEqualTypeOf<ModelRecord<typeof tenants>>()
    expect(tenant.exists()).toBe(true)
    expect(tenant.isClean()).toBe(true)
    expect(tenant.toAttributes()).toEqual({ id: 7, name: 'Acme', active: true, settings: { plan: 'pro' } })
    expect(retrieved).toEqual([tenant])
  })

  it('authorizes and loads relations like a model returned by find()', async () => {
    const db = openDatabase()
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
    await createTestTable(db, tenants)
    await createTestTable(db, members)
    await db.table(tenants).insert([
      { id: 7, name: 'Acme', active: true, settings: { plan: 'pro' } },
      { id: 8, name: 'Closed', active: false, settings: { plan: 'free' } },
    ])
    await db.table(members).insert([
      { id: 1, tenant_id: 7, email: 'ada@example.com' },
      { id: 2, tenant_id: 8, email: 'grace@example.com' },
    ])
    const Member = defineModelFromTable(members, { name: 'Member', fillable: ['email'] })
    const Tenant = defineModelFromTable(tenants, {
      name: 'Tenant',
      fillable: ['name'],
      relations: { members: hasMany(() => Member, 'tenant_id') },
    })
    definePolicy('tenants', Tenant, {
      record: { manageTeam: (_context, tenant) => tenant.active },
    })
    const [active, closed] = await Promise.all(
      (await db.table(tenants).orderBy('id').get()).map(row => Tenant.hydrate(row)),
    )
    if (!active || !closed) {
      throw new Error('Expected both tenant rows.')
    }

    const loaded = await active.load('members')
    const actor = authorization.forUser({ id: 1 })

    expect(loaded.members.map(member => member.email)).toEqual(['ada@example.com'])
    await expect(actor.can('manageTeam', active)).resolves.toBe(true)
    await expect(actor.can('manageTeam', closed)).resolves.toBe(false)
  })
})
