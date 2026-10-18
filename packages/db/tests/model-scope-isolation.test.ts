import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, hasMany, resetDB } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { createTestTable } from './support/schema'

beforeEach(() => resetDB())

async function createModels(softDeletes = true) {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  onTestFinished(() => adapter.disconnect())
  const db = createDatabase({ adapter, dialect: createDialect('sqlite') })
  configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: db } }))
  const parents = defineTable('parents', { id: column.integer().primaryKey() })
  const records = defineTable('records', {
    id: column.integer().primaryKey(), parent_id: column.integer(), tenant_id: column.integer(),
    name: column.string(), visible: column.boolean(), deleted_at: column.timestamp().nullable(),
  })
  await createTestTable(db, parents)
  await createTestTable(db, records)
  const Record = defineModelFromTable(records, {
    name: 'ScopedRecord', softDeletes, fillable: ['name'],
    globalScopes: {
      tenant: query => query.where('tenant_id', 1).orWhere('tenant_id', 2),
      visible: query => query.where('visible', true),
    },
  })
  const Parent = defineModelFromTable(parents, { relations: { records: hasMany(() => Record, { foreignKey: 'parent_id' }) } })
  await db.table(parents).insert([{ id: 1 }, { id: 2 }, { id: 3 }])
  await db.table(records).insert([
    { id: 1, parent_id: 1, tenant_id: 1, name: 'allowed', visible: true, deleted_at: null },
    { id: 2, parent_id: 1, tenant_id: 2, name: 'second', visible: true, deleted_at: null },
    { id: 3, parent_id: 2, tenant_id: 3, name: 'foreign', visible: true, deleted_at: null },
    { id: 4, parent_id: 3, tenant_id: 1, name: 'deleted', visible: true, deleted_at: '2026-01-01T00:00:00.000Z' },
    { id: 5, parent_id: 2, tenant_id: 1, name: 'hidden', visible: false, deleted_at: null },
  ])
  return { Record, Parent }
}

describe('model scope isolation', () => {
  it.each([false, true])('limits instance updates to their target with soft deletes %s', async (softDeletes) => {
    const { Record } = await createModels(softDeletes)
    const record = await Record.findOrFail(1)
    await record.update({ name: 'updated' })
    expect(await Record.withoutGlobalScopes().orderBy('id').pluck('name')).toEqual(['updated', 'second', 'foreign', 'deleted', 'hidden'])
  })

  it.each([false, true])('limits instance deletes to their target with soft deletes %s', async (softDeletes) => {
    const { Record } = await createModels(softDeletes)
    await (await Record.findOrFail(1)).delete()
    expect(await Record.withoutGlobalScopes().whereNull('deleted_at').orderBy('id').pluck('id')).toEqual([2, 3, 5])
  })

  it('keeps eager-load constraints within scopes, soft deletes and parent keys', async () => {
    const { Parent } = await createModels()
    const parents = await Parent.with('records', query => query.where('id', 1).orWhere('id', '>', 1)).orderBy('id').get()
    expect(parents.map(parent => parent.toJSON())).toMatchObject([
      { id: 1, records: [{ id: 1 }, { id: 2 }] },
      { id: 2, records: [] },
      { id: 3, records: [] },
    ])
  })

  it('keeps whereHas constraints within scopes and soft deletes', async () => {
    const { Parent } = await createModels()
    expect(await Parent.whereHas('records', query => query.where('id', 1).orWhere('id', '>', 1)).pluck('id')).toEqual([1])
  })

  it('keeps caller OR conditions inside every global scope and the soft-delete filter', async () => {
    const { Record } = await createModels()
    expect(await Record.where('id', 1).orWhere('id', '>', 1).orderBy('id').pluck('id')).toEqual([1, 2])
    expect(await Record.withTrashed().where('id', 1).orWhere('id', '>', 1).orderBy('id').pluck('id')).toEqual([1, 2, 4])
    expect(await Record.onlyTrashed().where('id', 1).orWhere('id', '>', 1).pluck('id')).toEqual([4])
    expect(await Record.withoutGlobalScope('tenant').orderBy('id').pluck('id')).toEqual([1, 2, 3])
  })
})
