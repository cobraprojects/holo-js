import { createHash, createHmac, randomInt, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { NormalizedHoloBroadcastConfig, NormalizedHoloQueueConfig } from '@holo-js/config'
import {
  authorizeBroadcastChannel,
  validateBroadcastWhisperPayload,
} from './auth'
import type {
  BroadcastChannelAuthRuntimeBindings,
  BroadcastJsonObject,
  BroadcastRuntimeBindings,
} from './contracts'

type WorkerConnectionInfo = {
  readonly socketId: string
  readonly app: BroadcastWorkerApp
  readonly headers: Headers
}

type WorkerWebSocketConnection = WorkerConnectionInfo & {
  readonly send: (payload: string) => void
  readonly close: (code?: number, reason?: string) => void
}

type PublishBody = {
  readonly name: string
  readonly channels: readonly string[]
  readonly data: string
  readonly socket_id?: string
}

type ResolvedPublishBody = PublishBody & {
  readonly appId: string
}

type PublishDelivery = {
  readonly deliveredChannels: readonly string[]
  readonly deliveredSockets: number
}

type BroadcastWorkerApp = {
  readonly connection: string
  readonly appId: string
  readonly key: string
  readonly secret: string
  readonly authEndpoint?: string
}

type PresenceMember = Readonly<Record<string, unknown>>

type SocketState = {
  readonly socketId: string
  readonly app: BroadcastWorkerApp
  readonly headers: Headers
  readonly send: (payload: string) => void
  readonly close: (code?: number, reason?: string) => void
  readonly subscribedChannels: Set<string>
  active: boolean
  pendingMessage: Promise<void>
}

type WorkerRuntimeOptions = {
  readonly config: NormalizedHoloBroadcastConfig
  readonly channelAuth?: BroadcastChannelAuthRuntimeBindings
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly scaling?: BroadcastWorkerScalingRuntime
  readonly scalingAutoSubscribe?: boolean
  readonly scalingUnsubscribe?: () => Promise<void> | void
}

type BunServerLike = {
  readonly port: number
  readonly hostname: string
  stop(closeConnections?: boolean): void
}

export interface BroadcastWorkerRuntime {
  readonly fetch: (request: Request) => Promise<Response>
  readonly connectWebSocket: (connection: WorkerWebSocketConnection) => void
  readonly receiveWebSocketMessage: (socketId: string, rawMessage: string) => Promise<void>
  readonly receiveScalingMessage: (payload: string) => Promise<void>
  readonly disconnectWebSocket: (socketId: string) => void
  readonly getStats: () => BroadcastWorkerStats
  readonly close: () => Promise<void>
}

export interface BroadcastWorkerStats {
  readonly nodeId: string
  readonly uptimeMs: number
  readonly apps: readonly string[]
  readonly appScopes: readonly {
    readonly connection: string
    readonly appId: string
    readonly key: string
  }[]
  readonly connectionCount: number
  readonly subscribedChannelCount: number
  readonly presenceChannelCount: number
  readonly scaling: false | {
    readonly driver: 'redis'
    readonly connection: string
    readonly eventChannel: string
  }
}

export interface StartedBroadcastWorker {
  readonly host: string
  readonly port: number
  readonly stop: () => Promise<void>
}

type BroadcastWorkerBunGlobal = {
  serve(options: {
    readonly hostname?: string
    readonly port?: number
    readonly fetch: (request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }) => Promise<Response> | Response
    readonly websocket: {
      open: (socket: { data: WorkerConnectionInfo, send(value: string): void, close(code?: number, reason?: string): void }) => void
      message: (socket: { data: WorkerConnectionInfo, send(value: string): void, close(code?: number, reason?: string): void }, message: string | Uint8Array) => void
      close: (socket: { data: WorkerConnectionInfo, send(value: string): void, close(code?: number, reason?: string): void }) => void
    }
  }): BunServerLike
}

type NodeWebSocketLike = {
  send(value: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void): unknown
  on(event: 'close', listener: () => void): unknown
}

type NodeWebSocketServerLike = {
  on(event: 'connection', listener: (socket: NodeWebSocketLike, request: IncomingMessage) => void): unknown
  emit(event: 'connection', socket: NodeWebSocketLike, request: IncomingMessage): boolean
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: NodeWebSocketLike, request: IncomingMessage) => void,
  ): void
  close(callback?: (error?: Error) => void): void
}

type NodeWebSocketModuleLike = {
  WebSocketServer: new (options: { noServer: true }) => NodeWebSocketServerLike
}

type BroadcastScalingEventMessage = {
  readonly type: 'event'
  readonly originNodeId: string
  readonly appId: string
  readonly name: string
  readonly channels: readonly string[]
  readonly data: string
  readonly socketId?: string
}

type BroadcastScalingPresenceMemberAddedMessage = {
  readonly type: 'presence-member-added'
  readonly originNodeId: string
  readonly appId: string
  readonly channel: string
  readonly socketId: string
  readonly member: PresenceMember
}

type BroadcastScalingPresenceMemberRemovedMessage = {
  readonly type: 'presence-member-removed'
  readonly originNodeId: string
  readonly appId: string
  readonly channel: string
  readonly socketId: string
  readonly member: PresenceMember
}

type BroadcastScalingMessage =
  | BroadcastScalingEventMessage
  | BroadcastScalingPresenceMemberAddedMessage
  | BroadcastScalingPresenceMemberRemovedMessage

type BroadcastRedisScalingConnection = {
  readonly host: string
  readonly port: number
  readonly username?: string
  readonly password?: string
  readonly db: number
}

type BroadcastScalingAdapter = {
  publish(channel: string, payload: string): Promise<void>
  subscribe(channel: string, onMessage: (payload: string) => void): Promise<() => Promise<void> | void>
  hashSet(key: string, field: string, value: string): Promise<void>
  hashDelete(key: string, field: string): Promise<void>
  hashGetAll(key: string): Promise<Readonly<Record<string, string>>>
  close(): Promise<void>
}

const MAX_PUBLISH_TIMESTAMP_SKEW_SECONDS = 300

type BroadcastWorkerScalingRuntime = {
  readonly driver: 'redis'
  readonly connection: string
  readonly nodeId: string
  readonly eventChannel: string
  readonly adapter: BroadcastScalingAdapter
}

type RedisScalingModuleLike = {
  default: new (options: {
    host: string
    port: number
    username?: string
    password?: string
    db?: number
  }) => {
    duplicate(): {
      subscribe(channel: string): Promise<number>
      on(event: 'message', callback: (channel: string, payload: string) => void): unknown
      off(event: 'message', callback: (channel: string, payload: string) => void): unknown
      unsubscribe(channel: string): Promise<number>
      quit(): Promise<unknown>
      disconnect(): void
    }
    publish(channel: string, payload: string): Promise<number>
    hset(key: string, field: string, value: string): Promise<number>
    hdel(key: string, ...fields: string[]): Promise<number>
    hgetall(key: string): Promise<Record<string, string>>
    quit(): Promise<unknown>
    disconnect(): void
  }
}

