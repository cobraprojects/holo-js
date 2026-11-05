import { randomUUID } from 'node:crypto'
import { belongsToMany, column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { describe, expect, it, onTestFinished } from 'vitest'
import { integrationDrivers, openDatabase } from '../../db/tests/support/database'
import { defineRealtimeMutation, defineRealtimeQuery } from '../src'
import { configureRealtimeRuntime, executeRealtimeMutation, resetRealtimeRuntime, subscribeRealtimeQuery } from '../src/server'

const drivers = integrationDrivers(['sqlite', 'postgres', 'mysql'] as const)

function mutate(handler: () => Promise<unknown>) {
  return executeRealtimeMutation(defineRealtimeMutation({ access: 'public', handler }))
}

async function openFixture(driver: typeof drivers[number]) {
  const { db, schema } = await openDatabase(driver)
  onTestFinished(() => resetRealtimeRuntime())
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const groupsName = `holo_dup_groups_${suffix}`
  const tagsName = `holo_dup_tags_${suffix}`
  const pivotName = `holo_dup_members_${suffix}`
  await schema.createTable(groupsName, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(tagsName, (table) => {
    table.id()
    table.string('name')
  })
  await schema.createTable(pivotName, (table) => {
    table.id()
    table.bigInteger('group_id')
    table.bigInteger('tag_id')
    table.string('role')
    table.integer('position')
    table.string('note')
  })
  onTestFinished(async () => {
    await schema.dropTable(pivotName)
    await schema.dropTable(tagsName)
    await schema.dropTable(groupsName)
  })
  const groups = defineGeneratedTable(groupsName, { id: column.id(), name: column.string() })
  const tags = defineGeneratedTable(tagsName, { id: column.id(), name: column.string() })
  const members = defineGeneratedTable(pivotName, {
    id: column.id(),
    group_id: column.bigInteger(),
    tag_id: column.bigInteger(),
    role: column.string(),
    position: column.integer(),
    note: column.string(),
  })
  await db.table(groups).insert([{ id: 1, name: 'first' }, { id: 2, name: 'second' }])
  await db.table(tags).insert([{ id: 1, name: 'sale' }, { id: 2, name: 'new' }])
  await db.table(members).insert([
    { id: 1, group_id: 1, tag_id: 1, role: 'owner', position: 10, note: 'a' },
    { id: 2, group_id: 1, tag_id: 1, role: 'viewer', position: 20, note: 'a' },
    { id: 3, group_id: 1, tag_id: 2, role: 'editor', position: 30, note: 'a' },
    { id: 4, group_id: 1, tag_id: 2, role: 'editor', position: 30, note: 'b' },
    { id: 5, group_id: 2, tag_id: 1, role: 'owner', position: 10, note: 'a' },
  ])
  configureRealtimeRuntime({ db: () => db, loadAuthModule: async () => null })
  const Tag = defineModel(tags, { timestamps: false })
  const Group = defineModel(groups, {
    timestamps: false,
    relations: { tags: belongsToMany(() => Tag, members, 'group_id', 'tag_id').withPivot('role', 'position').orderByPivot('position') },
  })
  const subscribe = async () => {
    const handler = () => db.model(Group).query().with('tags').orderBy('id').getJson()
    const subscription = await subscribeRealtimeQuery(
      defineRealtimeQuery({ access: 'public', handler }),
      {},
      { onData: () => {}, onError: (error) => { throw error } },
    )
    return {
      subscription,
      expectFresh: async () => {
        expect(subscription.current.data).toEqual(await handler())
      },
    }
  }
  return { db, members, tags, subscribe }
}

describe.each(drivers)('realtime belongsToMany patching with duplicate pivot pairs on %s', (driver) => {
  it('keeps the eager subscription equal to a fresh query after updating one of two pivot rows for a pair', async () => {
    const { db, members, subscribe } = await openFixture(driver)
    const { expectFresh } = await subscribe()

    await mutate(() => db.table(members).where('id', 2).update({ position: 5 }))
    await expectFresh()
    await mutate(() => db.table(members).where('id', 1).update({ role: 'admin' }))
    await expectFresh()
    await mutate(() => db.table(members).where('id', 4).update({ position: 40 }))
    await expectFresh()
  })

  it('keeps the eager subscription equal to a fresh query after deleting one of two pivot rows for a pair', async () => {
    const { db, members, subscribe } = await openFixture(driver)
    const { expectFresh } = await subscribe()

    await mutate(() => db.table(members).where('id', 2).delete())
    await expectFresh()
    await mutate(() => db.table(members).where('id', 4).delete())
    await expectFresh()
  })

  it('keeps the eager subscription equal to a fresh query after inserting a second pivot row for a pair', async () => {
    const { db, members, subscribe } = await openFixture(driver)
    const { expectFresh } = await subscribe()

    await mutate(() => db.table(members).insert({ id: 6, group_id: 2, tag_id: 1, role: 'guest', position: 50, note: 'a' }))
    await expectFresh()
  })

  it('keeps every duplicate entry equal to a fresh query after the related row changes', async () => {
    const { db, tags, subscribe } = await openFixture(driver)
    const { expectFresh } = await subscribe()

    await mutate(() => db.table(tags).where('id', 1).update({ name: 'clearance' }))
    await expectFresh()
    await mutate(() => db.table(tags).where('id', 2).delete())
    await expectFresh()
  })
})
