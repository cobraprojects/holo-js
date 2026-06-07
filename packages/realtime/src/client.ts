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
  ): RealtimeResultFor<TDefinition> | undefined
}

type RealtimeClientState = {
  framework?: RealtimeFrameworkRuntime
  transport?: RealtimeClientTransport
  stores: Map<string, MutableRealtimeQueryStore<unknown>>
  warnedMessages: Set<string>
}

type RealtimeClientErrorKind = 'authorization' | 'transport' | 'runtime'

type RealtimeClientErrorOptions = {
  readonly name?: string
  readonly status?: number
  readonly code?: string
  readonly kind?: RealtimeClientErrorKind
}

type MutableRealtimeQueryStore<TResult> = RealtimeQueryStore<TResult> & {
  setSnapshot(snapshot: RealtimeSubscriptionSnapshot<TResult>): void
}

const missingTransportMessage = 'Realtime is not connected because broadcast support is not configured. Run "holo install broadcast" and start the broadcast worker with "holo broadcast:work" to enable live updates.'
const unavailableTransportMessage = 'Realtime live updates are unavailable because the broadcast worker is not reachable. Start the worker with "holo broadcast:work" to enable live updates.'

type BroadcastClientConfig = {
  readonly key: string
  readonly host: string
  readonly port: number
  readonly path: string
  readonly scheme: 'http' | 'https'
}

type RealtimeWireAction = 'query' | 'mutation' | 'subscribe' | 'unsubscribe'

type RealtimeWireResult<TResult> = {
  readonly id: string
  readonly result?: RealtimeExecutionResult<TResult>
  readonly snapshot?: RealtimeSubscriptionSnapshot<TResult>
}

type RealtimeWireError = {
  readonly message: string
  readonly name?: string
  readonly status?: number
  readonly code?: string
  readonly kind?: RealtimeClientErrorKind
}

type RealtimeWebSocketLike = {
  readonly readyState: number
  send(value: string): void
  close(): void
  addEventListener(event: 'open', listener: () => void): void
  addEventListener(event: 'close', listener: () => void): void
  addEventListener(event: 'error', listener: () => void): void
  addEventListener(event: 'message', listener: (event: { readonly data: unknown }) => void): void
}

type RealtimeWebSocketConstructor = new (url: string) => RealtimeWebSocketLike

type RealtimeClientGlobals = typeof globalThis & {
  readonly WebSocket?: RealtimeWebSocketConstructor
  readonly fetch?: typeof fetch
  readonly location?: {
    readonly protocol?: string
    readonly hostname?: string
  }
}

class RealtimeClientError extends Error {
  readonly status: number | undefined
  readonly code: string | undefined
  readonly kind: RealtimeClientErrorKind

  constructor(message: string, options: RealtimeClientErrorOptions = {}) {
    super(message)
    this.name = options.name ?? 'RealtimeClientError'
    this.status = options.status
    this.code = options.code
    this.kind = options.kind ?? 'runtime'
  }
}

class RealtimeAuthorizationError extends RealtimeClientError {
  constructor(message: string, options: Omit<RealtimeClientErrorOptions, 'kind'> = {}) {
    super(message, {
      ...options,
      name: options.name ?? 'RealtimeAuthorizationError',
      kind: 'authorization',
    })
  }
}

function getRealtimeClientState(): RealtimeClientState {
  const runtime = globalThis as typeof globalThis & {
    __holoRealtimeClient__?: RealtimeClientState
  }

  runtime.__holoRealtimeClient__ ??= {
    stores: new Map<string, MutableRealtimeQueryStore<unknown>>(),
    warnedMessages: new Set<string>(),
  }
  return runtime.__holoRealtimeClient__
}

function warnRealtimeOnce(message: string): void {
  const state = getRealtimeClientState()
  if (state.warnedMessages.has(message)) {
    return
  }

  state.warnedMessages.add(message)
  console.warn(`[@holo-js/realtime] ${message}`)
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

function createMissingRealtimeTransport(): RealtimeClientTransport {
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

function parseRealtimeJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {}
  }

  return parsed as Record<string, unknown>
}

function parseWireData(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return parseRealtimeJsonObject(value)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function normalizeRealtimeErrorKind(value: unknown): RealtimeClientErrorKind | undefined {
  if (value === 'authorization' || value === 'transport' || value === 'runtime') {
    return value
  }

  return undefined
}

function normalizeRealtimeErrorStatus(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
    return value
  }

  return undefined
}

function parseWireError(data: Record<string, unknown>): RealtimeWireError {
  const status = normalizeRealtimeErrorStatus(data.status)
  const kind = normalizeRealtimeErrorKind(data.kind)

  return {
    message: typeof data.message === 'string' ? data.message : unavailableTransportMessage,
    ...(typeof data.name === 'string' ? { name: data.name } : {}),
    ...(typeof data.code === 'string' ? { code: data.code } : {}),
    ...(typeof status === 'undefined' ? {} : { status }),
    ...(typeof kind === 'undefined' ? {} : { kind }),
  }
}

