import { describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { DB, clearGeneratedTables, column, queryCacheInternals, registerGeneratedTables } from '../src'
import { defineTable } from './support/internal'
import { openDatabase } from './support/database'

async function openItems() {
  const { adapter } = await openDatabase('sqlite')
  registerGeneratedTables({
    items: defineTable('items', { id: column.integer().primaryKey(), label: column.string() }),
  })
  onTestFinished(() => {
    queryCacheInternals.resetDatabaseDependencyInvalidationListeners()
    clearGeneratedTables()
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
    queryCacheInternals.onDatabaseDependencyInvalidated(async () => {
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

  it('reports a failing listener of a transaction write and still commits and runs after-commit callbacks', async () => {
    await openItems()
    const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
    errorReportingInternals.configure({ report: (error, context) => { reports.push({ error, context }) } })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const listenerError = new Error('listener failed')
    queryCacheInternals.onDatabaseDependencyInvalidated(() => { throw listenerError })
    const steps: string[] = []

    await DB.transaction(async (transaction) => {
      await transaction.table('items').where('id', 1).update({ label: 'first' })
      transaction.afterCommit(() => { steps.push('after commit') })
    })

    expect(reports).toEqual([{ error: listenerError, context: { capability: 'db', operation: 'cache.invalidationListener' } }])
    expect(steps).toEqual(['after commit'])
    expect(await DB.table('items').where('id', 1).value('label')).toBe('first')
  })

  it('publishes nothing and runs no after-commit callbacks when the transaction rolls back', async () => {
    await openItems()
    const delivered: string[] = []
    queryCacheInternals.onDatabaseDependencyInvalidated(() => { delivered.push('delivered') })
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
