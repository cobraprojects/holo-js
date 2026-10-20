import { queryCacheInternals } from '@holo-js/db'
import type { BroadcastDatabaseInvalidationBridge } from '@holo-js/broadcast/contracts'
import { refreshSubscriptionsForRemoteTables } from './invalidation'

type RemoteDatabaseDependencyInvalidation = Parameters<typeof queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation>[0]

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isRemoteDatabaseDependencyInvalidation(value: unknown): value is RemoteDatabaseDependencyInvalidation {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as { readonly connectionName?: unknown, readonly dependencies?: unknown }
  return typeof candidate.connectionName === 'string'
    && isStringArray(candidate.dependencies)
}

export function createRealtimeDatabaseInvalidationBridge(): BroadcastDatabaseInvalidationBridge {
  return {
    connect(publish) {
      if (queryCacheInternals.hasDatabaseDependencyInvalidationPublisher()) {
        return () => undefined
      }

      return queryCacheInternals.onDatabaseDependencyInvalidationPublished(async invalidation => { await publish(invalidation) })
    },
    async receive(invalidation) {
      if (!isRemoteDatabaseDependencyInvalidation(invalidation)) {
        throw new Error('[@holo-js/realtime] Remote database invalidation payload is malformed.')
      }

      await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation(invalidation)
      await refreshSubscriptionsForRemoteTables(invalidation.dependencies)
    },
  }
}