function normalizeRequiredString(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a non-empty string.`)
  }

  return normalized
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error(`[@holo-js/broadcast] ${label} must be valid JSON.`)
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a JSON object.`)
  }

  return parsed as Record<string, unknown>
}

function parseSocketMessage(rawMessage: string): { readonly event: string, readonly channel?: string, readonly data: Record<string, unknown> } {
  const message = parseJsonObject(rawMessage, 'Websocket message')
  const event = normalizeRequiredString(String(message.event ?? ''), 'Websocket event')
  const channel = typeof message.channel === 'string' ? normalizeRequiredString(message.channel, 'Websocket channel') : undefined
  const data = typeof message.data === 'string'
    ? parseJsonObject(message.data, 'Websocket message data')
    : (message.data && typeof message.data === 'object' && !Array.isArray(message.data) ? message.data as Record<string, unknown> : {})

  return Object.freeze({
    event,
    ...(typeof channel === 'undefined' ? {} : { channel }),
    data,
  })
}

function normalizePublishBody(value: unknown): PublishBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[@holo-js/broadcast] Publish payload must be a JSON object.')
  }

  const body = value as Record<string, unknown>
  const name = typeof body.name === 'string'
    ? normalizeRequiredString(body.name, 'Publish name')
    : typeof body.event === 'string'
      ? normalizeRequiredString(body.event, 'Publish event')
      : ''

  if (!name) {
    throw new Error('[@holo-js/broadcast] Publish payload must include an event name.')
  }

  const channels = Array.isArray(body.channels)
    ? body.channels.map((channel) => {
        if (typeof channel !== 'string') {
          throw new Error('[@holo-js/broadcast] Publish channel must be a non-empty string.')
        }

        return normalizeRequiredString(channel, 'Publish channel')
      })
    : typeof body.channel === 'string'
      ? [normalizeRequiredString(body.channel, 'Publish channel')]
      : []

  if (channels.length === 0) {
    throw new Error('[@holo-js/broadcast] Publish payload must include at least one channel.')
  }

  const data = typeof body.data === 'string'
    ? body.data
    : JSON.stringify((body.data ?? {}) as BroadcastJsonObject)
  const socketId = typeof body.socket_id === 'string'
    ? normalizeRequiredString(body.socket_id, 'Publish socket_id')
    : undefined

  return Object.freeze({
    name,
    channels: Object.freeze(channels),
    data,
    ...(typeof socketId === 'undefined' ? {} : { socket_id: socketId }),
  })
}

function createPusherSignature(secret: string, method: string, pathname: string, params: URLSearchParams): string {
  const sorted = [...params.entries()]
    .filter(([key]) => key !== 'auth_signature')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
  const payload = `${method.toUpperCase()}\n${pathname}\n${sorted}`
  return createHmac('sha256', secret).update(payload).digest('hex')
}

function logSocketMessageError(socketId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[@holo-js/broadcast] WebSocket message handling failed for socket "${socketId}": ${message}`)
}

function logScalingMessageError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[@holo-js/broadcast] Scaling message handling failed: ${message}`)
}

function logSocketCleanupError(socketId: string, channel: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[@holo-js/broadcast] Socket cleanup failed for socket "${socketId}" on "${channel}": ${message}`)
}

function parseChannelKind(channel: string): { readonly kind: 'public' | 'private' | 'presence', readonly canonical: string } {
  if (channel.startsWith('private-')) {
    return Object.freeze({
      kind: 'private',
      canonical: channel.slice('private-'.length),
    })
  }

  if (channel.startsWith('presence-')) {
    return Object.freeze({
      kind: 'presence',
      canonical: channel.slice('presence-'.length),
    })
  }

  return Object.freeze({
    kind: 'public',
    canonical: channel,
  })
}

function createSocketId(): string {
  return `${randomInt(1, 999_999)}.${randomInt(1, 999_999)}`
}

function createScalingNodeId(): string {
  return normalizeRequiredString(`${process.env.HOSTNAME ?? 'node'}-${randomUUID()}`, 'Broadcast worker node id')
}

function resolveScalingEventChannel(connection: string): string {
  return `holo:broadcast:scaling:${connection}:events`
}

function resolvePresenceHashKey(connection: string, appId: string, channel: string): string {
  return `holo:broadcast:scaling:${connection}:presence:${appId}:${channel}`
}

function createNodeSocketRef(nodeId: string, socketId: string): string {
  return `${nodeId}:${socketId}`
}

function composeSubscriptionKey(appId: string, channel: string): string {
  return `${appId}:${channel}`
}

function resolvePresenceMemberId(member: PresenceMember, fallback: string): string {
  const candidate = member.id
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return String(candidate)
  }

  return fallback
}

function serializePresenceMemberRemoved(member: PresenceMember, fallback: string): string {
  return JSON.stringify({
    user_id: resolvePresenceMemberId(member, fallback),
  })
}

function normalizePresenceMemberMessage(value: unknown, label: string): PresenceMember {
  /* v8 ignore next 3 -- defensive guard; scaling messages are always validated before reaching this point */
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a JSON object.`)
  }

  return Object.freeze(value as PresenceMember)
}

function parsePresenceHashMembers(
  values: Readonly<Record<string, string>>,
): Map<string, PresenceMember> {
  const members = new Map<string, PresenceMember>()
  for (const [socketRef, encoded] of Object.entries(values)) {
    try {
      const parsed = parseJsonObject(encoded, `Presence member "${socketRef}"`)
      members.set(socketRef, Object.freeze(parsed as PresenceMember))
    } catch {
      members.set(socketRef, Object.freeze({ id: socketRef }))
    }
  }
  return members
}

function resolveRedisScalingConnection(
  queueConfig: NormalizedHoloQueueConfig | undefined,
  connectionName: string,
): BroadcastRedisScalingConnection {
  if (!queueConfig) {
    throw new Error('[@holo-js/broadcast] Broadcast scaling requires queue config so the Redis connection can be resolved.')
  }

  const connection = queueConfig.connections[connectionName]
  if (!connection) {
    throw new Error(`[@holo-js/broadcast] Broadcast scaling connection "${connectionName}" was not found in queue connections.`)
  }

  if (connection.driver !== 'redis') {
    throw new Error(
      `[@holo-js/broadcast] Broadcast scaling connection "${connectionName}" must use the Redis queue driver.`,
    )
  }

  return Object.freeze({
    host: connection.redis.host,
    port: connection.redis.port,
    username: connection.redis.username,
    password: connection.redis.password,
    db: connection.redis.db,
  })
}

