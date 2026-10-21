import { AsyncLocalStorage } from 'node:async_hooks'
import { TransactionError } from '../core/errors'
import type { DriverAdapter } from '../core/types'

export type PinnedConnection = {
  active: boolean
  closed: boolean
  tail: Promise<void>
  inFlight: number
  transaction?: PinnedTransactionScope
  drained?: () => void
}

type PinnedTransactionScope = {
  readonly pinned: PinnedConnection
  stuck: boolean
}

const pinnedConnections = new AsyncLocalStorage<ReadonlyMap<DriverAdapter, PinnedConnection>>()
const pinnedTransactionScopes = new AsyncLocalStorage<ReadonlySet<PinnedTransactionScope>>()

export function currentPinnedConnection(adapter: DriverAdapter): PinnedConnection | undefined {
  const pinned = pinnedConnections.getStore()?.get(adapter)
  return pinned?.active ? pinned : undefined
}

export function runPinnedConnection<T>(adapter: DriverAdapter, callback: () => Promise<T>): Promise<T> {
  const pinned: PinnedConnection = { active: true, closed: false, tail: Promise.resolve(), inFlight: 0 }
  const pinnedMap = new Map(pinnedConnections.getStore())
  pinnedMap.set(adapter, pinned)
  return pinnedConnections.run(pinnedMap, () => callback().finally(() => {
    pinned.active = false
  }))
}

export function assertPinnedStatementAllowed(pinned: PinnedConnection): void {
  if (pinned.transaction && !pinnedTransactionScopes.getStore()?.has(pinned.transaction)) {
    throw new TransactionError(
      'A query on the connection held by withoutForeignKeyConstraints() ran while a transaction on that connection was still open, so it would have joined that transaction. Await the transaction before running other queries, or run the query inside the transaction.',
    )
  }
}

export function enterPinnedStatement(pinned: PinnedConnection): () => void {
  assertPinnedStatementAllowed(pinned)
  pinned.inFlight += 1
  return () => {
    pinned.inFlight -= 1
    if (pinned.inFlight > 0) return
    const drained = pinned.drained
    pinned.drained = undefined
    drained?.()
  }
}

function transactionAfterCallbackError(): TransactionError {
  return new TransactionError('A transaction started inside withoutForeignKeyConstraints() must finish before the callback returns.')
}

function transactionStuckError(): TransactionError {
  return new TransactionError('A transaction on the connection held by withoutForeignKeyConstraints() could not be rolled back, so no further transactions run on that connection.')
}

async function serializeOnPinnedConnection<T>(
  pinned: PinnedConnection,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = pinned.tail
  let release!: () => void
  pinned.tail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    if (!pinned.active) {
      throw transactionAfterCallbackError()
    }
    return await callback()
  } finally {
    release()
  }
}

export function markPinnedTransactionStuck(adapter: DriverAdapter): void {
  const scope = pinnedConnections.getStore()?.get(adapter)?.transaction
  if (scope) scope.stuck = true
}

export function closePinnedConnection(pinned: PinnedConnection): Promise<void> {
  return serializeOnPinnedConnection(pinned, async () => {
    pinned.closed = true
    await waitForInFlightStatements(pinned)
  })
}

export function runPinnedTransaction<T>(pinned: PinnedConnection, attempt: () => Promise<T>): Promise<T> {
  return serializeOnPinnedConnection(pinned, async () => {
    if (pinned.closed) throw transactionAfterCallbackError()
    if (pinned.transaction?.stuck) throw transactionStuckError()
    const scope: PinnedTransactionScope = { pinned, stuck: false }
    pinned.transaction = scope
    try {
      await waitForInFlightStatements(pinned)
      const scopes = new Set<PinnedTransactionScope>(pinnedTransactionScopes.getStore())
      scopes.add(scope)
      return await pinnedTransactionScopes.run(scopes, attempt)
    } finally {
      if (!scope.stuck) pinned.transaction = undefined
    }
  })
}

function waitForInFlightStatements(pinned: PinnedConnection): Promise<void> {
  if (pinned.inFlight === 0) return Promise.resolve()
  return new Promise((resolve) => { pinned.drained = resolve })
}
