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

export const driverConnectionKey: unique symbol = Symbol('driverConnectionKey')

export type TransactionScopeIdentity = string | object

type ConnectionKeyed = DriverAdapter & {
  readonly [transactionScopeKey]?: TransactionScopeIdentity
  readonly [driverConnectionKey]?: DriverAdapter
}

export function driverConnection(adapter: DriverAdapter): DriverAdapter {
  return (adapter as ConnectionKeyed)[driverConnectionKey] ?? adapter
}

export function transactionScopeIdentity(adapter: DriverAdapter): TransactionScopeIdentity {
  const connection = driverConnection(adapter)
  return (connection as ConnectionKeyed)[transactionScopeKey] ?? connection
}
