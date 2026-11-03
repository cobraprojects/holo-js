import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { DB, clearGeneratedTables, defineModel, holoRuntimeInternals, registerGeneratedTables, resetDB } from '../src'
import { openDatabase } from './support/database'

const { createSchemaReader } = holoRuntimeInternals

afterEach(() => {
  resetDB()
  clearGeneratedTables()
})

async function openGeneratedTable(dialect: 'sqlite' | 'postgres' | 'mysql') {
  const { db, schema } = await openDatabase(dialect)
  const name = `json_text_${randomUUID().replaceAll('-', '').slice(0, 20)}`
  onTestFinished(() => schema.dropTable(name))
  await schema.createTable(name, table => {
    table.id()
    table.json('settings')
    table.text('notes')
  })
  const generated = await createSchemaReader(db).readTable(name)
  registerGeneratedTables({ [name]: generated! })
  return { name, generated: generated! }
}

describe('SQLite JSON stored as text', () => {
  it('queries and updates JSON paths of a text column on a table named by string', async () => {
    const { name, generated } = await openGeneratedTable('sqlite')
    expect(generated.columns.settings?.kind).toBe('text')
    await DB.table(name).insert([
      { settings: JSON.stringify({ region: 'eu', tags: ['a', 'b'] }), notes: 'first' },
      { settings: JSON.stringify({ region: 'us', tags: [] }), notes: 'second' },
    ])

    expect(await DB.table(name).where('settings->region', 'eu').pluck('notes')).toEqual(['first'])
    expect(await DB.table(name).whereJson('settings->region', 'us').pluck('notes')).toEqual(['second'])
    expect(await DB.table(name).whereJsonContains('settings->tags', 'b').pluck('notes')).toEqual(['first'])
    expect(await DB.table(name).whereJsonLength('settings->tags', 0).pluck('notes')).toEqual(['second'])
    expect(await DB.table(name).whereJsonContainsKey('settings->region').count()).toBe(2)
    expect(await DB.table(name).whereLike('settings->region', 'e%').pluck('notes')).toEqual(['first'])

    await DB.table(name).where('notes', 'second').update({ 'settings->region': 'mena' })

    expect(await DB.table(name).whereJson('settings->region', 'mena').pluck('notes')).toEqual(['second'])
  })

  it('queries and updates JSON paths of a text column through a json-cast model', async () => {
    const { name } = await openGeneratedTable('sqlite')
    const Record = defineModel(name, { timestamps: false, fillable: ['settings', 'notes'], casts: { settings: 'json' } })
    const record = await Record.create({ settings: { region: 'eu' }, notes: 'first' })

    expect(await Record.whereJson('settings->region', 'eu').pluck('notes')).toEqual(['first'])

    await Record.update(record.id, { 'settings->region': 'mena' })

    expect((await Record.findOrFail(record.id)).settings).toEqual({ region: 'mena' })
  })

  it('keeps rejecting malformed JSON paths on a text column', async () => {
    const { name } = await openGeneratedTable('sqlite')

    expect(() => DB.table(name).whereJson('settings->>region', 'eu')).toThrow('portable JSON path syntax')
    expect(() => DB.table(name).whereJson('settings->', 'eu')).toThrow('malformed JSON path')
  })
})

describe.each(['postgres', 'mysql'] as const)('%s text columns', dialect => {
  const enabled = process.env[`HOLO_${dialect.toUpperCase()}_INTEGRATION`] === '1'

  it.runIf(enabled)('rejects JSON paths on a text column, which the database does not store as JSON', async () => {
    const { name } = await openGeneratedTable(dialect)
    const Record = defineModel(name, { timestamps: false, fillable: ['settings', 'notes'] })
    const record = await Record.create({ settings: { region: 'us' }, notes: 'first' })

    expect(() => DB.table(name).whereJson('notes->region', 'eu')).toThrow('whereJson() requires "notes" to be a JSON column.')
    await expect(DB.table(name).update({ 'notes->region': 'eu' })).rejects.toThrow('update() requires "notes" to be a JSON column.')
    await expect(Record.update(record.id, { 'notes->region': 'eu' } as never)).rejects.toThrow('Column "notes" must be a JSON column to support nested JSON updates.')
    expect(await DB.table(name).whereJson('settings->region', 'eu').count()).toBe(0)
  })
})
