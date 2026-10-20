import type {
  RealtimeExecutionResult,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import {
  handleRealtimeConnectionError,
} from './errors'
import {
  applyWireSnapshotPatch,
  readRealtimeSnapshotPatch,
  isStaleRealtimeSnapshot,
} from './patching'
import type {
  MutableRealtimeQueryStore,
  RealtimeClientTransport,
  SharedRealtimeSnapshot,
} from './types'
import {
  missingTransportMessage,
} from './types'
import {
  createStoreKey,
  stableStringify,
} from './utils'
import {
  warnRealtimeOnce,
} from './errors'

export function createMissingRealtimeTransport(): RealtimeClientTransport {
  return {
    async query<TResult>(): Promise<RealtimeSubscriptionSnapshot<TResult>> {
      warnRealtimeOnce(missingTransportMessage)
      throw new Error(missingTransportMessage)
    },
    async mutate<TResult>(): Promise<RealtimeExecutionResult<TResult>> {
      warnRealtimeOnce(missingTransportMessage)
      throw new Error(missingTransportMessage)
    },
    subscribe<TResult>(
      _name: string,
      _args: Record<string, unknown>,
      _listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      onError: (error: unknown) => void,
    ) {
      warnRealtimeOnce(missingTransportMessage)
      onError(new Error(missingTransportMessage))
      return () => {}
    },
  }
}

export function createRealtimeQueryStore<TResult>(
  name: string,
  args: Record<string, unknown>,
  transport: RealtimeClientTransport,
  onInactive?: () => void,
): MutableRealtimeQueryStore<TResult> {
  const listeners = new Set<() => void>()
  let snapshot: RealtimeSubscriptionSnapshot<TResult> | undefined
  let snapshotDataHash: string | undefined
  let connected = false
  let disposed = false
  let unsubscribe = () => {}
  let startupId = 0
  let pendingLoad: Promise<RealtimeSubscriptionSnapshot<TResult>> | undefined

  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }

  const disconnect = () => {
    unsubscribe()
    connected = false
    startupId += 1
    unsubscribe = () => {}
  }

  const dispose = () => {
    disconnect()
    disposed = true
    listeners.clear()
  }

  const applySnapshot = (nextSnapshot: RealtimeSubscriptionSnapshot<TResult>) => {
    const sharedSnapshot = createSharedRealtimeSnapshot(snapshot, snapshotDataHash, nextSnapshot)
    snapshot = sharedSnapshot.snapshot
    snapshotDataHash = sharedSnapshot.hash
    if (!sharedSnapshot.changed) {
      return
    }

    notify()
  }

  const setSnapshot = (nextSnapshot: RealtimeSubscriptionSnapshot<TResult>) => {
    if (disposed) {
      return
    }

    if (isStaleRealtimeSnapshot(snapshot, nextSnapshot)) {
      return
    }

    applySnapshot(nextSnapshot)
  }

  const load = (): Promise<RealtimeSubscriptionSnapshot<TResult>> => {
    pendingLoad ??= snapshot
      ? Promise.resolve(snapshot)
      : transport.query<TResult>(name, args).then((nextSnapshot) => {
          setSnapshot(nextSnapshot)
          return snapshot ?? nextSnapshot
        })
    return pendingLoad
  }

  return {
    key: createStoreKey(name, args),
    get snapshot() {
      return snapshot
    },
    disconnect,
    dispose,
    load,
    connect() {
      if (disposed) {
        return
      }

      if (connected) {
        return
      }

      const currentStartupId = startupId + 1
      startupId = currentStartupId
      let seenLiveSnapshot = false
      void load().catch((error) => {
        if (startupId !== currentStartupId || seenLiveSnapshot || listeners.size === 0) {
          return
        }

        handleRealtimeConnectionError(error)
      })
      try {
        connected = true
        unsubscribe = transport.subscribe<TResult>(name, args, (nextSnapshot) => {
          if (startupId !== currentStartupId) {
            return
          }

          seenLiveSnapshot = true
          applySnapshot(nextSnapshot)
        }, (error) => {
          if (startupId !== currentStartupId) {
            return
          }

          connected = false
          handleRealtimeConnectionError(error)
        })
      } catch (error) {
        connected = false
        unsubscribe = () => {}
        handleRealtimeConnectionError(error)
      }
    },
    setSnapshot,
    subscribe(listener) {
      if (disposed) {
        return () => {}
      }

      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          disconnect()
          onInactive?.()
        }
      }
    },
  }
}

export function createSharedRealtimeSnapshot<TResult>(
  currentSnapshot: RealtimeSubscriptionSnapshot<TResult> | undefined,
  currentDataHash: string | undefined,
  nextSnapshot: RealtimeSubscriptionSnapshot<TResult>,
): SharedRealtimeSnapshot<TResult> {
  const patch = readRealtimeSnapshotPatch(nextSnapshot)
  if (currentSnapshot && patch) {
    const sharedSnapshot = applyWireSnapshotPatch(currentSnapshot, patch)
    return {
      changed: sharedSnapshot.data !== currentSnapshot.data,
      hash: sharedSnapshot.data === currentSnapshot.data ? currentDataHash : undefined,
      snapshot: sharedSnapshot,
    }
  }

  const nextDataHash = stableStringify(nextSnapshot.data)
  const comparableCurrentDataHash = currentSnapshot && typeof currentDataHash === 'undefined'
    ? stableStringify(currentSnapshot.data)
    : currentDataHash
  if (!currentSnapshot || nextDataHash !== comparableCurrentDataHash) {
    return {
      changed: true,
      hash: nextDataHash,
      snapshot: nextSnapshot,
    }
  }

  return {
    changed: false,
    hash: nextDataHash,
    snapshot: {
      ...nextSnapshot,
      data: currentSnapshot.data,
    },
  }
}
