import type {
  RealtimeExecutionResult,
  RealtimeExecutionOptions,
  RealtimeArgsFor,
  RealtimeQueryDefinitionMetadata,
  RealtimeResultFor,
  RealtimeRuntimeBindings,
  RealtimeSubscribeOptions,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import type { PredicateDependencyIndex } from './dependencies'
import type {
  DatabaseDependencyInvalidationEventWithMutations,
  ParsedInvalidationEvent,
} from './dependencies'
import type {
  BackfillCache as QueryBackfillCache,
  DatabaseQueryObservation,
  QueryPatchTarget,
} from './query-state'
import type { RealtimePatchPathSegment } from './result-patching'

export type RuntimeState = {
  bindings?: RealtimeRuntimeBindings
  dependencySubscribers: Map<string, Set<string>>
  invalidationBatch?: PendingInvalidationBatch
  nextSubscriptionId: number
  queryEntries: Map<string, ActiveQueryEntry<RealtimeQueryDefinitionMetadata>>
  refreshes: Map<string, ActiveRefresh>
  tableBroadSubscribers: Map<string, Set<string>>
  tablePredicateColumnSubscribers: Map<string, Map<string, Set<string>>>
  tablePredicateValueSubscribers: Map<string, Map<string, Map<string, Set<string>>>>
  unsubscribeFromDatabase?: () => void
  subscriptions: Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>
}

export type PendingInvalidationBatch = {
  readonly deferred: Deferred<void>
  readonly events: DatabaseDependencyInvalidationEventWithMutations[]
  timer: ReturnType<typeof setTimeout>
}

export type Deferred<TValue> = {
  readonly promise: Promise<TValue>
  resolve(value: TValue): void
  reject(error: unknown): void
}

export type ActiveRefresh = {
  pending: boolean
  running?: Promise<void>
}

export type ActiveSubscription<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly id: string
  readonly refreshKey: string
  readonly options: InternalRealtimeSubscribeOptions<RealtimeResultFor<TDefinition>>
  current: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
}

export type RealtimeSubscriptionReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly value: unknown
}

export type RealtimeSubscriptionUndefinedReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly valueKind: 'undefined'
}

export type RealtimeSubscriptionMergePatchOperation = {
  readonly op: 'merge'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly fields: Readonly<Record<string, unknown>>
}

export type RealtimeSubscriptionSplicePatchOperation = {
  readonly op: 'splice'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
}

export type RealtimeSubscriptionMovePatchOperation = {
  readonly op: 'move'
  readonly path: readonly RealtimePatchPathSegment[]
  readonly from: number
  readonly to: number
}

export type RealtimeSubscriptionPatchOperation =
  | RealtimeSubscriptionReplacePatchOperation
  | RealtimeSubscriptionUndefinedReplacePatchOperation
  | RealtimeSubscriptionMergePatchOperation
  | RealtimeSubscriptionSplicePatchOperation
  | RealtimeSubscriptionMovePatchOperation

export type RealtimeSubscriptionPatch = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly RealtimeSubscriptionPatchOperation[]
  readonly version: number
}

export type InternalRealtimeSubscribeOptions<TResult> = RealtimeSubscribeOptions<TResult> & {
  readonly onPatch?: (patch: RealtimeSubscriptionPatch) => void | Promise<void>
}

export type ActiveQueryEntry<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly args: RealtimeArgsFor<TDefinition>
  readonly definition: TDefinition
  readonly executionOptions?: RealtimeExecutionOptions
  readonly patchFallbackSubscriberRefs: Set<ActiveSubscription<TDefinition>>
  readonly patchSubscriberRefs: Set<ActiveSubscription<TDefinition>>
  readonly refreshKey: string
  readonly snapshotSubscriberRefs: Set<ActiveSubscription<TDefinition>>
  readonly subscriberRefs: Set<ActiveSubscription<TDefinition>>
  readonly subscribers: Set<string>
  dependencies: readonly string[]
  initialQuery?: Promise<InitialQueryResult<TDefinition>>
  patchTargets: QueryPatchTarget[]
  predicateDependencies: PredicateDependencyIndex
  queries: DatabaseQueryObservation[]
  resultHash: string
  resultHashDirty: boolean
  tableDependencies: readonly string[]
  version: number
  current?: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
}

export type BackfillCache = QueryBackfillCache<ActiveQueryEntry<RealtimeQueryDefinitionMetadata>>

export type DatabaseDependencyCollectionWithQueries<TValue> = {
  readonly dependencies: readonly string[]
  readonly queries: readonly DatabaseQueryObservation[]
  readonly value: TValue
}

export type InternalRealtimeExecutionResult<TResult> = RealtimeExecutionResult<TResult> & {
  readonly queries: readonly DatabaseQueryObservation[]
}

export type InitialQueryResult<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly predicateDependencies: PredicateDependencyIndex
  readonly result: InternalRealtimeExecutionResult<RealtimeResultFor<TDefinition>>
  readonly resultHash: string
  readonly snapshot: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>
  readonly tableDependencies: readonly string[]
}

export type RefreshDelivery<TDefinition extends RealtimeQueryDefinitionMetadata> = {
  readonly observedQueriesChanged?: boolean
  readonly patchOperations?: readonly RealtimeSubscriptionPatchOperation[]
  readonly result: InternalRealtimeExecutionResult<RealtimeResultFor<TDefinition>>
  readonly resultHash?: string
  readonly resultHashDirty?: boolean
  predicateDependencies?: PredicateDependencyIndex
  tableDependencies?: readonly string[]
}

export type QueryEntryCollector = {
  readonly entries: ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[]
  entryKeys?: Set<string>
  event: ParsedInvalidationEvent
  firstEntryKey?: string
  readonly state: RuntimeState
}

export const EMPTY_QUERY_ENTRIES: readonly ActiveQueryEntry<RealtimeQueryDefinitionMetadata>[] = Object.freeze([])

export function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeRuntime__?: RuntimeState
  }

  const state = runtime.__holoRealtimeRuntime__ ??= {
    dependencySubscribers: new Map<string, Set<string>>(),
    nextSubscriptionId: 0,
    queryEntries: new Map<string, ActiveQueryEntry<RealtimeQueryDefinitionMetadata>>(),
    refreshes: new Map<string, ActiveRefresh>(),
    tableBroadSubscribers: new Map<string, Set<string>>(),
    tablePredicateColumnSubscribers: new Map<string, Map<string, Set<string>>>(),
    tablePredicateValueSubscribers: new Map<string, Map<string, Map<string, Set<string>>>>(),
    subscriptions: new Map<string, ActiveSubscription<RealtimeQueryDefinitionMetadata>>(),
  }
  state.dependencySubscribers ??= new Map<string, Set<string>>()
  state.queryEntries ??= new Map<string, ActiveQueryEntry<RealtimeQueryDefinitionMetadata>>()
  state.tableBroadSubscribers ??= new Map<string, Set<string>>()
  state.tablePredicateColumnSubscribers ??= new Map<string, Map<string, Set<string>>>()
  state.tablePredicateValueSubscribers ??= new Map<string, Map<string, Map<string, Set<string>>>>()
  return state
}

export function createDeferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<TValue>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return {
    promise,
    resolve,
    reject,
  }
}
