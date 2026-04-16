import type {
  BroadcastJsonObject,
  GeneratedBroadcastManifest,
} from '@holo-js/broadcast'

export type FluxConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected'
export type FluxChannelKind = 'public' | 'private' | 'presence'

type ManifestEventName<TManifest extends GeneratedBroadcastManifest>
  = TManifest['events'][number]['name'] & string
type ManifestChannelPattern<TManifest extends GeneratedBroadcastManifest>
  = TManifest['channels'][number]['pattern'] & string
type ManifestChannelEntryByPattern<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = Extract<TManifest['channels'][number], { pattern: TPattern }>
type ManifestPresenceMember<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = Extract<ManifestChannelEntryByPattern<TManifest, TPattern>, { member: unknown }> extends { member: infer TMember }
  ? TMember
  : BroadcastJsonObject
type ManifestWhisperName<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = ManifestChannelEntryByPattern<TManifest, TPattern>['whispers'][number] & string
type ManifestEventNamesForPattern<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = Extract<TManifest['events'][number], { channels: readonly { pattern: TPattern }[] }>['name'] & string

export interface FluxClientOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> {
  readonly manifest?: TManifest
  readonly connection?: string
  readonly connector?: FluxConnector
  readonly connectorFactory?: (options: FluxClientOptions<TManifest>) => FluxConnector
}

export interface FluxListenerControls {
  leaveChannel(): void
  leave(): void
  stopListening(): void
  listen(): FluxListenerControls
}

export interface FluxPresenceState<TMember = unknown> {
  readonly members: readonly TMember[]
}

export interface FluxConnectionControls {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): FluxConnectionStatus
  onStatusChange(callback: (status: FluxConnectionStatus) => void): () => void
}

export interface FluxConnectorChannel {
  readonly name: string
  readonly kind: FluxChannelKind
  readonly members: readonly BroadcastJsonObject[]
  onEvent(event: string, callback: (payload: BroadcastJsonObject) => void): () => void
  onMembersChange(callback: (members: readonly BroadcastJsonObject[]) => void): () => void
  onNotification(callback: (payload: BroadcastJsonObject) => void): () => void
  onWhisper(name: string, callback: (payload: BroadcastJsonObject) => void): () => void
  sendWhisper(name: string, payload: BroadcastJsonObject): Promise<void>
  leave(): void
}

export interface FluxConnector {
  connect(): Promise<void>
  disconnect(): Promise<void>
  getStatus(): FluxConnectionStatus
  onStatusChange(callback: (status: FluxConnectionStatus) => void): () => void
  subscribe(channel: string, kind: FluxChannelKind): FluxConnectorChannel
}

export interface FluxSubscription<
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends string = string,
> extends FluxListenerControls {
  readonly name: TChannel
  readonly type: FluxChannelKind
  listen<TEvent extends ManifestEventNamesForPattern<TManifest, TChannel> | ManifestEventName<TManifest>>(
    event?: TEvent | readonly TEvent[],
    callback?: (payload: BroadcastJsonObject) => void,
  ): FluxSubscription<TManifest, TChannel>
  notification(callback: (payload: BroadcastJsonObject) => void): FluxSubscription<TManifest, TChannel>
  listenForWhisper<TWhisper extends ManifestWhisperName<TManifest, TChannel>>(
    name: TWhisper,
    callback: (payload: BroadcastJsonObject) => void,
  ): FluxSubscription<TManifest, TChannel>
  whisper<TWhisper extends ManifestWhisperName<TManifest, TChannel>>(
    name: TWhisper,
    payload: BroadcastJsonObject,
  ): Promise<void>
}

export interface FluxPresenceSubscription<
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends string = string,
> extends FluxSubscription<TManifest, TChannel>, FluxPresenceState<ManifestPresenceMember<TManifest, TChannel>> {}

export interface FluxClient<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> extends FluxConnectionControls {
  readonly options: Readonly<FluxClientOptions<TManifest>>
  readonly status: FluxConnectionStatus
  channel<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel): FluxSubscription<TManifest, TChannel>
  private<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel): FluxSubscription<TManifest, TChannel>
  presence<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel): FluxPresenceSubscription<TManifest, TChannel>
}

type PusherConnectorOptions = {
  readonly transport?: 'mock'
}

type PusherConnectorDebug = {
  emitEvent(channel: string, event: string, payload: BroadcastJsonObject): void
  emitNotification(channel: string, payload: BroadcastJsonObject): void
  updatePresenceMembers(channel: string, members: readonly BroadcastJsonObject[]): void
  getJoinedChannels(): readonly string[]
}

type ConnectorDebugCarrier = {
  readonly __debug?: PusherConnectorDebug
}