async function loadRedisScalingModule(
  loadModule?: () => Promise<unknown>,
): Promise<RedisScalingModuleLike> {
  try {
    /* v8 ignore next 4 -- exercised only when ioredis is installed and no test loader override is provided. */
    const loadDefaultModule = async (): Promise<unknown> => {
      const specifier = 'ioredis'
      return await import(specifier)
    }
    /* v8 ignore next -- covered in integration when ioredis is installed in consumer apps; unit tests inject loadModule for deterministic behavior. */
    const loaded = (await (loadModule ? loadModule() : loadDefaultModule())) as RedisScalingModuleLike
    if (!loaded || typeof loaded !== 'object' || typeof loaded.default !== 'function') {
      throw new Error('missing default Redis export')
    }

    return loaded
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find module|Failed to resolve module/i.test(message)) {
      throw new Error(
        '[@holo-js/broadcast] Redis scaling requires the "ioredis" package. Install it in your project dependencies to enable worker scaling.',
      )
    }

    throw error
  }
}

async function createRedisScalingAdapter(
  connection: BroadcastRedisScalingConnection,
  dependencies: {
    readonly loadRedisModule?: () => Promise<unknown>
  } = {},
): Promise<BroadcastScalingAdapter> {
  const redisModule = await loadRedisScalingModule(dependencies.loadRedisModule)
  const RedisCtor = redisModule.default
  const commandClient = new RedisCtor({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    password: connection.password,
    db: connection.db,
  })
  const subscriberClient = commandClient.duplicate()
  const listeners = new Map<string, (channel: string, payload: string) => void>()

  return Object.freeze({
    async publish(channel: string, payload: string) {
      await commandClient.publish(channel, payload)
    },
    async subscribe(channel: string, onMessage: (payload: string) => void) {
      const listener = (incomingChannel: string, payload: string) => {
        if (incomingChannel === channel) {
          onMessage(payload)
        }
      }
      listeners.set(channel, listener)
      subscriberClient.on('message', listener)
      await subscriberClient.subscribe(channel)
      return async () => {
        const existing = listeners.get(channel)
        if (existing) {
          await subscriberClient.unsubscribe(channel)
          subscriberClient.off('message', existing)
          listeners.delete(channel)
        }
      }
    },
    async hashSet(key: string, field: string, value: string) {
      await commandClient.hset(key, field, value)
    },
    async hashDelete(key: string, field: string) {
      await commandClient.hdel(key, field)
    },
    async hashGetAll(key: string) {
      return Object.freeze(await commandClient.hgetall(key))
    },
    async close() {
      try {
        await subscriberClient.quit()
      } catch {
        subscriberClient.disconnect()
      }
      try {
        await commandClient.quit()
      } catch {
        commandClient.disconnect()
      }
    },
  })
}

function buildWorkerApps(config: NormalizedHoloBroadcastConfig): Readonly<Record<string, BroadcastWorkerApp>> {
  const appsByKey = new Map<string, BroadcastWorkerApp>()

  for (const [name, connection] of Object.entries(config.connections)) {
    if (connection.driver !== 'holo' || !('key' in connection) || !('secret' in connection) || !('appId' in connection)) {
      continue
    }

    const holoConnection = connection as Extract<NormalizedHoloBroadcastConfig['connections'][string], { readonly driver: 'holo' }>
    const authEndpoint = typeof holoConnection.clientOptions.authEndpoint === 'string'
      ? normalizeRequiredString(holoConnection.clientOptions.authEndpoint, `Broadcast connection "${name}" authEndpoint`)
      : undefined
    if (appsByKey.has(holoConnection.key)) {
      throw new Error(`[@holo-js/broadcast] duplicate broadcast app key "${holoConnection.key}" is already configured.`)
    }

    appsByKey.set(holoConnection.key, Object.freeze({
      connection: name,
      appId: holoConnection.appId,
      key: holoConnection.key,
      secret: holoConnection.secret,
      ...(typeof authEndpoint === 'undefined' ? {} : { authEndpoint }),
    }))
  }

  if (appsByKey.size === 0) {
    throw new Error('[@holo-js/broadcast] Broadcast worker requires at least one "holo" broadcast connection.')
  }

  return Object.freeze(Object.fromEntries(appsByKey))
}

function pusherEvent(event: string, data: unknown, channel?: string): string {
  return JSON.stringify({
    event,
    ...(typeof channel === 'undefined' ? {} : { channel }),
    data: typeof data === 'string' ? data : JSON.stringify(data),
  })
}

async function authenticateSubscription(
  app: BroadcastWorkerApp,
  connection: SocketState,
  channel: string,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
  fetcher?: typeof fetch,
): Promise<{ readonly whispers: readonly string[], readonly member?: PresenceMember }> {
  const { kind, canonical } = parseChannelKind(channel)
  if (kind === 'public') {
    return Object.freeze({
      whispers: Object.freeze([]),
    })
  }

  if (app.authEndpoint && fetcher) {
    const authRequest = new Request(app.authEndpoint, {
      method: 'POST',
      headers: Object.fromEntries(
        [...connection.headers.entries()].filter(([header]) => {
          const normalized = header.toLowerCase()
          return normalized === 'authorization' || normalized === 'cookie'
        }),
      ),
      body: new URLSearchParams({
        channel_name: canonical,
        socket_id: connection.socketId,
      }),
    })
    const response = await fetcher(authRequest)
    if (!response.ok) {
      throw new Error(`[@holo-js/broadcast] Channel authorization rejected (${response.status}).`)
    }

    const body = await response.json() as Record<string, unknown>
    const whispers = Array.isArray(body.whispers)
      ? Object.freeze(body.whispers.map(value => normalizeRequiredString(String(value), 'Auth whisper')))
      : Object.freeze([])
    const member = body.member && typeof body.member === 'object' && !Array.isArray(body.member)
      ? Object.freeze(body.member as PresenceMember)
      : undefined

    return Object.freeze({
      whispers,
      ...(typeof member === 'undefined' ? {} : { member }),
    })
  }

  const resolvedUser = typeof channelAuth?.resolveUser === 'function'
    ? await channelAuth.resolveUser({
      headers: connection.headers,
      socketId: connection.socketId,
      channel: canonical,
      appId: app.appId,
      connection: app.connection,
    })
    : null

  const authorized = await authorizeBroadcastChannel({
    channel: canonical,
    socketId: connection.socketId,
    user: resolvedUser ?? null,
  }, channelAuth)

  if (!authorized.ok) {
    throw new Error(`[@holo-js/broadcast] Channel authorization denied for "${channel}".`)
  }

  return Object.freeze({
    whispers: authorized.whispers,
    /* v8 ignore next -- exercised in integration tests for private and presence channel auth; expression is kept for TS narrowing. */
    ...(authorized.type === 'presence' ? { member: authorized.member } : {}),
  })
}

