import { describe, expect, it, vi } from 'vitest'
import {
  createDeferredDatabaseDriverAdapter,
  DeferredDatabaseDriverAdapter,
  getDatabaseDriverFactory,
  registerDatabaseDriverFactory,
  unregisterDatabaseDriverFactory,
  type DriverAdapter,
  type DriverQueryResult,
} from '../src'
import { normalizeSavepointName } from '../src/drivers/savepoints'

function createAdapter(): DriverAdapter {
  return {
    initialize: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isConnected: () => true,
    async query<TRow extends Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> {
      return { rows: [], rowCount: 0 }
    },
    execute: vi.fn(async () => ({ affectedRows: 1 })),
    beginTransaction: vi.fn(async () => {}),
    commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  }
}

describe('database driver registry', () => {
  it('registers factories and resolves adapters lazily', async () => {
    const concrete = createAdapter()
    const factory = { driver: 'contract-driver', create: vi.fn(() => concrete) }
    registerDatabaseDriverFactory(factory)
    registerDatabaseDriverFactory(factory)
    expect(getDatabaseDriverFactory('contract-driver')).toBe(factory)

    const deferred = createDeferredDatabaseDriverAdapter('contract-driver', { url: 'contract://db' })
    expect(deferred.isConnected()).toBe(false)
    await deferred.initialize()
    expect(factory.create).toHaveBeenCalledWith({ url: 'contract://db' })
    expect(await deferred.query('select 1')).toEqual({ rows: [], rowCount: 0 })
    expect(await deferred.execute('update records')).toEqual({ affectedRows: 1 })
    await deferred.beginTransaction()
    await deferred.commit()
    await deferred.rollback()
    await deferred.disconnect()
  })

  it('rejects invalid, duplicate, and missing factories', async () => {
    expect(() => registerDatabaseDriverFactory({ driver: '', create: createAdapter })).toThrow(TypeError)
    expect(() => registerDatabaseDriverFactory({ driver: 'invalid-create', create: undefined } as never)).toThrow(TypeError)
    registerDatabaseDriverFactory({ driver: 'duplicate-driver', create: createAdapter })
    expect(() => registerDatabaseDriverFactory({ driver: 'duplicate-driver', create: createAdapter })).toThrow('already registered')
    await expect(createDeferredDatabaseDriverAdapter('missing-driver', {}).initialize()).rejects.toThrow('is not registered')
  })

  it('unregisters only the currently registered factory', () => {
    const factory = { driver: 'unregister-driver', create: createAdapter }
    const other = { driver: 'unregister-driver', create: createAdapter }
    registerDatabaseDriverFactory(factory)
    unregisterDatabaseDriverFactory(other)
    expect(getDatabaseDriverFactory('unregister-driver')).toBe(factory)
    unregisterDatabaseDriverFactory(factory)
    expect(getDatabaseDriverFactory('unregister-driver')).toBeUndefined()
  })

  it('delegates every optional driver capability and resolves concurrent calls once', async () => {
    const callback = vi.fn(async () => 'scope-result')
    const runWithTransactionScope = vi.fn(async (run: () => Promise<unknown>) => await run()) as NonNullable<DriverAdapter['runWithTransactionScope']>
    const migrationState = { foreignKeysWereEnabled: true }
    const adapter: DriverAdapter = {
      ...createAdapter(),
      ensureDatabaseExists: vi.fn(async () => {}),
      isDatabaseMissingError: vi.fn(() => true),
      runWithTransactionScope,
      beforeMigrationTransaction: vi.fn(async () => migrationState),
      validateMigrationTransaction: vi.fn(async () => {}),
      afterMigrationTransaction: vi.fn(async () => {}),
      async introspect<TRow extends Record<string, unknown>>(): Promise<DriverQueryResult<TRow>> {
        return { rows: [{ name: 'users' } as unknown as TRow], rowCount: 1 }
      },
      createSavepoint: vi.fn(async () => {}),
      rollbackToSavepoint: vi.fn(async () => {}),
      releaseSavepoint: vi.fn(async () => {}),
    }
    const factory = {
      driver: 'full-driver',
      supportsConcurrentTransactionScopes: true,
      create: vi.fn(() => adapter),
    }
    registerDatabaseDriverFactory(factory)
    const deferred = new DeferredDatabaseDriverAdapter('full-driver', {})
    expect(deferred.supportsConcurrentTransactionScopes).toBe(true)
    await Promise.all([deferred.initialize(), deferred.ensureDatabaseExists()])
    expect(factory.create).toHaveBeenCalledOnce()
    expect(deferred.isDatabaseMissingError(new Error('missing'))).toBe(true)
    await expect(deferred.runWithTransactionScope(callback)).resolves.toBe('scope-result')
    await expect(deferred.beforeMigrationTransaction()).resolves.toBe(migrationState)
    await deferred.validateMigrationTransaction()
    await deferred.afterMigrationTransaction(migrationState)
    expect(adapter.validateMigrationTransaction).toHaveBeenCalledOnce()
    expect(adapter.afterMigrationTransaction).toHaveBeenCalledWith(migrationState)
    await expect(deferred.introspect('pragma tables')).resolves.toEqual({ rows: [{ name: 'users' }], rowCount: 1 })
    await deferred.createSavepoint?.('sp_1')
    await deferred.rollbackToSavepoint?.('sp_1')
    await deferred.releaseSavepoint?.('sp_1')
    expect(adapter.createSavepoint).toHaveBeenCalledWith('sp_1', undefined)
    expect(adapter.rollbackToSavepoint).toHaveBeenCalledWith('sp_1', undefined)
    expect(adapter.releaseSavepoint).toHaveBeenCalledWith('sp_1', undefined)
  })

  it('uses safe optional-capability fallbacks and rejects unsupported savepoints', async () => {
    const adapter = createAdapter()
    const factory = { driver: 'minimal-driver', create: vi.fn(() => adapter) }
    registerDatabaseDriverFactory(factory)
    const unresolved = new DeferredDatabaseDriverAdapter('minimal-driver', {})
    await unresolved.disconnect()
    expect(factory.create).not.toHaveBeenCalled()
    expect(unresolved.supportsConcurrentTransactionScopes).toBe(false)
    expect(unresolved.isDatabaseMissingError(new Error('missing'))).toBe(false)
    await unresolved.ensureDatabaseExists()
    await expect(unresolved.runWithTransactionScope(async () => 'fallback')).resolves.toBe('fallback')
    await expect(unresolved.beforeMigrationTransaction()).resolves.toBeUndefined()
    await expect(unresolved.validateMigrationTransaction()).resolves.toBeUndefined()
    await expect(unresolved.afterMigrationTransaction(undefined)).resolves.toBeUndefined()
    await expect(unresolved.introspect('select 1')).resolves.toEqual({ rows: [], rowCount: 0 })
    await expect(unresolved.createSavepoint?.('sp_1')).rejects.toThrow('does not support createSavepoint')
    await expect(unresolved.rollbackToSavepoint?.('sp_1')).rejects.toThrow('does not support rollbackToSavepoint')
    await expect(unresolved.releaseSavepoint?.('sp_1')).rejects.toThrow('does not support releaseSavepoint')
  })

  it('normalizes safe savepoint identifiers', () => {
    expect(normalizeSavepointName('SP_1')).toBe('SP_1')
    expect(() => normalizeSavepointName('bad-name')).toThrow('Invalid savepoint name')
  })
})
