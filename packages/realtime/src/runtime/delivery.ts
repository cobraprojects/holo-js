import { reportError } from '@holo-js/kernel/error-reporting'
import type {
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import { createResultHash } from './result-hash'
import {
  areDependencySetsEqual,
  arePredicateDependenciesEqual,
  ensureRefreshDeliveryPredicateDependencies,
  ensureRefreshDeliveryTableDependencies,
  updateQueryEntryDependencies,
} from './subscription-index'
import { getRuntimeState } from './state'
import type {
  ActiveQueryEntry,
  RealtimeSubscriptionPatch,
  RefreshDelivery,
} from './state'

function isRegisteredQueryEntry(entry: { readonly refreshKey: string }): boolean {
  return getRuntimeState().queryEntries.get(entry.refreshKey) === entry
}

export async function deliverRefreshData<TDefinition extends RealtimeQueryDefinitionMetadata>(
  entry: ActiveQueryEntry<TDefinition>,
  delivery: RefreshDelivery<TDefinition>,
): Promise<void> {
  if (!isRegisteredQueryEntry(entry)) {
    return
  }

  const dependenciesChanged = !areDependencySetsEqual(entry.dependencies, delivery.result.dependencies)
  if (
    dependenciesChanged
    || !arePredicateDependenciesEqual(entry.predicateDependencies, ensureRefreshDeliveryPredicateDependencies(delivery))
  ) {
    updateQueryEntryDependencies(
      entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
      delivery.result.dependencies,
      ensureRefreshDeliveryPredicateDependencies(delivery),
      ensureRefreshDeliveryTableDependencies(delivery),
    )
  }
  entry.queries = [...delivery.result.queries]

  if (
    delivery.patchOperations?.length === 0
    && !dependenciesChanged
    && entry.current
  ) {
    const currentHash = createResultHash(entry.current.data)
    if (currentHash === createResultHash(delivery.result.data)) {
      entry.resultHash = currentHash
      return
    }
  }

  if (delivery.resultHash === entry.resultHash && !dependenciesChanged) {
    return
  }
  entry.resultHash = delivery.resultHash

  entry.version += 1
  entry.current = Object.freeze({
    name: delivery.result.name,
    data: delivery.result.data,
    dependencies: delivery.result.dependencies,
    version: entry.version,
  })

  const patch = delivery.patchOperations && (delivery.patchOperations.length > 0 || dependenciesChanged)
    && entry.options.onPatch
    ? Object.freeze({
        ...(dependenciesChanged ? { dependencies: delivery.result.dependencies } : {}),
        operations: delivery.patchOperations,
        version: entry.version,
      }) satisfies RealtimeSubscriptionPatch
    : undefined

  await deliverQueryEntryData(entry, entry.current, patch)
}

export async function deliverRefreshError(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  error: unknown,
): Promise<void> {
  if (!isRegisteredQueryEntry(entry)) {
    return
  }

  if (!getRuntimeState().subscriptions.has(entry.refreshKey)) return
  try {
    await entry.options.onError?.(error)
  } catch (handlerError) {
    reportError(handlerError, { capability: 'realtime', operation: 'subscription.onError' })
  }
}

async function deliverQueryEntryData<TDefinition extends RealtimeQueryDefinitionMetadata>(
  entry: ActiveQueryEntry<TDefinition>,
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>,
  patch?: RealtimeSubscriptionPatch,
): Promise<void> {
  if (!getRuntimeState().subscriptions.has(entry.refreshKey)) return
  const callbackName = patch && entry.options.onPatch ? 'onPatch' : 'onData'
  try {
    if (patch && entry.options.onPatch) {
      await entry.options.onPatch(patch)
    } else {
      await entry.options.onData?.(current)
    }
  } catch (error) {
    reportError(error, { capability: 'realtime', operation: `subscription.${callbackName}` })
  }
}