function createWireError(data: Record<string, unknown>): RealtimeClientError {
  const error = parseWireError(data)
  if (error.kind === 'authorization') {
    return new RealtimeAuthorizationError(error.message, error)
  }

  return new RealtimeClientError(error.message, error)
}

function resolveWebSocketScheme(scheme: BroadcastClientConfig['scheme'], globals: RealtimeClientGlobals): 'ws' | 'wss' {
  if (scheme === 'https') {
    return 'wss'
  }

  if (globals.location?.protocol === 'https:') {
    return 'wss'
  }

  return 'ws'
}

function resolveBrowserHost(host: string, globals: RealtimeClientGlobals): string {
  const browserHostname = globals.location?.hostname
  if (!browserHostname) {
    return host === '0.0.0.0' ? '127.0.0.1' : host
  }

  const loopbackHosts = new Set(['0.0.0.0', '127.0.0.1', 'localhost', '::1', '[::1]'])
  if (loopbackHosts.has(host) && loopbackHosts.has(browserHostname)) {
    return browserHostname
  }

  return host
}

async function resolveBroadcastClientConfig(
  endpoint: string,
  globals: RealtimeClientGlobals,
): Promise<BroadcastClientConfig> {
  if (!globals.fetch) {
    throw new Error('Realtime live updates require fetch support in this runtime.')
  }

  const response = await globals.fetch(endpoint, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    throw new Error(`Realtime broadcast config failed with HTTP ${response.status}.`)
  }

  const config = await response.json() as Partial<BroadcastClientConfig>
  if (
    typeof config.key !== 'string'
    || typeof config.host !== 'string'
    || typeof config.port !== 'number'
    || typeof config.path !== 'string'
    || (config.scheme !== 'http' && config.scheme !== 'https')
  ) {
    throw new Error('Realtime broadcast config response is invalid.')
  }

  return {
    key: config.key,
    host: config.host,
    port: config.port,
    path: config.path,
    scheme: config.scheme,
  }
}

