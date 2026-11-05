import type { DatabaseContext } from './DatabaseContext'
import type { DriverAdapter } from './types'

type TransactionScopeEntry = <T>(context: DatabaseContext, callback: () => Promise<T>) => Promise<T>

let transactionScopeEntry: TransactionScopeEntry

export function registerTransactionScopeEntry(entry: TransactionScopeEntry): void {
  transactionScopeEntry = entry
}

export function runInTransactionScope<T>(context: DatabaseContext, callback: () => Promise<T>): Promise<T> {
  return transactionScopeEntry(context, callback)
}

export const transactionScopeKey: unique symbol = Symbol('transactionScopeKey')

export type TransactionScopeIdentity = string | object

export type TransactionScopeKeyed = { readonly [transactionScopeKey]?: TransactionScopeIdentity }

export function transactionScopeIdentity(adapter: DriverAdapter): TransactionScopeIdentity {
  return (adapter as DriverAdapter & TransactionScopeKeyed)[transactionScopeKey] ?? adapter
}
