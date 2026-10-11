import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, resetDB } from '../src'

describe('documented transaction table queries', () => {
  afterEach(() => resetDB())

  it.each(['transaction', 'writeTransaction'] as const)('commits and rolls back table writes through %s', async method => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    configureDB(createConnectionManager({
      defaultConnection: 'default',
      connections: { default: { adapter, dialect: createDialect('sqlite') } },
    }))
    const users = defineGeneratedTable('users', { id: column.id(), name: column.string() })

    try {
      await adapter.execute('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      const id = await DB[method](async tx => {
        const id = await tx.table(users).insertGetId({ name: 'Ava' })
        expect(await tx.table(users).where('id', id).value('name')).toBe('Ava')
        return id
      })
      expect(await DB.table(users).where('id', id).value('name')).toBe('Ava')

      await expect(DB[method](async tx => {
        await tx.table('users').insert({ name: 'Rolled back' })
        throw new Error('provisioning failed')
      })).rejects.toThrow('provisioning failed')
      expect(await DB.table(users).pluck('name')).toEqual(['Ava'])
    } finally {
      await adapter.disconnect()
    }
  })
})
