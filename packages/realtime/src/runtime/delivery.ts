import type {
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import { updateQueryEntryObservedQueries } from './query-patching'
import { createResultHash } from './result-hash'
import {
  areDependencySetsEqual,
  ensureRefreshDeliveryPredicateDependencies,
  ensureRefreshDeliveryTableDependencies,
  updateQueryEntryDependencies,
} from './subscription-index'
import type {
  ActiveSubscription,
  ActiveQueryEntry,
  InternalRealtimeExecutionResult,
  RealtimeSubscriptionPatch,
  RefreshDelivery,
} from './state'

export async function deliverRefreshData<TDefinition extends RealtimeQueryDefinitionMetadata>(
  entry: ActiveQueryEntry<TDefinition>,
  delivery: RefreshDelivery<TDefinition>,
): Promise<void> {
  const dependenciesChanged = !areDependencySetsEqual(entry.dependencies, delivery.result.dependencies)
  if (dependenciesChanged) {
    updateQueryEntryDependencies(
      entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
      delivery.result.dependencies,
      ensureRefreshDeliveryPredicateDependencies(delivery),
      ensureRefreshDeliveryTableDependencies(delivery),
    )
  }
  if (delivery.observedQueriesChanged !== false) {
    updateQueryEntryObservedQueries(
      entry as ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
      delivery.result.queries,
      delivery.result.data,
    )
  }

  if (
    delivery.patchOperations?.length === 0
    && !dependenciesChanged
    && entry.current
  ) {
    const currentHash = createResultHash(entry.current.data)
    if (currentHash === createResultHash(delivery.result.data)) {
      entry.resultHash = currentHash
      entry.resultHashDirty = false
      return
    }
  }

  if (delivery.resultHashDirty === true) {
    entry.resultHashDirty = true
  } else if (delivery.resultHash) {
    const currentHash = entry.resultHashDirty && entry.current
      ? createResultHash(entry.current.data)
      : entry.resultHash
    if (currentHash === delivery.resultHash && !dependenciesChanged) {
      entry.resultHash = delivery.resultHash
      entry.resultHashDirty = false
      return
    }

    entry.resultHash = delivery.resultHash
    entry.resultHashDirty = false
  }

  entry.version += 1
  entry.current = Object.freeze({
    name: delivery.result.name,
    data: delivery.result.data,
    dependencies: delivery.result.dependencies,
    version: entry.version,
  })

  const patch = delivery.patchOperations && (delivery.patchOperations.length > 0 || dependenciesChanged)
    && entry.patchSubscriberRefs.size > 0
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
  let firstDelivery: Promise<void> | undefined
  let deliveries: Promise<void>[] | undefined
  const reportError = (handlerError: unknown): void => {
    console.error('[@holo-js/realtime] Realtime subscription onError callback failed.', handlerError)
  }
  for (const subscription of entry.subscriberRefs) {
    const onError = subscription.options.onError
    if (!onError) {
      continue
    }

    try {
      const result = onError(error)
      if (!isPromiseLike(result)) {
        continue
      }

      const delivery = Promise.resolve(result).catch(reportError)
      if (!firstDelivery) {
        firstDelivery = delivery
        continue
      }

      deliveries ??= [firstDelivery]
      deliveries.push(delivery)
    } catch (handlerError) {
      reportError(handlerError)
    }
  }

  if (deliveries) {
    await Promise.all(deliveries)
    return
  }

  if (firstDelivery) {
    await firstDelivery
  }
}

export async function deliverPatchedQueryData(
  entry: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>,
  data: unknown,
  queries: InternalRealtimeExecutionResult<RealtimeResultFor<typeof entry.definition>>['queries'],
  patchOperations: NonNullable<RefreshDelivery<typeof entry.definition>['patchOperations']>,
): Promise<void> {
  const result = Object.freeze({
    name: entry.definition.name,
    data: data as RealtimeResultFor<typeof entry.definition>,
    dependencies: entry.dependencies,
    queries,
  }) satisfies InternalRealtimeExecutionResult<RealtimeResultFor<typeof entry.definition>>
  await deliverRefreshData(entry, {
    observedQueriesChanged: false,
    patchOperations,
    result,
    resultHashDirty: true,
  })
}

async function deliverQueryEntryData<TDefinition extends RealtimeQueryDefinitionMetadata>(
  entry: ActiveQueryEntry<TDefinition>,
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>,
  patch?: RealtimeSubscriptionPatch,
): Promise<void> {
  const reportError = (callbackName: 'onData' | 'onPatch', error: unknown): void => {
    console.error(`[@holo-js/realtime] Realtime subscription ${callbackName} callback failed.`, error)
  }

  if (patch) {
    const patchDelivery = deliverToSubscribers(
      entry.patchSubscriberRefs,
      subscription => subscription.options.onPatch?.(patch),
      error => reportError('onPatch', error),
    )
    const fallbackDelivery = deliverToSubscribers(
      entry.patchFallbackSubscriberRefs,
      subscription => subscription.options.onData?.(current),
      error => reportError('onData', error),
    )
    await awaitDeliveries(patchDelivery, fallbackDelivery)
    return
  }

  await deliverToSubscribers(
    entry.snapshotSubscriberRefs,
    subscription => subscription.options.onData?.(current),
    error => reportError('onData', error),
  )
}

function deliverToSubscribers<TDefinition extends RealtimeQueryDefinitionMetadata>(
  subscriptions: ReadonlySet<ActiveSubscription<TDefinition>>,
  deliver: (subscription: ActiveSubscription<TDefinition>) => void | Promise<void> | undefined,
  reportError: (error: unknown) => void,
): Promise<void> | undefined {
  let firstDelivery: Promise<void> | undefined
  let deliveries: Promise<void>[] | undefined
  for (const subscription of subscriptions) {
    try {
      const result = deliver(subscription)
      if (!isPromiseLike(result)) {
        continue
      }

      const delivery = Promise.resolve(result).catch(reportError)
      if (!firstDelivery) {
        firstDelivery = delivery
        continue
      }

      deliveries ??= [firstDelivery]
      deliveries.push(delivery)
    } catch (error) {
      reportError(error)
    }
  }

  return deliveries
    ? Promise.all(deliveries).then(() => undefined)
    : firstDelivery
}

async function awaitDeliveries(
  firstDelivery: Promise<void> | undefined,
  secondDelivery: Promise<void> | undefined,
): Promise<void> {
  if (firstDelivery && secondDelivery) {
    await Promise.all([firstDelivery, secondDelivery])
    return
  }

  await firstDelivery
  await secondDelivery
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return false
  }

  return typeof (value as { readonly then?: unknown }).then === 'function'
}
