import type { DatabaseContext } from './DatabaseContext'

type TransactionScopeEntry = <T>(context: DatabaseContext, callback: () => Promise<T>) => Promise<T>

let transactionScopeEntry: TransactionScopeEntry

export function registerTransactionScopeEntry(entry: TransactionScopeEntry): void {
  transactionScopeEntry = entry
}

export function runInTransactionScope<T>(context: DatabaseContext, callback: () => Promise<T>): Promise<T> {
  return transactionScopeEntry(context, callback)
}
