import { afterEach, describe, expect, it } from 'vitest'
import { clearGeneratedTables, column, defineGeneratedTable, defineModel, registerGeneratedTables, resetDB } from '../src'

describe('a model resolved before any connection is configured', () => {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('takes the Generated schema table only when it names the connection the schema was read from', () => {
    const notes = defineGeneratedTable('notes', { id: column.id(), heading: column.string() })
    registerGeneratedTables({ notes }, { connectionName: 'main' })

    const Secondary = defineModel('notes', { name: 'SecondaryNote', connectionName: 'secondary', softDeletes: true })
    const Main = defineModel('notes', { name: 'MainNote', connectionName: 'main' })
    const Default = defineModel('notes', { name: 'DefaultNote' })

    expect(Secondary.definition.untyped).toBe(true)
    expect(Secondary.definition.deletedAtColumn).toBe('deleted_at')
    expect(Secondary.definition.createdAtColumn).toBe('created_at')
    expect(Main.definition.table).toBe(notes)
    expect(Default.definition.table).toBe(notes)
  })
})