type CallbackMap = Map<string, Set<(payload: BroadcastJsonObject) => void>>
type CallbackSetMap = Map<string, Set<(payload: BroadcastJsonObject) => void>>

type PusherChannelState = {
  readonly name: string
  readonly kind: FluxChannelKind
  readonly eventListeners: CallbackMap
  readonly whisperListeners: CallbackMap
  readonly notificationListeners: Set<(payload: BroadcastJsonObject) => void>
  readonly memberListeners: Set<(members: readonly BroadcastJsonObject[]) => void>
  members: readonly BroadcastJsonObject[]
}

type SubscriptionRegistry = Map<string, Set<() => void>>

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/flux] ${label} must be a non-empty string.`)
  }

  return normalized
}

function toReadonlyArray<T>(value: T | readonly T[]): readonly T[] {
  return (Array.isArray(value) ? [...value] : [value]) as readonly T[]
}

function addCallback(map: CallbackMap, event: string, callback: (payload: BroadcastJsonObject) => void): () => void {
  const listeners = map.get(event) ?? new Set<(payload: BroadcastJsonObject) => void>()
  listeners.add(callback)
  map.set(event, listeners)
  return () => {
    listeners.delete(callback)
    if (listeners.size === 0) {
      map.delete(event)
    }
  }
}

function notifyStatusListeners(
  listeners: Set<(status: FluxConnectionStatus) => void>,
  status: FluxConnectionStatus,
): void {
  for (const listener of listeners) {
    listener(status)
  }
}

function createUnavailableConnector(): FluxConnector {
  const statusListeners = new Set<(status: FluxConnectionStatus) => void>()
  let status: FluxConnectionStatus = 'idle'

  const throwUnavailable = (): never => {
    throw new Error('[@holo-js/flux] No realtime connector configured. Pass connector or connectorFactory to createFluxClient(...).')
  }

  return Object.freeze({
    async connect() {
      throwUnavailable()
    },
    async disconnect() {
      if (status !== 'disconnected') {
        status = 'disconnected'
        notifyStatusListeners(statusListeners, status)
      }
    },
    getStatus() {
      return status
    },
    onStatusChange(callback: (status: FluxConnectionStatus) => void) {
      statusListeners.add(callback)
      return () => {
        statusListeners.delete(callback)
      }
    },
    subscribe() {
      return throwUnavailable()
    },
  })
}

function createPusherConnector(options: PusherConnectorOptions = {}): FluxConnector & ConnectorDebugCarrier {
  const channels = new Map<string, PusherChannelState>()
  const statusListeners = new Set<(status: FluxConnectionStatus) => void>()
  let status: FluxConnectionStatus = 'idle'
  void options

  const ensureChannel = (name: string, kind: FluxChannelKind): PusherChannelState => {
    const key = `${kind}:${name}`
    const existing = channels.get(key)
    if (existing) {
      return existing
    }

    const state: PusherChannelState = {
      name,
      kind,
      eventListeners: new Map(),
      whisperListeners: new Map(),
      notificationListeners: new Set(),
      memberListeners: new Set(),
      members: Object.freeze([]),
    }
    channels.set(key, state)
    return state
  }

  const debug: PusherConnectorDebug = Object.freeze({
    emitEvent(channel, event, payload) {
      for (const state of channels.values()) {
        if (state.name !== channel) {
          continue
        }
        for (const callback of state.eventListeners.get(event) ?? []) {
          callback(payload)
        }
      }
    },
    emitNotification(channel, payload) {
      for (const state of channels.values()) {
        if (state.name !== channel) {
          continue
        }
        for (const callback of state.notificationListeners) {
          callback(payload)
        }
      }
    },
    updatePresenceMembers(channel, members) {
      for (const state of channels.values()) {
        if (state.name === channel && state.kind === 'presence') {
          state.members = Object.freeze([...members])
          for (const callback of state.memberListeners) {
            callback(state.members)
          }
        }
      }
    },
    getJoinedChannels() {
      return Object.freeze([...channels.values()].map(state => `${state.kind}:${state.name}`))
    },
  })

  return Object.freeze({
    __debug: debug,
    async connect() {
      if (status === 'connected') {
        return
      }
      status = 'connecting'
      notifyStatusListeners(statusListeners, status)
      status = 'connected'
      notifyStatusListeners(statusListeners, status)
    },
    async disconnect() {
      status = 'disconnected'
      notifyStatusListeners(statusListeners, status)
      channels.clear()
    },
    getStatus() {
      return status
    },
    onStatusChange(callback: (status: FluxConnectionStatus) => void) {
      statusListeners.add(callback)
      return () => {
        statusListeners.delete(callback)
      }
    },
    subscribe(channel: string, kind: FluxChannelKind) {
      const state = ensureChannel(channel, kind)
      return Object.freeze({
        name: state.name,
        kind: state.kind,
        get members() {
          return state.members
        },
        onEvent(event: string, callback: (payload: BroadcastJsonObject) => void) {
          return addCallback(state.eventListeners, event, callback)
        },
        onMembersChange(callback: (members: readonly BroadcastJsonObject[]) => void) {
          state.memberListeners.add(callback)
          return () => {
            state.memberListeners.delete(callback)
          }
        },
        onNotification(callback: (payload: BroadcastJsonObject) => void) {
          state.notificationListeners.add(callback)
          return () => {
            state.notificationListeners.delete(callback)
          }
        },
        onWhisper(name: string, callback: (payload: BroadcastJsonObject) => void) {
          return addCallback(state.whisperListeners, name, callback)
        },
        async sendWhisper(name: string, payload: BroadcastJsonObject) {
          for (const callback of state.whisperListeners.get(name) ?? []) {
            callback(payload)
          }
        },
        leave() {
          channels.delete(`${state.kind}:${state.name}`)
        },
      })
    },
  })
}

function createSubscription<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
>(
  channelName: TChannel,
  kind: FluxChannelKind,
  connector: FluxConnector,
  registry: SubscriptionRegistry,
): FluxSubscription<TManifest, TChannel> & {
  readonly __presenceMembers: () => readonly BroadcastJsonObject[]
  readonly __onPresenceChange: (callback: (members: readonly BroadcastJsonObject[]) => void) => () => void
} {
  const connectorChannel = connector.subscribe(channelName, kind)
  let active = true
  const detachCallbacks = new Set<() => void>()
  const connectedEvents = new Set<string>()
  const eventHandlers: CallbackMap = new Map()
  const whisperHandlers: CallbackSetMap = new Map()
  const registryKey = `${kind}:${channelName
    .replace(/^private-/, '')
    .replace(/^presence-/, '')}`
  let left = false
  const notificationHandlers = new Set<(payload: BroadcastJsonObject) => void>()

  const registeredSubscriptions = registry.get(registryKey) ?? new Set<() => void>()
  registry.set(registryKey, registeredSubscriptions)

  const runWhenActive = <TPayload>(callback: (payload: TPayload) => void) => {
    return (payload: TPayload) => {
      if (active) {
        callback(payload)
      }
    }
  }

  const ensureEvent = (event: string, callback: (payload: BroadcastJsonObject) => void): void => {
    const normalizedEvent = normalizeRequiredString(event, 'Flux event')
    const listeners = eventHandlers.get(normalizedEvent) ?? new Set<(payload: BroadcastJsonObject) => void>()
    listeners.add(callback)
    eventHandlers.set(normalizedEvent, listeners)
    if (!connectedEvents.has(normalizedEvent)) {
      connectedEvents.add(normalizedEvent)
      const stop = connectorChannel.onEvent(normalizedEvent, runWhenActive((payload) => {
        /* v8 ignore next -- defensive fallback; eventHandlers is always set before callback registration */
        for (const listener of eventHandlers.get(normalizedEvent) ?? []) {
          listener(payload)
        }
      }))
      detachCallbacks.add(stop)
    }
  }

  const ensureNotification = (callback: (payload: BroadcastJsonObject) => void): void => {
    notificationHandlers.add(callback)
    if (!connectedEvents.has('notification')) {
      connectedEvents.add('notification')
      const stop = connectorChannel.onNotification(runWhenActive((payload) => {
        for (const listener of notificationHandlers) {
          listener(payload)
        }
      }))
      detachCallbacks.add(stop)
    }
  }

  const ensureWhisper = (event: string, callback: (payload: BroadcastJsonObject) => void): void => {
    const normalizedEvent = normalizeRequiredString(event, 'Flux whisper event')
    const listeners = whisperHandlers.get(normalizedEvent) ?? new Set<(payload: BroadcastJsonObject) => void>()
    listeners.add(callback)
    whisperHandlers.set(normalizedEvent, listeners)
    if (!connectedEvents.has(`whisper:${normalizedEvent}`)) {
      connectedEvents.add(`whisper:${normalizedEvent}`)
      const stop = connectorChannel.onWhisper(normalizedEvent, runWhenActive((payload) => {
        /* v8 ignore next -- defensive fallback; whisperHandlers is always set before callback registration */
        for (const listener of whisperHandlers.get(normalizedEvent) ?? []) {
          listener(payload)
        }
      }))
      detachCallbacks.add(stop)
    }
  }

  const stopListening = () => {
    active = false
  }

  const resumeListening = () => {
    active = true
  }

  const leaveChannel = () => {
    if (left) {
      return
    }

    left = true
    active = false
    for (const detach of detachCallbacks) {
      detach()
    }
    detachCallbacks.clear()
    registeredSubscriptions.delete(leaveChannel)
    if (registeredSubscriptions.size === 0) {
      registry.delete(registryKey)
    }
    connectorChannel.leave()
  }

  const leaveRelated = () => {
    /* v8 ignore next -- defensive fallback; registry always has the key when leaveRelated is callable */
    for (const leave of [...(registry.get(registryKey) ?? [])]) {
      leave()
    }
  }

  registeredSubscriptions.add(leaveChannel)

  const subscription = {
    name: channelName,
    type: kind,
    leaveChannel,
    leave: leaveRelated,
    stopListening,
    listen(event?: string | readonly string[], callback?: (payload: BroadcastJsonObject) => void): FluxSubscription<TManifest, TChannel> {
      if (typeof event === 'undefined' || typeof callback === 'undefined') {
        resumeListening()
        return this
      }

      for (const entry of toReadonlyArray(event)) {
        ensureEvent(String(entry), callback)
      }
      return this
    },
    notification(callback: (payload: BroadcastJsonObject) => void) {
      ensureNotification(callback)
      return this
    },
    listenForWhisper(name: string, callback: (payload: BroadcastJsonObject) => void) {
      ensureWhisper(name, callback as (payload: BroadcastJsonObject) => void)
      return this
    },
    async whisper(name: string, payload: BroadcastJsonObject) {
      await connectorChannel.sendWhisper(normalizeRequiredString(name, 'Flux whisper event'), payload)
    },
    __presenceMembers() {
      return connectorChannel.members
    },
    __onPresenceChange(callback: (members: readonly BroadcastJsonObject[]) => void) {
      return connectorChannel.onMembersChange(callback)
    },
  } satisfies FluxSubscription<TManifest, TChannel> & {
    readonly __presenceMembers: () => readonly BroadcastJsonObject[]
    readonly __onPresenceChange: (callback: (members: readonly BroadcastJsonObject[]) => void) => () => void
  }

  return Object.freeze(subscription)
}

function createPresenceSubscription<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
>(
  name: TChannel,
  connector: FluxConnector,
  registry: SubscriptionRegistry,
): FluxPresenceSubscription<TManifest, TChannel> {
  const base = createSubscription<TManifest, TChannel>(name, 'presence', connector, registry)
  return Object.freeze({
    ...base,
    get members() {
      return base.__presenceMembers() as readonly ManifestPresenceMember<TManifest, TChannel>[]
    },
  }) as FluxPresenceSubscription<TManifest, TChannel>
}

export function createFluxClient<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxClientOptions<TManifest> = {},
): FluxClient<TManifest> & ConnectorDebugCarrier {
  const connector = options.connector
    ?? options.connectorFactory?.(options)
    ?? createUnavailableConnector()
  const subscriptionRegistry: SubscriptionRegistry = new Map()

  const client = {
    options: Object.freeze({ ...options }),
    get status() {
      return connector.getStatus()
    },
    async connect() {
      await connector.connect()
    },
    async disconnect() {
      await connector.disconnect()
    },
    getStatus() {
      return connector.getStatus()
    },
    onStatusChange(callback: (status: FluxConnectionStatus) => void) {
      return connector.onStatusChange(callback)
    },
    channel<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel) {
      return createSubscription(name, 'public', connector, subscriptionRegistry)
    },
    private<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel) {
      return createSubscription(name, 'private', connector, subscriptionRegistry)
    },
    presence<TChannel extends ManifestChannelPattern<TManifest> | (string & {})>(name: TChannel) {
      return createPresenceSubscription(name, connector, subscriptionRegistry)
    },
    ...('__debug' in connector ? { __debug: (connector as ConnectorDebugCarrier).__debug } : {}),
  } satisfies FluxClient<TManifest> & ConnectorDebugCarrier

  return Object.freeze(client) as FluxClient<TManifest> & ConnectorDebugCarrier
}

let defaultFluxClient = createFluxClient()

export function configureFluxClient(options: FluxClientOptions | FluxClient): FluxClient {
  defaultFluxClient = 'channel' in options ? options : createFluxClient(options)
  return defaultFluxClient
}

export function getFluxClient(): FluxClient {
  return defaultFluxClient
}

export function resetFluxClient(): void {
  defaultFluxClient = createFluxClient()
}

export const flux = new Proxy({} as FluxClient, {
  get(_target, property) {
    return Reflect.get(getFluxClient(), property)
  },
  has(_target, property) {
    return Reflect.has(getFluxClient() as object, property)
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getFluxClient() as object)
  },
})

export const fluxInternals = {
  createUnavailableConnector,
  createPusherConnector,
  createPresenceSubscription,
  createSubscription,
}

export default flux
