import type {
  RealtimeArgsFor,
  RealtimeExecutionResult,
  RealtimeMutationDefinition,
  RealtimeQueryDefinition,
  RealtimeResultFor,
  RealtimeSubscriptionSnapshot,
} from './contracts'

export type RealtimeQueryStore<TResult> = {
  readonly key: string
  readonly snapshot: RealtimeSubscriptionSnapshot<TResult> | undefined
  connect(): void
  subscribe(listener: () => void): () => void
}

export type RealtimeClientTransport = {
  query<TResult>(name: string, args: Record<string, unknown>): Promise<RealtimeSubscriptionSnapshot<TResult>>
  mutate<TResult>(name: string, args: Record<string, unknown>): Promise<RealtimeExecutionResult<TResult>>
  subscribe<TResult>(
    name: string,
    args: Record<string, unknown>,
    listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
    onError: (error: unknown) => void,
  ): () => void
}

export type RealtimeFrameworkRuntime = {
  useQuery<TDefinition extends RealtimeQueryDefinition>(
    definition: TDefinition,
    args: RealtimeArgsFor<TDefinition>,
  ): RealtimeResultFor<TDefinition>
}

type RealtimeClientState = {
  framework?: RealtimeFrameworkRuntime
  transport?: RealtimeClientTransport
  stores: Map<string, MutableRealtimeQueryStore<unknown>>
}

type MutableRealtimeQueryStore<TResult> = RealtimeQueryStore<TResult> & {
  setSnapshot(snapshot: RealtimeSubscriptionSnapshot<TResult>): void
}

type BrowserEventSource = {
  onmessage: ((event: { readonly data: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  close(): void
}

type BrowserEventSourceConstructor = new (url: string) => BrowserEventSource

type BrowserGlobals = typeof globalThis & {
  EventSource?: BrowserEventSourceConstructor
}

const MAX_REALTIME_STREAM_URL_LENGTH = 8000

function getRealtimeClientState(): RealtimeClientState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeClient__?: RealtimeClientState
  }

  runtime.__holoRealtimeClient__ ??= {
    stores: new Map<string, MutableRealtimeQueryStore<unknown>>(),
  }
  return runtime.__holoRealtimeClient__
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(',')}}`
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return {}
  }

  return args as Record<string, unknown>
}

function createStoreKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${stableStringify(args)}`
}

function createFetchRealtimeTransport(): RealtimeClientTransport {
  return {
    async query<TResult>(name: string, args: Record<string, unknown>) {
      const response = await fetch('/holo/realtime/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, args }),
      })
      if (!response.ok) {
        throw new Error(`Realtime query failed with status ${response.status}.`)
      }

      return await response.json() as RealtimeSubscriptionSnapshot<TResult>
    },
    async mutate<TResult>(name: string, args: Record<string, unknown>) {
      const response = await fetch('/holo/realtime/mutation', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ name, args }),
      })
      if (!response.ok) {
        throw new Error(`Realtime mutation failed with status ${response.status}.`)
      }

      return await response.json() as RealtimeExecutionResult<TResult>
    },
    subscribe<TResult>(
      name: string,
      args: Record<string, unknown>,
      listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      onError: (error: unknown) => void,
    ) {
      const EventSourceConstructor = (globalThis as BrowserGlobals).EventSource
      if (!EventSourceConstructor) {
        return () => {}
      }

      const url = `/holo/realtime/stream?name=${encodeURIComponent(name)}&args=${encodeURIComponent(JSON.stringify(args))}`
      if (url.length > MAX_REALTIME_STREAM_URL_LENGTH) {
        onError(new Error('Realtime stream arguments are too large for EventSource transport.'))
        return () => {}
      }

      const source = new EventSourceConstructor(url)
      source.onmessage = (event) => {
        listener(JSON.parse(event.data) as RealtimeSubscriptionSnapshot<TResult>)
      }
      source.onerror = onError

      return () => {
        source.close()
      }
    },
  }
}

function createRealtimeQueryStore<TResult>(
  name: string,
  args: Record<string, unknown>,
  transport: RealtimeClientTransport,
): MutableRealtimeQueryStore<TResult> {
  const listeners = new Set<() => void>()
  let snapshot: RealtimeSubscriptionSnapshot<TResult> | undefined
  let connected = false
  let unsubscribe = () => {}

  const notify = () => {
    for (const listener of listeners) {
      listener()
    }
  }

  const setSnapshot = (nextSnapshot: RealtimeSubscriptionSnapshot<TResult>) => {
    snapshot = nextSnapshot
    notify()
  }

  return {
    key: createStoreKey(name, args),
    get snapshot() {
      return snapshot
    },
    connect() {
      if (connected) {
        return
      }

      connected = true
      void transport.query<TResult>(name, args).then(setSnapshot, () => {})
      unsubscribe = transport.subscribe<TResult>(name, args, setSnapshot, () => {})
    },
    setSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribe()
          connected = false
          unsubscribe = () => {}
        }
      }
    },
  }
}

export function configureRealtimeClientRuntime(runtime?: RealtimeFrameworkRuntime): void {
  getRealtimeClientState().framework = runtime
}

export function configureRealtimeClientTransport(transport?: RealtimeClientTransport): void {
  getRealtimeClientState().transport = transport
}

export function resetRealtimeClientRuntime(): void {
  const state = getRealtimeClientState()
  state.framework = undefined
  state.transport = undefined
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

  const transport = state.transport ?? createFetchRealtimeTransport()
  const store = createRealtimeQueryStore<RealtimeResultFor<TDefinition>>(definition.name, args, transport)
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
): RealtimeResultFor<TDefinition> {
  const framework = getRealtimeClientState().framework
  if (!framework) {
    throw new Error('Realtime queries require a Holo framework client runtime.')
  }

  return framework.useQuery(definition, args)
}

export async function useRealtimeMutation<TDefinition extends RealtimeMutationDefinition>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeResultFor<TDefinition>> {
  const args = normalizeArgs(input)
  const transport = getRealtimeClientState().transport ?? createFetchRealtimeTransport()
  const result = await transport.mutate<RealtimeResultFor<TDefinition>>(definition.name, args)

  return result.data
}

export const realtimeClientInternals = {
  createFetchRealtimeTransport,
  createRealtimeQueryStore,
  getRealtimeClientState,
  stableStringify,
}
