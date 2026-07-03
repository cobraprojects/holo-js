import type {
  RealtimeArgsFor,
  RealtimeMutationDefinition,
  RealtimeQueryDefinition,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from '../contracts'
import {
  handleRealtimeError,
} from './errors'
import {
  getRealtimeClientState,
} from './state'
import {
  createMissingRealtimeTransport,
  createRealtimeQueryStore,
} from './store'
import type {
  MutableRealtimeQueryStore,
  RealtimeClientTransport,
  RealtimeFrameworkRuntime,
  RealtimeQueryStore,
} from './types'
import {
  normalizeArgs,
  createStoreKey,
} from './utils'

export function configureRealtimeClientRuntime(runtime?: RealtimeFrameworkRuntime): void {
  getRealtimeClientState().framework = runtime
}

export function configureRealtimeClientTransport(transport?: RealtimeClientTransport): void {
  getRealtimeClientState().transport = transport
}

export function hasConfiguredRealtimeClientTransport(): boolean {
  return !!getRealtimeClientState().transport
}

export function hasConfiguredRealtimeClientRuntime(): boolean {
  return !!getRealtimeClientState().framework
}

export function resetRealtimeClientRuntime(): void {
  const state = getRealtimeClientState()
  for (const store of state.stores.values()) {
    store.dispose()
  }
  state.framework = undefined
  state.transport = undefined
  state.warnedMessages.clear()
  state.stores.clear()
}

export function getRealtimeQueryStore<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
): RealtimeQueryStore<RealtimeResultFor<TDefinition>> {
  const args = normalizeArgs(input)
  const key = createStoreKey(definition.name, args)
  const state = getRealtimeClientState()
  const existing = state.stores.get(key) as MutableRealtimeQueryStore<RealtimeResultFor<TDefinition>> | undefined
  if (existing) {
    return existing
  }

  const transport = state.transport ?? createMissingRealtimeTransport()
  const store = createRealtimeQueryStore<RealtimeResultFor<TDefinition>>(definition.name, args, transport, () => {
    if (state.stores.get(key) === store) {
      state.stores.delete(key)
    }
  })
  state.stores.set(key, store as MutableRealtimeQueryStore<unknown>)
  return store
}

export function hydrateRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
  snapshot: RealtimeSubscriptionSnapshot<RealtimeResultFor<TDefinition>>,
): void {
  const store = getRealtimeQueryStore(definition, input) as MutableRealtimeQueryStore<RealtimeResultFor<TDefinition>>
  store.setSnapshot(snapshot)
}

export function useRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> | undefined {
  const framework = getRealtimeClientState().framework
  if (!framework?.useQuery) {
    return getRealtimeQueryStore(definition, args).snapshot?.data
  }

  return framework.useQuery(definition, args)
}

export function useRealtimeMutation<TDefinition extends RealtimeMutationDefinition>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeResultFor<TDefinition>> {
  const args = normalizeArgs(input)
  const transport = getRealtimeClientState().transport ?? createMissingRealtimeTransport()
  const promise = transport
    .mutate<RealtimeResultFor<TDefinition>>(definition.name, args)
    .then(result => result.data)

  promise.catch((error) => {
    handleRealtimeError(error)
  })

  return promise
}