export function createBroadcastWorkerRuntime(options: WorkerRuntimeOptions): BroadcastWorkerRuntime {
  const appsByKey = buildWorkerApps(options.config)
  const connectedSockets = new Map<string, SocketState>()
  const channels = new Map<string, Set<string>>()
  const channelWhispers = new Map<string, Map<string, Set<string>>>()
  const presenceMembers = new Map<string, Map<string, PresenceMember>>()
  const presenceSockets = new Map<string, Map<string, string>>()
  const scaling = options.scaling
  const startedAt = options.now?.() ?? Date.now()
  const scalingUnsubscribe = options.scalingUnsubscribe
    ? Promise.resolve(options.scalingUnsubscribe)
    : scaling && options.scalingAutoSubscribe !== false
      ? scaling.adapter.subscribe(scaling.eventChannel, (payload) => {
        void handleScalingMessage(payload).catch((error) => {
          logScalingMessageError(error)
        })
      })
    : Promise.resolve(async () => {})

  function createPresenceSocketRef(channel: string, socketId: string): string {
    return scaling && parseChannelKind(channel).kind === 'presence'
      ? createNodeSocketRef(scaling.nodeId, socketId)
      : socketId
  }

  function setPresenceState(
    key: string,
    socketMembers: Map<string, PresenceMember>,
  ): Map<string, PresenceMember> {
    if (socketMembers.size === 0) {
      presenceMembers.delete(key)
      presenceSockets.delete(key)
      return new Map()
    }

    const roster = new Map<string, PresenceMember>()
    const memberSockets = new Map<string, string>()
    for (const [socketRef, member] of socketMembers) {
      const memberId = resolvePresenceMemberId(member, socketRef)
      memberSockets.set(socketRef, memberId)
      if (!roster.has(memberId)) {
        roster.set(memberId, member)
      }
    }

    presenceMembers.set(key, roster)
    presenceSockets.set(key, memberSockets)
    return roster
  }

  function getPresenceRosterPayload(key: string): {
    readonly ids: readonly string[]
    readonly hash: Readonly<Record<string, PresenceMember>>
    readonly count: number
  } {
    const roster = presenceMembers.get(key) ?? new Map<string, PresenceMember>()
    const ids = Object.freeze([...roster.keys()])
    return Object.freeze({
      ids,
      hash: Object.freeze(Object.fromEntries(roster.entries())),
      count: ids.length,
    })
  }

  async function removePresenceMemberFromScaling(app: BroadcastWorkerApp, socketId: string, channel: string): Promise<void> {
    if (!scaling) {
      return
    }

    const { kind } = parseChannelKind(channel)
    if (kind !== 'presence') {
      return
    }

    await scaling.adapter.hashDelete(
      resolvePresenceHashKey(scaling.connection, app.appId, channel),
      createNodeSocketRef(scaling.nodeId, socketId),
    )
  }

  function removeSubscriptionLocal(
    appId: string,
    socketId: string,
    channel: string,
  ): { readonly member?: PresenceMember, readonly removed: boolean } {
    const key = composeSubscriptionKey(appId, channel)
    const sockets = channels.get(key)
    if (sockets) {
      sockets.delete(socketId)
      if (sockets.size === 0) {
        channels.delete(key)
      }
    }

    let removedPresenceMember: PresenceMember | undefined
    let removed = false
    const roster = presenceMembers.get(key)
    const memberSockets = presenceSockets.get(key)
    if (roster && memberSockets) {
      const presenceSocketRef = createPresenceSocketRef(channel, socketId)
      const memberId = memberSockets.get(presenceSocketRef)
      if (memberId) {
        memberSockets.delete(presenceSocketRef)
        if (memberSockets.size === 0) {
          presenceSockets.delete(key)
        }

        if (![...memberSockets.values()].includes(memberId)) {
          removedPresenceMember = roster.get(memberId)
          removed = typeof removedPresenceMember !== 'undefined'
          roster.delete(memberId)
          if (roster.size === 0) {
            presenceMembers.delete(key)
          }
        }
      }
    }

    const whispersBySocket = channelWhispers.get(key)
    if (whispersBySocket) {
      whispersBySocket.delete(socketId)
      if (whispersBySocket.size === 0) {
        channelWhispers.delete(key)
      }
    }

    return Object.freeze({
      ...(typeof removedPresenceMember === 'undefined' ? {} : { member: removedPresenceMember }),
      removed,
    })
  }

  async function synchronizePresenceChannel(
    app: BroadcastWorkerApp,
    channel: string,
    member: PresenceMember,
    socketId: string,
  ): Promise<{ readonly roster: Map<string, PresenceMember>, readonly isNewMember: boolean }> {
    const key = composeSubscriptionKey(app.appId, channel)
    const socketRef = createPresenceSocketRef(channel, socketId)
    const memberId = resolvePresenceMemberId(member, socketRef)
    if (!scaling) {
      const roster = presenceMembers.get(key) ?? new Map<string, PresenceMember>()
      const memberSockets = presenceSockets.get(key) ?? new Map<string, string>()
      const isNewMember = !roster.has(memberId)

      memberSockets.set(socketRef, memberId)
      roster.set(memberId, member)

      presenceSockets.set(key, memberSockets)
      presenceMembers.set(key, roster)

      return Object.freeze({
        roster,
        isNewMember,
      })
    }

    const presenceKey = resolvePresenceHashKey(scaling.connection, app.appId, channel)
    await scaling.adapter.hashSet(
      presenceKey,
      socketRef,
      JSON.stringify(member),
    )
    const merged = parsePresenceHashMembers(await scaling.adapter.hashGetAll(presenceKey))
    const hasExistingMember = [...merged.entries()].some(([existingSocketRef, existingMember]) => {
      return existingSocketRef !== socketRef
        && resolvePresenceMemberId(existingMember, existingSocketRef) === memberId
    })
    const roster = setPresenceState(key, merged)
    return Object.freeze({
      roster,
      isNewMember: !hasExistingMember,
    })
  }

  function deliverEventLocal(appId: string, channel: string, event: string, data: string, excludeSocketId?: string): PublishDelivery {
    const sockets = channels.get(composeSubscriptionKey(appId, channel))
    if (!sockets || sockets.size === 0) {
      return Object.freeze({
        deliveredChannels: Object.freeze([]),
        deliveredSockets: 0,
      })
    }

    let deliveredSockets = 0
    for (const socketId of sockets) {
      if (socketId === excludeSocketId) {
        continue
      }

      const socket = connectedSockets.get(socketId)
      /* v8 ignore next 3 -- stale socket ids can only occur from external transport races; runtime APIs always clean channel membership on disconnect. */
      if (!socket) {
        continue
      }

      socket.send(pusherEvent(event, data, channel))
      deliveredSockets += 1
    }

    return Object.freeze({
      deliveredChannels: Object.freeze([channel]),
      deliveredSockets,
    })
  }

  function deliverPresenceMemberAddedLocal(
    appId: string,
    channel: string,
    member: PresenceMember,
    excludeSocketId?: string,
  ): void {
    deliverEventLocal(
      appId,
      channel,
      'pusher_internal:member_added',
      JSON.stringify(member),
      excludeSocketId,
    )
  }

  function deliverPresenceMemberRemovedLocal(
    appId: string,
    channel: string,
    member: PresenceMember,
    excludeSocketId?: string,
    fallbackSocketId?: string,
  ): void {
    deliverEventLocal(
      appId,
      channel,
      'pusher_internal:member_removed',
      serializePresenceMemberRemoved(member, (fallbackSocketId ?? excludeSocketId)!),
      excludeSocketId,
    )
  }

  async function publishScalingEvent(body: ResolvedPublishBody): Promise<void> {
    if (!scaling) {
      return
    }

    await scaling.adapter.publish(scaling.eventChannel, JSON.stringify({
      type: 'event',
      originNodeId: scaling.nodeId,
      appId: body.appId,
      name: body.name,
      channels: body.channels,
      data: body.data,
      ...(typeof body.socket_id === 'undefined' ? {} : { socketId: body.socket_id }),
    } satisfies BroadcastScalingEventMessage))
  }

  async function publishScalingPresenceMemberAdded(
    app: BroadcastWorkerApp,
    channel: string,
    socketId: string,
    member: PresenceMember,
  ): Promise<void> {
    if (!scaling) {
      return
    }

    await scaling.adapter.publish(scaling.eventChannel, JSON.stringify({
      type: 'presence-member-added',
      originNodeId: scaling.nodeId,
      appId: app.appId,
      channel,
      socketId,
      member,
    } satisfies BroadcastScalingPresenceMemberAddedMessage))
  }

  async function publishScalingPresenceMemberRemoved(
    app: BroadcastWorkerApp,
    channel: string,
    socketId: string,
    member: PresenceMember,
  ): Promise<void> {
    if (!scaling) {
      return
    }

    await scaling.adapter.publish(scaling.eventChannel, JSON.stringify({
      type: 'presence-member-removed',
      originNodeId: scaling.nodeId,
      appId: app.appId,
      channel,
      socketId,
      member,
    } satisfies BroadcastScalingPresenceMemberRemovedMessage))
  }

  async function handleScalingMessage(payload: string): Promise<void> {
    const message = parseJsonObject(payload, 'Scaling event payload') as Partial<BroadcastScalingMessage>
    if (message.originNodeId === scaling?.nodeId) {
      return
    }

    if (message.type === 'event') {
      if (typeof message.name !== 'string' || !Array.isArray(message.channels) || typeof message.data !== 'string' || typeof message.appId !== 'string') {
        return
      }

      for (const channel of message.channels) {
        if (typeof channel !== 'string') {
          continue
        }
        deliverEventLocal(
          message.appId,
          channel,
          message.name,
          message.data,
        )
      }
      return
    }

    if (
      message.type === 'presence-member-added'
      && typeof message.originNodeId === 'string'
      && typeof message.appId === 'string'
      && typeof message.channel === 'string'
      && typeof message.socketId === 'string'
    ) {
      const key = composeSubscriptionKey(message.appId, message.channel)
      const roster = presenceMembers.get(key) ?? new Map<string, PresenceMember>()
      const memberSockets = presenceSockets.get(key) ?? new Map<string, string>()
      const member = normalizePresenceMemberMessage(message.member, 'Scaling presence member')
      const socketRef = createNodeSocketRef(message.originNodeId, message.socketId)
      const memberId = resolvePresenceMemberId(member, socketRef)
      const isNewMember = !roster.has(memberId)

      memberSockets.set(socketRef, memberId)
      roster.set(memberId, member)
      presenceSockets.set(key, memberSockets)
      presenceMembers.set(key, roster)

      if (isNewMember) {
        deliverPresenceMemberAddedLocal(message.appId, message.channel, member)
      }
      return
    }

    if (
      message.type === 'presence-member-removed'
      && typeof message.originNodeId === 'string'
      && typeof message.appId === 'string'
      && typeof message.channel === 'string'
      && typeof message.socketId === 'string'
    ) {
      const member = normalizePresenceMemberMessage(message.member, 'Scaling presence member')
      const key = composeSubscriptionKey(message.appId, message.channel)
      const roster = presenceMembers.get(key)
      const memberSockets = presenceSockets.get(key)
      const socketRef = createNodeSocketRef(message.originNodeId, message.socketId)
      const memberId = memberSockets?.get(socketRef) ?? resolvePresenceMemberId(member, socketRef)
      if (memberSockets) {
        memberSockets.delete(socketRef)
        if (memberSockets.size === 0) {
          presenceSockets.delete(key)
        }
      }
      if (roster && !memberSockets?.has(socketRef)) {
        if (!(memberSockets && [...memberSockets.values()].includes(memberId))) {
          roster.delete(memberId)
          if (roster.size === 0) {
            presenceMembers.delete(key)
          }
          deliverPresenceMemberRemovedLocal(
            message.appId,
            message.channel,
            member,
            undefined,
            memberId,
          )
        }
      }
    }
  }

  async function handleSubscribe(socket: SocketState, rawChannel: string): Promise<void> {
    const channel = normalizeRequiredString(rawChannel, 'Subscription channel')
    const authorization = await authenticateSubscription(socket.app, socket, channel, options.channelAuth, options.fetch)
    if (!socket.active || connectedSockets.get(socket.socketId) !== socket) {
      return
    }

    socket.subscribedChannels.add(channel)
    const key = composeSubscriptionKey(socket.app.appId, channel)
    channels.set(key, new Set([...(channels.get(key) ?? []), socket.socketId]))

    if (authorization.whispers.length > 0) {
      const whispersBySocket = channelWhispers.get(key) ?? new Map<string, Set<string>>()
      whispersBySocket.set(socket.socketId, new Set(authorization.whispers))
      channelWhispers.set(key, whispersBySocket)
    } else {
      const whispersBySocket = channelWhispers.get(key)
      whispersBySocket?.delete(socket.socketId)
      if (whispersBySocket && whispersBySocket.size === 0) {
        channelWhispers.delete(key)
      }
    }

    const { kind } = parseChannelKind(channel)
    if (kind === 'presence') {
      const member = authorization.member ?? Object.freeze({ id: socket.socketId })
      const synchronized = await synchronizePresenceChannel(
        socket.app,
        channel,
        member,
        socket.socketId,
      )
      if (synchronized.isNewMember) {
        deliverPresenceMemberAddedLocal(socket.app.appId, channel, member, socket.socketId)
        await publishScalingPresenceMemberAdded(socket.app, channel, socket.socketId, member)
      }
      const presence = getPresenceRosterPayload(key)
      socket.send(pusherEvent('pusher_internal:subscription_succeeded', {
        presence,
      }, channel))
      return
    }

    socket.send(pusherEvent('pusher_internal:subscription_succeeded', {}, channel))
  }

  async function handleUnsubscribe(socket: SocketState, rawChannel: string): Promise<void> {
    const channel = normalizeRequiredString(rawChannel, 'Unsubscribe channel')
    socket.subscribedChannels.delete(channel)
    const removedPresenceMember = removeSubscriptionLocal(socket.app.appId, socket.socketId, channel)
    if (removedPresenceMember.removed && removedPresenceMember.member) {
      deliverPresenceMemberRemovedLocal(socket.app.appId, channel, removedPresenceMember.member, socket.socketId)
    }
    await removePresenceMemberFromScaling(socket.app, socket.socketId, channel)
    if (removedPresenceMember.removed && removedPresenceMember.member) {
      await publishScalingPresenceMemberRemoved(socket.app, channel, socket.socketId, removedPresenceMember.member)
    }
    socket.send(pusherEvent('pusher_internal:unsubscribed', {}, channel))
  }

  async function handleClientEvent(socket: SocketState, message: { readonly event: string, readonly channel?: string, readonly data: Record<string, unknown> }): Promise<void> {
    const channel = normalizeRequiredString(message.channel ?? '', 'Whisper channel')
    if (!socket.subscribedChannels.has(channel)) {
      throw new Error(`[@holo-js/broadcast] Socket is not subscribed to "${channel}".`)
    }

    const { kind, canonical } = parseChannelKind(channel)
    if (kind === 'public') {
      throw new Error('[@holo-js/broadcast] Client events are only allowed on private or presence channels.')
    }

    const whisperName = message.event.replace(/^client-/, '')
    const allowedWhispers = channelWhispers
      .get(composeSubscriptionKey(socket.app.appId, channel))
      ?.get(socket.socketId)
    if (!allowedWhispers || !allowedWhispers.has(whisperName)) {
      throw new Error(`[@holo-js/broadcast] Whisper "${whisperName}" is not allowed for "${channel}".`)
    }

    if (options.channelAuth) {
      await validateBroadcastWhisperPayload(canonical, whisperName, message.data as BroadcastJsonObject, options.channelAuth)
    }
    const payload = Object.freeze({
      name: message.event,
      channels: Object.freeze([channel]),
      data: JSON.stringify(message.data),
      appId: socket.app.appId,
      socket_id: socket.socketId,
    })
    await publishToChannels(payload, {
      fromScaling: false,
      shouldReplicate: true,
    })
  }

  async function publishToChannels(
    body: ResolvedPublishBody,
    options: {
      readonly fromScaling: boolean
      readonly shouldReplicate: boolean
    } = {
      fromScaling: false,
      shouldReplicate: true,
    },
  ): Promise<PublishDelivery> {
    let deliveredSockets = 0
    const deliveredChannels: string[] = []

    for (const channel of body.channels) {
      const result = deliverEventLocal(body.appId, channel, body.name, body.data, body.socket_id)
      if (result.deliveredSockets > 0) {
        deliveredChannels.push(channel)
      }
      deliveredSockets += result.deliveredSockets
    }

    if (!options.fromScaling && options.shouldReplicate) {
      await publishScalingEvent(body)
    }

    return Object.freeze({
      deliveredChannels: Object.freeze(deliveredChannels),
      deliveredSockets,
    })
  }

  async function handlePublishRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const match = url.pathname.match(/\/apps\/([^/]+)\/events$/)
    /* v8 ignore next -- fetch routing invokes this handler only for the same regex pattern, so group 1 is guaranteed. */
    const appId = normalizeRequiredString(match?.[1] ?? '', 'Publish appId')
    const app = Object.values(appsByKey).find(candidate => candidate.appId === appId)
    if (!app) {
      return new Response('App not found', { status: 404 })
    }

    const bodyText = await request.text()
    const bodyMd5 = createHash('md5').update(bodyText).digest('hex')
    if (url.searchParams.get('body_md5') !== bodyMd5) {
      return new Response('Invalid body signature', { status: 401 })
    }

    let authKey: string
    try {
      authKey = normalizeRequiredString(url.searchParams.get('auth_key') ?? '', 'Publish auth_key')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid credentials'
      return new Response(message, { status: 401 })
    }
    if (authKey !== app.key) {
      return new Response('Invalid credentials', { status: 401 })
    }

    let authTimestamp: number
    try {
      authTimestamp = Number.parseInt(
        normalizeRequiredString(url.searchParams.get('auth_timestamp') ?? '', 'Publish auth_timestamp'),
        10,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid auth timestamp'
      return new Response(message, { status: 401 })
    }
    /* v8 ignore next 3 -- defensive guard; parseInt with radix 10 on a non-empty string always returns an integer or NaN */
    if (!Number.isInteger(authTimestamp)) {
      return new Response('Invalid auth timestamp', { status: 401 })
    }

    const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000)
    if (Math.abs(nowSeconds - authTimestamp) > MAX_PUBLISH_TIMESTAMP_SKEW_SECONDS) {
      return new Response('Publish auth timestamp is stale', { status: 401 })
    }

    let providedSignature: string
    let expectedSignature: string
    try {
      providedSignature = normalizeRequiredString(url.searchParams.get('auth_signature') ?? '', 'Publish auth_signature')
      expectedSignature = createPusherSignature(
        app.secret,
        request.method,
        url.pathname,
        url.searchParams,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid auth signature'
      return new Response(message, { status: 401 })
    }

    if (providedSignature !== expectedSignature) {
      return new Response('Invalid auth signature', { status: 401 })
    }

    let publishBody: PublishBody
    try {
      publishBody = normalizePublishBody(parseJsonObject(bodyText, 'Publish body'))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid publish payload'
      return new Response(message, { status: 400 })
    }
    let result: PublishDelivery
    try {
      result = await publishToChannels({
        ...publishBody,
        appId: app.appId,
      }, {
        fromScaling: false,
        shouldReplicate: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Broadcast publish failed.'
      return new Response(message, { status: 500 })
    }
    return new Response(JSON.stringify({
      ok: true,
      deliveredChannels: result.deliveredChannels,
      deliveredSockets: result.deliveredSockets,
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    })
  }

  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (request.method.toUpperCase() === 'GET' && url.pathname === options.config.worker.healthPath) {
        return new Response(JSON.stringify({
          ok: true,
        }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
        })
      }

      if (request.method.toUpperCase() === 'GET' && url.pathname === options.config.worker.statsPath) {
        return new Response(JSON.stringify({
          ...this.getStats(),
        }), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
          },
        })
      }

      if (request.method.toUpperCase() === 'POST' && /\/apps\/[^/]+\/events$/.test(url.pathname)) {
        return await handlePublishRequest(request)
      }

      return new Response('Not Found', { status: 404 })
    },
    connectWebSocket(connection: WorkerWebSocketConnection): void {
      connectedSockets.set(connection.socketId, {
        socketId: connection.socketId,
        app: connection.app,
        headers: connection.headers,
        send: connection.send,
        close: connection.close,
        subscribedChannels: new Set(),
        active: true,
        pendingMessage: Promise.resolve(),
      })

      connection.send(pusherEvent('pusher:connection_established', {
        socket_id: connection.socketId,
        activity_timeout: 120,
      }))
    },
    async receiveWebSocketMessage(socketId: string, rawMessage: string): Promise<void> {
      const socket = connectedSockets.get(socketId)
      if (!socket) {
        return
      }

      const task = socket.pendingMessage.then(async () => {
        if (!socket.active || connectedSockets.get(socketId) !== socket) {
          return
        }

        const message = parseSocketMessage(rawMessage)
        if (message.event === 'pusher:ping') {
          socket.send(pusherEvent('pusher:pong', {}))
          return
        }

        if (message.event === 'pusher:subscribe') {
          await handleSubscribe(socket, String(message.data.channel ?? ''))
          return
        }

        if (message.event === 'pusher:unsubscribe') {
          await handleUnsubscribe(socket, String(message.data.channel ?? ''))
          return
        }

        if (message.event.startsWith('client-')) {
          await handleClientEvent(socket, message)
        }
      })
      socket.pendingMessage = task.catch(() => {})
      await task
    },
    async receiveScalingMessage(payload: string): Promise<void> {
      await handleScalingMessage(payload)
    },
    disconnectWebSocket(socketId: string): void {
      const socket = connectedSockets.get(socketId)
      if (!socket) {
        return
      }

      socket.active = false
      connectedSockets.delete(socketId)
      const channelsToCleanup = [...socket.subscribedChannels]
      const scalingCleanupTasks = channelsToCleanup.map((channel) => {
        const removedPresenceMember = removeSubscriptionLocal(socket.app.appId, socket.socketId, channel)
        if (removedPresenceMember.removed && removedPresenceMember.member) {
          deliverPresenceMemberRemovedLocal(socket.app.appId, channel, removedPresenceMember.member, socket.socketId)
        }

        return async () => {
          if (removedPresenceMember.removed && removedPresenceMember.member) {
            await publishScalingPresenceMemberRemoved(socket.app, channel, socket.socketId, removedPresenceMember.member).catch((error) => {
              logSocketCleanupError(socket.socketId, channel, error)
            })
          }
          await removePresenceMemberFromScaling(socket.app, socket.socketId, channel).catch((error) => {
            logSocketCleanupError(socket.socketId, channel, error)
          })
        }
      })
      socket.subscribedChannels.clear()
      const cleanupTask = socket.pendingMessage.then(async () => {
        await Promise.all(scalingCleanupTasks.map(async (task) => {
          await task()
        }))
      }).catch((error) => {
        logSocketMessageError(socket.socketId, error)
      })
      socket.pendingMessage = cleanupTask.catch(() => {})
    },
    getStats(): BroadcastWorkerStats {
      return Object.freeze({
        nodeId: scaling?.nodeId ?? 'standalone',
        uptimeMs: (options.now?.() ?? Date.now()) - startedAt,
        apps: Object.freeze(Object.values(appsByKey).map(app => app.connection)),
        appScopes: Object.freeze(Object.values(appsByKey).map(app => Object.freeze({
          connection: app.connection,
          appId: app.appId,
          key: app.key,
        }))),
        connectionCount: connectedSockets.size,
        subscribedChannelCount: channels.size,
        presenceChannelCount: presenceMembers.size,
        scaling: scaling
          ? Object.freeze({
              driver: 'redis' as const,
              connection: scaling.connection,
              eventChannel: scaling.eventChannel,
            })
          : false,
      })
    },
    async close(): Promise<void> {
      const unsubscribe = await scalingUnsubscribe
      await unsubscribe()
      if (scaling) {
        await scaling.adapter.close()
      }
    },
  })
}

