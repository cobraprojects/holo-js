import { beforeEach, describe, expect, it } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel } from '../src'
import { ModelRepository } from '../src/model/ModelRepository'
import { openDatabase } from './support/database'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'

function readsRowsAsStored(model: Parameters<typeof ModelRepository.from>[0]): boolean {
  return ModelRepository.from(model).readsRowsAsStored()
}

describe('model rows read as stored', () => {
  beforeEach(() => {
    const connection = (name: string) => createDatabase({ connectionName: name, adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
    configureDB(createConnectionManager({ defaultConnection: 'default', connections: { default: connection('default'), stored_untyped: connection('stored_untyped') } }))
  })

  it('treats scalar typed models as read as stored', () => {
    const notes = defineGeneratedTable('stored_scalar_notes', { id: column.id(), body: column.string(), active: column.boolean() })
    expect(readsRowsAsStored(defineModel(notes, { timestamps: false }))).toBe(true)
  })

  it('treats typed models with converted columns or casts as converted', () => {
    const notes = defineGeneratedTable('stored_dated_notes', { id: column.id(), body: column.string(), created_at: column.timestamp(), updated_at: column.timestamp() })
    const plain = defineGeneratedTable('stored_cast_notes', { id: column.id(), body: column.string() })
    expect(readsRowsAsStored(defineModel(notes))).toBe(false)
    expect(readsRowsAsStored(defineModel(plain, { timestamps: false, casts: { body: 'json' } }))).toBe(false)
  })

  it('treats untyped models with timestamps as converted', () => {
    expect(readsRowsAsStored(defineModel('stored_untyped_notes', { connectionName: 'stored_untyped' }))).toBe(false)
    expect(readsRowsAsStored(defineModel('stored_untyped_plain_notes', { connectionName: 'stored_untyped', timestamps: false, primaryKey: 'uuid' }))).toBe(true)
    expect(readsRowsAsStored(defineModel('stored_untyped_cast_notes', { connectionName: 'stored_untyped', timestamps: false, casts: { secret: { get: value => `masked:${String(value)}` } } }))).toBe(false)
  })

  it('reads rows with the dialect of the connection a model is used on', () => {
    const notes = defineGeneratedTable('stored_json_notes', { id: column.id(), settings: column.json() })
    const Note = defineModel(notes, { timestamps: false })
    const sqlite = createDatabase({ connectionName: 'default', adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('sqlite') })
    const postgres = createDatabase({ connectionName: 'default', adapter: createSQLiteAdapter({ filename: ':memory:' }), dialect: createDialect('postgres') })

    expect(sqlite.model(Note).rowReader()?.({ settings: '{"x":1}' })).toEqual({ settings: { x: 1 } })
    expect(postgres.model(Note).rowReader()?.({ settings: '{"x":1}' })).toEqual({ settings: '{"x":1}' })
  })

  it('applies casts once per plucked row outside realtime', async () => {
    const { db, schema } = await openDatabase('sqlite')
    await schema.createTable('stored_plucked_notes', (table) => {
      table.id()
      table.string('body')
    })
    const notes = defineGeneratedTable('stored_plucked_notes', { id: column.id(), body: column.string() })
    await db.table(notes).insert([{ id: 1, body: 'a' }, { id: 2, body: 'b' }])
    let reads = 0
    const Note = defineModel(notes, { timestamps: false, casts: { body: { get: (value) => {
      reads += 1
      return `cast:${String(value)}`
    } } } })

    expect(await db.model(Note).query().orderBy('id').pluck('body')).toEqual(['cast:a', 'cast:b'])
    expect(reads).toBe(2)
  })

  it('constructs an observer class at most once to look for a retrieved handler', () => {
    let constructed = 0
    class CountingObserver {
      constructor() {
        constructed += 1
      }

      retrieved() {
        return undefined
      }
    }
    const notes = defineGeneratedTable('stored_observed_notes', { id: column.id(), body: column.string() })
    const Note = defineModel(notes, { timestamps: false, observers: [CountingObserver] })
    const repository = ModelRepository.from(Note)

    expect(repository.serializesBeyondRows()).toBe(true)
    expect(repository.serializesBeyondRows()).toBe(true)
    expect(constructed).toBe(0)
  })

  it('detects retrieved handlers an observer assigns when it is constructed', () => {
    let enabled = false
    class ConditionalObserver {
      retrieved?: () => undefined

      constructor() {
        if (enabled) this.retrieved = () => undefined
      }

      get service(): never {
        throw new Error('The service is only available during a request.')
      }
    }
    const notes = defineGeneratedTable('stored_conditional_notes', { id: column.id(), body: column.string() })
    const Note = defineModel(notes, { timestamps: false, observers: [ConditionalObserver] })
    const repository = ModelRepository.from(Note)

    expect(repository.serializesBeyondRows()).toBe(false)
    enabled = true
    expect(repository.serializesBeyondRows()).toBe(true)
  })

  it('normalizes untyped incrementing keys in realtime row reads', () => {
    const Note = defineModel('stored_untyped_keyed_notes', { connectionName: 'stored_untyped', timestamps: false })
    const repository = ModelRepository.from(Note)

    expect(repository.readsRowsAsStored()).toBe(false)
    expect(repository.rowReader()?.({ id: '1', body: 'a' })).toEqual({ id: 1, body: 'a' })
  })

  it('treats date casts on text columns as able to reject stored values', () => {
    const dated = defineGeneratedTable('stored_dated_columns', { id: column.id(), born_on: column.date(), body: column.string() })
    const texted = defineGeneratedTable('stored_texted_dates', { id: column.id(), born_on: column.string() })

    expect(ModelRepository.from(defineModel(dated, { timestamps: false, casts: { born_on: 'date' } })).readsWithoutRejectingValues()).toBe(true)
    expect(ModelRepository.from(defineModel(texted, { timestamps: false, casts: { born_on: 'date' } })).readsWithoutRejectingValues()).toBe(false)
  })
})