export function createBroadcastRealtimeTransport(options: {
  readonly configEndpoint?: string
} = {}): RealtimeClientTransport {
  const pending = new Map<string, {
    readonly resolve: (value: RealtimeWireResult<unknown>) => void
    readonly reject: (error: unknown) => void
  }>()
  const subscriptions = new Map<string, {
    readonly listener: (snapshot: RealtimeSubscriptionSnapshot<unknown>) => void
    readonly onError: (error: unknown) => void
  }>()
  let socket: RealtimeWebSocketLike | undefined
  let connecting: Promise<RealtimeWebSocketLike> | undefined
  let nextRequestId = 0

  const rejectPending = (error: unknown): void => {
    for (const request of pending.values()) {
      request.reject(error)
    }
    pending.clear()
    for (const subscription of subscriptions.values()) {
      subscription.onError(error)
    }
  }

  const handleMessage = (event: { readonly data: unknown }): void => {
    if (typeof event.data !== 'string') {
      return
    }

    const message = parseRealtimeJsonObject(event.data)
    const eventName = typeof message.event === 'string' ? message.event : ''
    const data = parseWireData(message.data)
    const id = typeof data.id === 'string' ? data.id : ''
    if (!id) {
      return
    }

    if (eventName === 'holo:realtime:error') {
      const error = createWireError(data)
      pending.get(id)?.reject(error)
      pending.delete(id)
      subscriptions.get(id)?.onError(error)
      return
    }

    if (eventName === 'holo:realtime:result') {
      pending.get(id)?.resolve(data as RealtimeWireResult<unknown>)
      pending.delete(id)
      return
    }

    if (eventName === 'holo:realtime:snapshot') {
      const snapshot = data.snapshot
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        subscriptions.get(id)?.listener(snapshot as RealtimeSubscriptionSnapshot<unknown>)
      }
    }
  }

  const connect = async (): Promise<RealtimeWebSocketLike> => {
    const globals = globalThis as RealtimeClientGlobals
    if (socket?.readyState === 1) {
      return socket
    }

    if (connecting) {
      return await connecting
    }

    connecting = (async () => {
      const WebSocketConstructor = globals.WebSocket
      if (!WebSocketConstructor) {
        throw new Error('Realtime live updates require WebSocket support in this runtime.')
      }

      const config = await resolveBroadcastClientConfig(options.configEndpoint ?? '/broadcasting/config', globals)
      const scheme = resolveWebSocketScheme(config.scheme, globals)
      const host = resolveBrowserHost(config.host, globals)
      const normalizedPath = `/${config.path.replace(/^\/+|\/+$/g, '')}`
      const url = `${scheme}://${host}:${config.port}${normalizedPath}/${encodeURIComponent(config.key)}`

      return await new Promise<RealtimeWebSocketLike>((resolve, reject) => {
        const nextSocket = new WebSocketConstructor(url)
        socket = nextSocket
        nextSocket.addEventListener('open', () => {
          resolve(nextSocket)
        })
        nextSocket.addEventListener('message', handleMessage)
        nextSocket.addEventListener('close', () => {
          socket = undefined
          connecting = undefined
          const error = new Error(unavailableTransportMessage)
          warnRealtimeOnce(unavailableTransportMessage)
          rejectPending(error)
        })
        nextSocket.addEventListener('error', () => {
          socket = undefined
          connecting = undefined
          const error = new Error(unavailableTransportMessage)
          warnRealtimeOnce(unavailableTransportMessage)
          reject(error)
          rejectPending(error)
        })
      })
    })().finally(() => {
      connecting = undefined
    })

    return await connecting
  }

  const send = async <TResult>(
    action: RealtimeWireAction,
    name: string,
    args: Record<string, unknown>,
    id = `realtime.${++nextRequestId}`,
  ): Promise<RealtimeWireResult<TResult>> => {
    try {
      const connectedSocket = await connect()
      const response = new Promise<RealtimeWireResult<TResult>>((resolve, reject) => {
        pending.set(id, {
          resolve: value => resolve(value as RealtimeWireResult<TResult>),
          reject,
        })
      })
      connectedSocket.send(JSON.stringify({
        event: 'holo:realtime',
        data: {
          id,
          action,
          name,
          args,
        },
      }))
      return await response
    } catch (error) {
      warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      throw error
    }
  }

  const sendSubscription = async (
    name: string,
    args: Record<string, unknown>,
    id: string,
  ): Promise<void> => {
    try {
      const connectedSocket = await connect()
      connectedSocket.send(JSON.stringify({
        event: 'holo:realtime',
        data: {
          id,
          action: 'subscribe',
          name,
          args,
        },
      }))
    } catch (error) {
      warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      throw error
    }
  }

  const transport: RealtimeClientTransport = {
    async query<TResult>(name: string, args: Record<string, unknown>) {
      const response = await send<TResult>('query', name, args)
      if (!response.snapshot) {
        throw new Error('Realtime query response did not include a snapshot.')
      }

      return response.snapshot
    },
    async mutate<TResult>(name: string, args: Record<string, unknown>) {
      const response = await send<TResult>('mutation', name, args)
      if (!response.result) {
        throw new Error('Realtime mutation response did not include a result.')
      }

      return response.result
    },
    subscribe<TResult>(
      name: string,
      args: Record<string, unknown>,
      listener: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void,
      onError: (error: unknown) => void,
    ) {
      const id = `realtime.${++nextRequestId}`
      subscriptions.set(id, {
        listener: snapshot => listener(snapshot as RealtimeSubscriptionSnapshot<TResult>),
        onError,
      })
      void sendSubscription(name, args, id).catch((error) => {
        warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
        onError(error)
      })

      return () => {
        subscriptions.delete(id)
        if (socket?.readyState === 1) {
          socket.send(JSON.stringify({
            event: 'holo:realtime',
            data: {
              id,
              action: 'unsubscribe',
              args: {},
            },
          }))
        }
      }
    },
  }

  return transport
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
  let startupId = 0

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

      const currentStartupId = startupId + 1
      startupId = currentStartupId
      let seenLiveSnapshot = false
      void transport.query<TResult>(name, args).then((nextSnapshot) => {
        if (connected && startupId === currentStartupId && !seenLiveSnapshot) {
          setSnapshot(nextSnapshot)
        }
      }, (error) => {
        warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      })
      try {
        unsubscribe = transport.subscribe<TResult>(name, args, (nextSnapshot) => {
          if (startupId !== currentStartupId) {
            return
          }

          seenLiveSnapshot = true
          setSnapshot(nextSnapshot)
        }, (error) => {
          connected = false
          warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
        })
        connected = true
      } catch (error) {
        connected = false
        unsubscribe = () => {}
        warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
      }
    },
    setSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unsubscribe()
          connected = false
          startupId += 1
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

export function hasConfiguredRealtimeClientTransport(): boolean {
  return !!getRealtimeClientState().transport
}

export function hasConfiguredRealtimeClientRuntime(): boolean {
  return !!getRealtimeClientState().framework
}

export function resetRealtimeClientRuntime(): void {
  const state = getRealtimeClientState()
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
): RealtimeResultFor<TDefinition> | undefined {
  const framework = getRealtimeClientState().framework
  if (!framework) {
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
    warnRealtimeOnce(error instanceof Error ? error.message : unavailableTransportMessage)
  })

  return promise
}

export const realtimeClientInternals = {
  createBroadcastRealtimeTransport,
  createMissingRealtimeTransport,
  createRealtimeQueryStore,
  getRealtimeClientState,
  missingTransportMessage,
  stableStringify,
}