/* v8 ignore start -- Node HTTP adapter helpers; exercised by real HTTP requests but array/undefined header branches are defensive */
function toNodeHeaders(headers: IncomingMessage['headers']): Headers {
  const normalized = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        normalized.append(key, item)
      }
      continue
    }

    normalized.set(key, value)
  }

  return normalized
}

function toNodeRequestUrl(request: IncomingMessage, fallbackHost: string): string {
  const path = request.url ?? '/'
  const host = request.headers.host ?? fallbackHost
  return `http://${host}${path}`
}

async function readNodeRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined
  }

  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return undefined
  }

  return Buffer.concat(chunks)
}

async function writeNodeResponse(response: ServerResponse, value: Response): Promise<void> {
  response.statusCode = value.status
  response.statusMessage = value.statusText
  value.headers.forEach((headerValue, headerName) => {
    response.setHeader(headerName, headerValue)
  })
  const body = await value.arrayBuffer()
  response.end(Buffer.from(body))
}
/* v8 ignore stop */

/* v8 ignore start -- Node websocket adapter glue; requires real ws package for integration testing */
function decodeNodeWebSocketMessage(message: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer): string {
  if (typeof message === 'string') {
    return message
  }
  if (message instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(message))
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message).toString('utf8')
  }
  if (message instanceof Uint8Array) {
    return Buffer.from(message).toString('utf8')
  }
  return String(message)
}
/* v8 ignore stop */

