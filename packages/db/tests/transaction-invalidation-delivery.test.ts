import { describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { DB, clearGeneratedTables, column, configureDatabaseQueryCacheBridge, onDatabaseDependencyInvalidated, resetDatabaseDependencyInvalidationListeners, registerGeneratedTables, resetDatabaseQueryCacheBridge, type DatabaseDependencyInvalidationEvent } from '../src'
import type { DatabaseMutationEvent } from '../src/cache'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

async function openItems() {
  const { adapter } = await openDatabase('sqlite')
  registerGeneratedTables({
    items: defineTable('items', { id: column.integer().primaryKey(), label: column.string() }),
  })
  onTestFinished(() => {
    resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
    resetDatabaseQueryCacheBridge()
  })
  await adapter.execute('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)')
  await adapter.execute(`INSERT INTO items (id, label) VALUES (1, 'one'), (2, 'two')`)
}

function pause(milliseconds: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, milliseconds) })
}

describe('transaction invalidation delivery', () => {
  it('settles every listener delivery of a committed transaction before an after-commit callback runs', async () => {
    await openItems()
    const steps: string[] = []
    onDatabaseDependencyInvalidated(async () => {
      steps.push('delivered')
      await pause(5)
      steps.push('settled')
    })

    await DB.transaction(async (transaction) => {
      await transaction.table('items').where('id', 1).update({ label: 'first' })
      await transaction.table('items').where('id', 2).update({ label: 'second' })
      transaction.afterCommit(() => { steps.push('after commit') })
    })

    expect(steps).toEqual(['delivered', 'delivered', 'settled', 'settled', 'after commit'])
  })

  it('finishes cache evictions in write order before notifying in write order and running user callbacks', async () => {
    await openItems()
    const steps: string[] = []
    let eviction = 0
    configureDatabaseQueryCacheBridge({
      async get() { return null },
      async put() {},
      async flexible(_key, _ttl, callback) { return await callback() },
      async forget() { return false },
      async invalidateDependencies() {
        const current = ++eviction
        steps.push(`evict ${current}`)
        if (current === 1) await pause(20)
        steps.push(`evicted ${current}`)
      },
    })
    onDatabaseDependencyInvalidated((event: DatabaseDependencyInvalidationEvent & { readonly mutations?: readonly DatabaseMutationEvent[] }) => {
      steps.push(`notify ${event.mutations?.[0]?.values?.label}`)
    })

    await DB.transaction(async (transaction) => {
      transaction.afterCommit(() => { steps.push('after commit') })
      await transaction.table('items').where('id', 1).update({ label: 'first' })
      await transaction.transaction(async (nested) => {
        await nested.table('items').where('id', 2).update({ label: 'second' })
      })
    })

    expect(steps).toEqual(['evict 1', 'evicted 1', 'evict 2', 'evicted 2', 'notify first', 'notify second', 'after commit'])
  })

  it('reports a failing listener of a transaction write and still commits and runs after-commit callbacks', async () => {
    await openItems()
    const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const listenerError = new Error('listener failed')
    const steps: string[] = []
    let delivery = 0
    onDatabaseDependencyInvalidated(async () => {
      const current = ++delivery
      await pause(current === 1 ? 0 : 20)
      if (current === 1) throw listenerError
      steps.push('settled')
    })

    await DB.transaction(async (transaction) => {
      await transaction.table('items').where('id', 1).update({ label: 'first' })
      await transaction.table('items').where('id', 2).update({ label: 'second' })
      transaction.afterCommit(() => { steps.push('after commit') })
    })

    expect(reports).toEqual([{ error: listenerError, context: { capability: 'db', operation: 'cache.invalidationListener' } }])
    expect(steps).toEqual(['settled', 'after commit'])
    expect(await DB.table('items').where('id', 1).value('label')).toBe('first')
  })

  it('publishes nothing and runs no after-commit callbacks when the transaction rolls back', async () => {
    await openItems()
    const delivered: string[] = []
    onDatabaseDependencyInvalidated(() => { delivered.push('delivered') })
    const steps: string[] = []

    await expect(DB.transaction(async (transaction) => {
      await transaction.table('items').where('id', 1).update({ label: 'rolled back' })
      transaction.afterCommit(() => { steps.push('after commit') })
      throw new Error('abort')
    })).rejects.toThrow('abort')

    expect(delivered).toEqual([])
    expect(steps).toEqual([])
    expect(await DB.table('items').where('id', 1).value('label')).toBe('one')
  })
})
