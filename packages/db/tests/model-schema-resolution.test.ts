import { afterEach, describe, expect, it } from 'vitest'
import { clearGeneratedTables, column, defineGeneratedTable, defineModel, holoRuntimeInternals, registerGeneratedTables, resetDB } from '../src'

describe('a model resolved before any connection is configured', () => {
  afterEach(() => {
    resetDB()
    clearGeneratedTables()
  })

  it('takes the Generated schema table only when it names the default connection given at registration', () => {
    const notes = defineGeneratedTable('notes', { id: column.id(), heading: column.string() })
    registerGeneratedTables({ notes })
    const restore = holoRuntimeInternals.useGeneratedSchemaConnection('main')

    try {
      const Secondary = defineModel('notes', { name: 'SecondaryNote', connectionName: 'secondary', softDeletes: true })
      const Main = defineModel('notes', { name: 'MainNote', connectionName: 'main' })
      const Default = defineModel('notes', { name: 'DefaultNote' })

      expect(Secondary.definition.untyped).toBe(true)
      expect(Secondary.definition.deletedAtColumn).toBe('deleted_at')
      expect(Secondary.definition.createdAtColumn).toBe('created_at')
      expect(Main.definition.table).toBe(notes)
      expect(Default.definition.table).toBe(notes)
    } finally {
      restore()
    }
  })

  it('names the default connection from the database config as the runtime does', () => {
    const { resolveRuntimeDefaultConnectionName } = holoRuntimeInternals

    expect(resolveRuntimeDefaultConnectionName({ db: { defaultConnection: 'main', connections: { main: {}, secondary: {} } } })).toBe('main')
    expect(resolveRuntimeDefaultConnectionName({ db: { connections: { secondary: {}, default: {} } } })).toBe('default')
    expect(resolveRuntimeDefaultConnectionName({ db: { connections: { reporting: {} } } })).toBe('reporting')
    expect(resolveRuntimeDefaultConnectionName({})).toBe('default')
  })
})
