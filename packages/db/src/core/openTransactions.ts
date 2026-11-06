import { AsyncLocalStorage } from 'node:async_hooks'
import { getRootDatabaseContext } from './contextOwnership'
import type { DatabaseContext } from './DatabaseContext'

export type TransactionFrame = {
  open: boolean
  schemaChanged: boolean
}

const openRootTransactions = new AsyncLocalStorage<ReadonlyMap<DatabaseContext, TransactionFrame>>()

export function runInRootTransaction<T>(connection: DatabaseContext, frame: TransactionFrame, callback: () => Promise<T>): Promise<T> {
  const open = new Map(openRootTransactions.getStore())
  open.set(getRootDatabaseContext(connection), frame)
  return openRootTransactions.run(open, callback)
}

export function currentRootTransaction(connection: DatabaseContext): TransactionFrame | undefined {
  const frame = openRootTransactions.getStore()?.get(getRootDatabaseContext(connection))
  return frame?.open ? frame : undefined
}

export function openSchemaChangingTransactions(): TransactionFrame[] {
  return [...openRootTransactions.getStore()?.values() ?? []].filter(frame => frame.open && frame.schemaChanged)
}
