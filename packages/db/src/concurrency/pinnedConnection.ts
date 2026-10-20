import { AsyncLocalStorage } from 'node:async_hooks'
import { TransactionError } from '../core/errors'
import type { DriverAdapter } from '../core/types'

export type PinnedConnection = {
  active: boolean
  tail: Promise<void>
}

const pinnedConnections = new AsyncLocalStorage<ReadonlyMap<DriverAdapter, PinnedConnection>>()

export function currentPinnedConnection(adapter: DriverAdapter): PinnedConnection | undefined {
  const pinned = pinnedConnections.getStore()?.get(adapter)
  return pinned?.active ? pinned : undefined
}

export function runPinnedConnection<T>(adapter: DriverAdapter, callback: () => Promise<T>): Promise<T> {
  const pinned: PinnedConnection = { active: true, tail: Promise.resolve() }
  const pinnedMap = new Map(pinnedConnections.getStore())
  pinnedMap.set(adapter, pinned)
  return pinnedConnections.run(pinnedMap, () => callback().finally(() => {
    pinned.active = false
  }))
}

export async function serializeOnPinnedConnection<T>(
  pinned: PinnedConnection,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = pinned.tail
  let release!: () => void
  pinned.tail = new Promise<void>((resolve) => { release = resolve })
  await previous
  try {
    if (!pinned.active) {
      throw new TransactionError('A transaction started inside withoutForeignKeyConstraints() must finish before the callback returns.')
    }
    return await callback()
  } finally {
    release()
  }
}
