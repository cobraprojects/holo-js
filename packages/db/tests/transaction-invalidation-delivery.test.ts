import { describe, expect, it, onTestFinished } from 'vitest'
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
  it('hands every write of a committed transaction to listeners before after-commit callbacks, and waits for their delivery', async () => {
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

    expect(steps).toEqual(['delivered', 'delivered', 'after commit', 'settled', 'settled'])
  })
})
