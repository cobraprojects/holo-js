import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { column, createDatabase, createDialect, createSchemaService, defineGeneratedTable } from '@holo-js/db'
import { createSQLiteAdapter } from '../src'

describe('SQLite boolean bindings without registered schema', () => {
  let directory: string
  let database: ReturnType<typeof createDatabase>

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'holo-sqlite-booleans-'))
    const filename = join(directory, 'database.sqlite')
    database = createDatabase({ adapter: createSQLiteAdapter({ filename }), dialect: createDialect('sqlite') })
    await createSchemaService(database).createTable('boolean_probe', table => {
      table.integer('id').primaryKey()
      table.boolean('enabled')
      table.json('settings').nullable()
    })
    await database.disconnect()
    database = createDatabase({ adapter: createSQLiteAdapter({ filename }), dialect: createDialect('sqlite') })
    await database.initialize()
  })

  afterEach(async () => {
    await database.disconnect()
    await rm(directory, { recursive: true, force: true })
  })

  it('writes and filters booleans on an existing table and keeps failed writes atomic', async () => {
    const records = database.table('boolean_probe')
    await records.insert([{ id: 1, enabled: true }, { id: 2, enabled: false }])
    expect(await records.orderBy('id').get()).toEqual([
      { id: 1, enabled: 1, settings: null },
      { id: 2, enabled: 0, settings: null },
    ])
    expect(await records.where('enabled', true).pluck('id')).toEqual([1])
    expect(await records.whereIn('enabled', [false]).pluck('id')).toEqual([2])
    expect(await records.whereBetween('enabled', [false, true]).count()).toBe(2)
    expect(await records.where('enabled', false).update({ enabled: true })).toMatchObject({ affectedRows: 1 })
    await records.upsert([{ id: 1, enabled: false }, { id: 3, enabled: true }], ['id'], ['enabled'])
    expect(await records.where('enabled', false).pluck('id')).toEqual([1])
    await expect(records.insert([{ id: 4, enabled: true }, { id: 1, enabled: false }])).rejects.toThrow()
    expect(await records.where('id', 4).exists()).toBe(false)
    await expect(records.where('enabled', true).update({ id: 1, enabled: false })).rejects.toThrow()
    expect(await records.where('enabled', true).orderBy('id').pluck('id')).toEqual([2, 3])
    expect(await records.where('enabled', false).delete()).toMatchObject({ affectedRows: 1 })
    expect(await records.orderBy('id').pluck('id')).toEqual([2, 3])
  })

  it('preserves JSON boolean values and schema-aware writes', async () => {
    const probe = defineGeneratedTable('boolean_probe', {
      id: column.integer().primaryKey(),
      enabled: column.boolean(),
      settings: column.json(),
    })
    const records = database.table(probe)
    await records.insert({ id: 1, enabled: true, settings: { enabled: true, flags: [false, true, 1] } })
    await records.insert({ id: 2, enabled: false, settings: true })
    expect(await records.where('enabled', true).value('enabled')).toBe(1)
    expect(await records.where('id', 2).value('settings')).toBe('true')
    await records.where('id', 1).update({ 'settings->enabled': false })
    expect(await records.whereJson('settings->enabled', false).pluck('id')).toEqual([1])
    expect(await records.whereJson('settings->enabled', 0).pluck('id')).toEqual([])
    expect(await records.whereJsonContains('settings->flags', true).pluck('id')).toEqual([1])
    expect(JSON.parse(String(await records.where('id', 1).value('settings')))).toEqual({
      enabled: false,
      flags: [false, true, 1],
    })
  })
})
