import { beforeEach, describe, expect, it } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, defineGeneratedTable, defineModel } from '../src'
import { ModelRepository } from '../src/model/ModelRepository'
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
    expect(readsRowsAsStored(defineModel('stored_untyped_plain_notes', { connectionName: 'stored_untyped', timestamps: false }))).toBe(true)
  })
})