export async function startBroadcastWorker(
  runtimeBindings: Pick<BroadcastRuntimeBindings, 'config' | 'channelAuth'> & {
    readonly queue?: NormalizedHoloQueueConfig
    readonly nodeId?: string
    readonly fetch?: typeof fetch
    readonly createScalingAdapter?: (connection: BroadcastRedisScalingConnection) => Promise<BroadcastScalingAdapter>
    readonly loadRedisModule?: () => Promise<unknown>
    readonly loadWebSocketModule?: () => Promise<unknown>
  },
): Promise<StartedBroadcastWorker> {
  const config = runtimeBindings.config
  if (!config) {
    throw new Error('[@holo-js/broadcast] Broadcast worker requires a loaded broadcast config.')
  }

  const scalingConfig = config.worker.scaling
    ? Object.freeze({
        driver: 'redis' as const,
        connection: config.worker.scaling.connection,
        nodeId: runtimeBindings.nodeId ?? createScalingNodeId(),
        eventChannel: resolveScalingEventChannel(config.worker.scaling.connection),
        adapter: await (runtimeBindings.createScalingAdapter
          ? runtimeBindings.createScalingAdapter(
            resolveRedisScalingConnection(runtimeBindings.queue, config.worker.scaling.connection),
          )
          : createRedisScalingAdapter(
            resolveRedisScalingConnection(runtimeBindings.queue, config.worker.scaling.connection),
            { loadRedisModule: runtimeBindings.loadRedisModule },
          )),
      })
    : undefined

  let scalingUnsubscribe: (() => Promise<void> | void) | undefined
  const runtime = createBroadcastWorkerRuntime({
    config,
    channelAuth: runtimeBindings.channelAuth,
    fetch: runtimeBindings.fetch ?? fetch,
    scaling: scalingConfig,
    scalingAutoSubscribe: false,
    scalingUnsubscribe: async () => {
      await scalingUnsubscribe?.()
    },
  })
  if (scalingConfig) {
    scalingUnsubscribe = await scalingConfig.adapter.subscribe(scalingConfig.eventChannel, (payload) => {
      void runtime.receiveScalingMessage(payload).catch((error) => {
        logScalingMessageError(error)
      })
    })
  }
  const bun = (globalThis as { Bun?: BroadcastWorkerBunGlobal }).Bun
  const appsByKey = buildWorkerApps(config)
  const pathPrefix = config.worker.path.replace(/\/$/, '')
  const appPathRegex = new RegExp(`^${escapeRegExp(pathPrefix)}/([^/]+)$`)
  if (bun?.serve) {
    const server = bun.serve({
      hostname: config.worker.host,
      port: config.worker.port,
      async fetch(request, wsServer) {
        const url = new URL(request.url)
        const appMatch = url.pathname.match(appPathRegex)
        if (appMatch) {
          const key = appMatch[1]!
          const app = appsByKey[key]
          if (!app) {
            return new Response('Unknown app key', { status: 401 })
          }

          const upgraded = wsServer.upgrade(request, {
            data: {
              socketId: createSocketId(),
              app,
              headers: request.headers,
            } satisfies WorkerConnectionInfo,
          })
          if (upgraded) {
            return new Response(null, { status: 200 })
          }
        }

        return await runtime.fetch(request)
      },
      websocket: {
        open(socket) {
          runtime.connectWebSocket({
            ...socket.data,
            send(payload) {
              socket.send(payload)
            },
            /* v8 ignore next 3 -- Bun websocket close callback forwarding is adapter glue; close is driven by Bun, not by unit tests. */
            close(code, reason) {
              socket.close(code, reason)
            },
          })
        },
        message(socket, message) {
          const value = typeof message === 'string'
            ? message
            : new TextDecoder().decode(message)
          void runtime.receiveWebSocketMessage(socket.data.socketId, value).catch((error) => {
            logSocketMessageError(socket.data.socketId, error)
            runtime.disconnectWebSocket(socket.data.socketId)
            socket.close(4001, 'Protocol error')
          })
        },
        close(socket) {
          runtime.disconnectWebSocket(socket.data.socketId)
        },
      },
    })

    return Object.freeze({
      host: config.worker.host,
      port: config.worker.port,
      async stop() {
        server.stop(true)
        await runtime.close()
      },
    })
  }

  let nodeWsModule: unknown
  try {
    nodeWsModule = await (runtimeBindings.loadWebSocketModule
      ? runtimeBindings.loadWebSocketModule()
      /* v8 ignore next -- default ws import; tests always provide loadWebSocketModule */
      : import('ws'))
  } catch (error) {
    await runtime.close()
    const details = error instanceof Error ? error.message : String(error)
    throw new Error(`[@holo-js/broadcast] Node runtime requires the "ws" package for broadcast:work. ${details}`)
  }
  const WebSocketServer = (nodeWsModule as NodeWebSocketModuleLike).WebSocketServer
  if (typeof WebSocketServer !== 'function') {
    await runtime.close()
    throw new Error('[@holo-js/broadcast] Node runtime websocket module is missing WebSocketServer export.')
  }

  const requestConnectionInfo = new WeakMap<IncomingMessage, WorkerConnectionInfo>()
  const wsServer = new WebSocketServer({ noServer: true })
  /* v8 ignore start -- Node websocket connection handler is adapter glue; exercised by real ws integration tests */
  wsServer.on('connection', (socket, request) => {
    const connectionInfo = requestConnectionInfo.get(request)!

    const socketId = connectionInfo.socketId
    runtime.connectWebSocket({
      ...connectionInfo,
      send(payload) {
        socket.send(payload)
      },
      close(code, reason) {
        socket.close(code, reason)
      },
    })
    socket.on('message', (message) => {
      const value = decodeNodeWebSocketMessage(message)
      void runtime.receiveWebSocketMessage(socketId, value).catch((error) => {
        logSocketMessageError(socketId, error)
        runtime.disconnectWebSocket(socketId)
        socket.close(4001, 'Protocol error')
      })
    })
    socket.on('close', () => {
      runtime.disconnectWebSocket(socketId)
    })
  })
  /* v8 ignore stop */

  const httpServer = createServer(async (request, response) => {
    const requestUrl = toNodeRequestUrl(request, `${config.worker.host}:${config.worker.port}`)
    const requestBody = await readNodeRequestBody(request)
    const runtimeRequest = new Request(requestUrl, {
      method: request.method,
      headers: toNodeHeaders(request.headers),
      ...(typeof requestBody === 'undefined' ? {} : { body: requestBody }),
    })
    const runtimeResponse = await runtime.fetch(runtimeRequest)
    await writeNodeResponse(response, runtimeResponse)
  })
  /* v8 ignore start -- Node websocket upgrade handler is adapter glue; requires real ws package for integration testing */
  httpServer.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(toNodeRequestUrl(request, `${config.worker.host}:${config.worker.port}`))
    const appMatch = requestUrl.pathname.match(appPathRegex)
    if (!appMatch) {
      socket.destroy()
      return
    }

    const app = appsByKey[appMatch[1]!]
    if (!app) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    requestConnectionInfo.set(request, {
      socketId: createSocketId(),
      app,
      headers: toNodeHeaders(request.headers),
    })
    wsServer.handleUpgrade(request, socket, head, (client, upgradedRequest) => {
      wsServer.emit('connection', client, upgradedRequest)
    })
  })
  /* v8 ignore stop */
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      httpServer.once('error', rejectPromise)
      httpServer.listen(config.worker.port, config.worker.host, () => {
        httpServer.off('error', rejectPromise)
        resolvePromise()
      })
    })
  } catch (error) {
    wsServer.close()
    await runtime.close()
    throw error
  }

  const address = httpServer.address()
  /* v8 ignore next -- defensive fallback when httpServer.address() returns a string or null */
  const port = typeof address === 'object' && address ? address.port : config.worker.port
  return Object.freeze({
    host: config.worker.host,
    port,
    async stop() {
      await new Promise<void>((resolvePromise) => {
        wsServer.close(() => {
          resolvePromise()
        })
      })
      ;(httpServer as { closeIdleConnections?: () => void }).closeIdleConnections?.()
      ;(httpServer as { closeAllConnections?: () => void }).closeAllConnections?.()
      await new Promise<void>((resolvePromise, rejectPromise) => {
        httpServer.close((error) => {
          if (error) {
            rejectPromise(error)
            return
          }
          resolvePromise()
        })
      })
      await runtime.close()
    },
  })
}

export const workerInternals = {
  buildWorkerApps,
  createScalingNodeId,
  createRedisScalingAdapter,
  createPusherSignature,
  createSocketId,
  resolveRedisScalingConnection,
  resolveScalingEventChannel,
  normalizePublishBody,
  parseChannelKind,
  parsePresenceHashMembers,
  parseSocketMessage,
}
