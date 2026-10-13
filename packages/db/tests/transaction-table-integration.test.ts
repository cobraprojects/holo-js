import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DB, column, configureDB, createConnectionManager, createDialect, defineGeneratedTable, resetDB } from '../src'

describe('documented transaction table queries', () => {
  afterEach(() => resetDB())

  it.each(['transaction', 'writeTransaction'] as const)('rolls back nested named %s writes with the outer transaction', async method => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    configureDB(createConnectionManager({
      defaultConnection: 'platform',
      connections: { platform: { adapter, dialect: createDialect('sqlite') } },
    }))
    const committed: string[] = []

    try {
      await adapter.execute('CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      await expect(DB[method](async tx => {
        await tx.table('tenants').insert({ name: 'Outer tenant' })
        await DB[method](async nested => {
          await nested.table('tenants').insert({ name: 'Nested tenant' })
          DB.afterCommit(() => { committed.push('nested') }, 'platform')
        }, 'platform')
        expect(committed).toEqual([])
        expect(await DB.table('tenants', 'platform').count()).toBe(2)
        throw new Error('first_owner_needs_seat')
      }, 'platform')).rejects.toThrow('first_owner_needs_seat')
      expect(await DB.connection('platform').table('tenants').count()).toBe(0)
      expect(committed).toEqual([])
    } finally {
      await adapter.disconnect()
    }
  })

  it('rolls back a failed named savepoint and flushes successful callbacks only after outer commit', async () => {
    const adapter = createSQLiteAdapter({ filename: ':memory:' })
    await adapter.initialize()
    configureDB(createConnectionManager({
      defaultConnection: 'platform',
      connections: { platform: { adapter, dialect: createDialect('sqlite') } },
    }))
    const committed: string[] = []

    try {
      await adapter.execute('CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
      await DB.transaction(async tx => {
        await tx.table('tenants').insert({ name: 'Outer tenant' })
        await expect(DB.transaction(async nested => {
          await nested.table('tenants').insert({ name: 'Failed tenant' })
          DB.afterCommit(() => { committed.push('failed') }, 'platform')
          throw new Error('configuration failed')
        }, 'platform')).rejects.toThrow('configuration failed')
        await DB.transaction(async nested => {
          await nested.table('tenants').insert({ name: 'Configured tenant' })
          DB.afterCommit(() => { committed.push('configured') }, 'platform')
        }, 'platform')
        expect(await DB.table('tenants', 'platform').pluck('name')).toEqual(['Outer tenant', 'Configured tenant'])
        expect(committed).toEqual([])
      }, 'platform')
      expect(committed).toEqual(['configured'])
      expect(await DB.table('tenants', 'platform').pluck('name')).toEqual(['Outer tenant', 'Configured tenant'])
    } finally {
      await adapter.disconnect()
    }
  })

  it('keeps a different named connection independent of an outer rollback', async () => {
    const platform = createSQLiteAdapter({ filename: ':memory:' })
    const audit = createSQLiteAdapter({ filename: ':memory:' })
    await Promise.all([platform.initialize(), audit.initialize()])
    const manager = createConnectionManager({
      defaultConnection: 'platform',
      connections: {
        platform: { adapter: platform, dialect: createDialect('sqlite') },
        audit: { adapter: audit, dialect: createDialect('sqlite') },
      },
    })
    configureDB(manager)
    const committed: string[] = []

    try {
      await Promise.all([platform, audit].map(adapter => adapter.execute('CREATE TABLE tenants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')))
      await expect(DB.transaction(async tx => {
        await tx.table('tenants').insert({ name: 'Rolled back' })
        await DB.transaction(async other => {
          await other.table('tenants').insert({ name: 'Independent' })
          DB.afterCommit(() => { committed.push('audit') }, 'audit')
        }, 'audit')
        expect(committed).toEqual(['audit'])
        throw new Error('provisioning failed')
      }, 'platform')).rejects.toThrow('provisioning failed')
      expect(await DB.table('tenants', 'platform').count()).toBe(0)
      expect(await DB.table('tenants', 'audit').pluck('name')).toEqual(['Independent'])
    } finally {
      await manager.disconnectAll()
    }
  })

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
