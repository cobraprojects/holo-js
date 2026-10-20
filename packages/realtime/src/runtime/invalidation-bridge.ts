import { queryCacheInternals } from '@holo-js/db'
import type { BroadcastDatabaseInvalidationBridge } from '@holo-js/broadcast/contracts'

type RemoteDatabaseDependencyInvalidation = Parameters<typeof queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation>[0]

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isPredicateList(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => {
    const predicate = item as { readonly tableKey?: unknown, readonly columnName?: unknown, readonly encodedValue?: unknown }
    return typeof predicate === 'object'
      && predicate !== null
      && typeof predicate.tableKey === 'string'
      && typeof predicate.columnName === 'string'
      && typeof predicate.encodedValue === 'string'
  })
}

function isRemoteMetadata(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const metadata = value as Record<string, unknown>
  return isStringArray(metadata.directDependencies)
    && isStringArray(metadata.tableDependencies)
    && typeof metadata.hasMutationDependency === 'boolean'
    && isPredicateList(metadata.exactPredicates)
    && isPredicateList(metadata.predicates)
}

function isRemoteDatabaseDependencyInvalidation(value: unknown): value is RemoteDatabaseDependencyInvalidation {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as { readonly connectionName?: unknown, readonly dependencies?: unknown, readonly metadata?: unknown }
  return typeof candidate.connectionName === 'string'
    && isStringArray(candidate.dependencies)
    && (candidate.metadata === undefined || isRemoteMetadata(candidate.metadata))
}

export function createRealtimeDatabaseInvalidationBridge(): BroadcastDatabaseInvalidationBridge {
  return {
    connect(publish) {
      return queryCacheInternals.onDatabaseDependencyInvalidationPublished(async invalidation => { await publish(invalidation) })
    },
    async receive(invalidation) {
      if (!isRemoteDatabaseDependencyInvalidation(invalidation)) {
        throw new Error('[@holo-js/realtime] Remote database invalidation payload is malformed.')
      }

      await queryCacheInternals.receiveRemoteDatabaseDependencyInvalidation(invalidation)
    },
  }
}
