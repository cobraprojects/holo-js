import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeferredDatabaseDriverAdapter,
  getDatabaseDriverFactory,
  registerDatabaseDriverFactory,
  unregisterDatabaseDriverFactory,
  type DatabaseDriverFactory,
  type DriverAdapter,
} from '../src'

const factories: DatabaseDriverFactory[] = []
const adapters: DriverAdapter[] = []

function register(factory: DatabaseDriverFactory): void {
  registerDatabaseDriverFactory(factory)
  factories.push(factory)
}

function createAdapter(): DriverAdapter {
  const adapter = createSQLiteAdapter({ filename: ':memory:' })
  adapters.push(adapter)
  return adapter
}

function registerSQLite(driver: string): DriverAdapter {
  register({
    driver,
    create(connection) {
      const adapter = createSQLiteAdapter({ filename: connection.url })
      adapters.push(adapter)
      return adapter
    },
  })
  return createDeferredDatabaseDriverAdapter(driver, { url: ':memory:' })
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.disconnect()))
  for (const factory of factories.splice(0)) unregisterDatabaseDriverFactory(factory)
})

describe('registered database drivers', () => {
  it('opens a real database lazily and commits and rolls back writes', async () => {
    const deferred = registerSQLite('contract-driver')
    expect(deferred.isConnected()).toBe(false)
    await deferred.initialize()
    expect(deferred.isConnected()).toBe(true)
    await deferred.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    await deferred.beginTransaction()
    await deferred.execute('INSERT INTO records (value) VALUES (?)', ['committed'])
    await deferred.commit()
    await deferred.beginTransaction()
    await deferred.execute('INSERT INTO records (value) VALUES (?)', ['rolled back'])
    await deferred.rollback()
    expect((await deferred.query('SELECT value FROM records')).rows).toEqual([{ value: 'committed' }])
    await deferred.disconnect()
    expect(deferred.isConnected()).toBe(false)
  })

  it('rejects invalid, duplicate, and missing factories', async () => {
    expect(() => registerDatabaseDriverFactory({ driver: '', create: createAdapter })).toThrow(TypeError)
    expect(() => registerDatabaseDriverFactory({ driver: 'invalid-create', create: undefined } as never)).toThrow(TypeError)
    register({ driver: 'duplicate-driver', create: createAdapter })
    expect(() => registerDatabaseDriverFactory({ driver: 'duplicate-driver', create: createAdapter })).toThrow('already registered')
    await expect(createDeferredDatabaseDriverAdapter('missing-driver', {}).initialize()).rejects.toThrow('is not registered')
  })

  it('unregisters only the currently registered factory', () => {
    const factory = { driver: 'unregister-driver', create: createAdapter }
    register(factory)
    registerDatabaseDriverFactory(factory)
    const other = { driver: 'unregister-driver', create: createAdapter }
    unregisterDatabaseDriverFactory(other)
    expect(getDatabaseDriverFactory('unregister-driver')).toBe(factory)
    unregisterDatabaseDriverFactory(factory)
    expect(getDatabaseDriverFactory('unregister-driver')).toBeUndefined()
  })

  it('retains one database across concurrent initialization and supports introspection and savepoints', async () => {
    const deferred = registerSQLite('concurrent-driver')
    await Promise.all([deferred.initialize(), deferred.initialize()])
    await deferred.execute('CREATE TABLE records (value TEXT NOT NULL)')
    expect((await deferred.introspect?.("SELECT name FROM sqlite_master WHERE type = 'table'"))?.rows).toEqual([{ name: 'records' }])
    await deferred.runWithTransactionScope?.(async () => {
      await deferred.beginTransaction()
      await deferred.execute('INSERT INTO records VALUES (?)', ['kept'])
      await deferred.createSavepoint?.('SP_1')
      await deferred.execute('INSERT INTO records VALUES (?)', ['discarded'])
      await deferred.rollbackToSavepoint?.('SP_1')
      await deferred.releaseSavepoint?.('SP_1')
      await deferred.commit()
    })
    expect((await deferred.query('SELECT value FROM records')).rows).toEqual([{ value: 'kept' }])
    await expect(deferred.createSavepoint?.('bad-name')).rejects.toThrow('Invalid savepoint name')
  })

  it('validates migration foreign keys and restores enforcement', async () => {
    const deferred = registerSQLite('migration-driver')
    await deferred.initialize()
    await deferred.execute('PRAGMA foreign_keys = ON')
    await deferred.execute('CREATE TABLE parents (id INTEGER PRIMARY KEY)')
    await deferred.execute('CREATE TABLE children (parent_id INTEGER REFERENCES parents(id))')
    const state = await deferred.beforeMigrationTransaction?.()
    await deferred.execute('INSERT INTO children VALUES (99)')
    await expect(deferred.validateMigrationTransaction?.()).rejects.toThrow('foreign key violation')
    await deferred.execute('DELETE FROM children')
    await deferred.validateMigrationTransaction?.()
    await deferred.afterMigrationTransaction?.(state)
    await expect(deferred.execute('INSERT INTO children VALUES (99)')).rejects.toThrow(/foreign key/i)
  })

  it('uses real queries for introspection when a driver omits optional capabilities', async () => {
    register({
      driver: 'minimal-driver',
      create() {
        const adapter = createAdapter()
        return {
          initialize: adapter.initialize.bind(adapter),
          disconnect: adapter.disconnect.bind(adapter),
          isConnected: adapter.isConnected.bind(adapter),
          query: adapter.query.bind(adapter),
          execute: adapter.execute.bind(adapter),
          beginTransaction: adapter.beginTransaction.bind(adapter),
          commit: adapter.commit.bind(adapter),
          rollback: adapter.rollback.bind(adapter),
        }
      },
    })
    const deferred = createDeferredDatabaseDriverAdapter('minimal-driver', {})
    await deferred.disconnect()
    expect(deferred.isConnected()).toBe(false)
    expect(deferred.supportsConcurrentTransactionScopes).toBe(false)
    expect(deferred.isDatabaseMissingError?.(new Error('missing'))).toBe(false)
    await deferred.ensureDatabaseExists?.()
    expect((await deferred.introspect?.('SELECT 1 AS value'))?.rows).toEqual([{ value: 1 }])
    await expect(deferred.runWithTransactionScope?.(async () => (await deferred.query('SELECT 2 AS value')).rows)).resolves.toEqual([{ value: 2 }])
    await expect(deferred.beforeMigrationTransaction?.()).resolves.toBeUndefined()
    await deferred.validateMigrationTransaction?.()
    await deferred.afterMigrationTransaction?.(undefined)
    await expect(deferred.createSavepoint?.('sp_1')).rejects.toThrow('does not support createSavepoint')
    await expect(deferred.rollbackToSavepoint?.('sp_1')).rejects.toThrow('does not support rollbackToSavepoint')
    await expect(deferred.releaseSavepoint?.('sp_1')).rejects.toThrow('does not support releaseSavepoint')
  })
})
