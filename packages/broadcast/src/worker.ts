import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  requireBroadcastCredentials,
  type NormalizedBroadcastWorkerScalingConfig,
  type NormalizedHoloBroadcastConfig,
} from './config'
import type { NormalizedHoloRedisConfig } from '@holo-js/kernel'
import { captureErrorReporter, type HoloErrorReporter } from '@holo-js/kernel/error-reporting'
import type { NormalizedHoloQueueConfig, NormalizedQueueRedisConnectionConfig } from '@holo-js/queue'
import {
  authorizeBroadcastChannel,
  resolveBroadcastChannelGuard,
  validateBroadcastWhisperPayload,
} from './auth'
import type {
  BroadcastChannelAuthRuntimeBindings,
  BroadcastJsonObject,
  BroadcastRealtimeRuntimeBindings,
  BroadcastRealtimeSubscription,
  BroadcastRuntimeBindings,
} from './contracts'
import { isObjectRecord, isPlainObject, parseJsonObject } from './json'
import {
  createWorkerPusherSignature as createPusherSignature,
  normalizeWorkerPublishBody as normalizePublishBody,
  normalizeWorkerRequiredString as normalizeRequiredString,
  parseWorkerChannelKind as parseChannelKind,
  parseWorkerSocketMessage as parseSocketMessage,
  type WorkerPublishBody as PublishBody,
  verifyWorkerPusherSignature as verifyPusherSignature,
} from './workerProtocol'
import {
  BroadcastPayloadTooLargeError,
  decodeNodeWebSocketMessage,
  getNodeWebSocketMessageBytes,
  readLimitedRequestText,
  readNodeRequestBody,
  toNodeHeaders,
  toNodeRequestUrl,
  writeNodeRequestBodyError,
  writeNodeResponse,
} from './workerNodeTransport'

type WorkerConnectionInfo = {
  readonly socketId: string
  readonly app: BroadcastWorkerApp
  readonly headers: Headers
}

type WorkerWebSocketConnection = WorkerConnectionInfo & {
  readonly send: (payload: string) => void
  readonly close: (code?: number, reason?: string) => void
  readonly bufferedAmount: () => number
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

type ClientChannelAuth = {
  readonly auth: string
  readonly channelData?: string
}

type SocketState = {
  readonly socketId: string
  readonly app: BroadcastWorkerApp
  readonly headers: Headers
  readonly send: (payload: string) => boolean
  readonly close: (code?: number, reason?: string) => void
  readonly subscribedChannels: Set<string>
  readonly realtimeSubscriptions: Map<string, BroadcastRealtimeSubscription>
  readonly realtimeSubscriptionTokens: Map<string, object>
  readonly presenceCleanupPending: Set<string>
  messageWindowStartedAt: number
  messagesInWindow: number
  active: boolean
  pendingMessage: Promise<void>
}

type WorkerRuntimeOptions = {
  readonly config: NormalizedHoloBroadcastConfig
  readonly channelAuth?: BroadcastChannelAuthRuntimeBindings
  readonly realtime?: BroadcastRealtimeRuntimeBindings
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

function rejectSocketConnection(socket: { close(code?: number, reason?: string): void }, error: unknown, report: HoloErrorReporter): void {
  report(error, { capability: 'broadcast', operation: 'worker.socketConnect' })
  socket.close(4200, 'Reconnect')
}

function createScalingMessageListener(
  runtime: Pick<BroadcastWorkerRuntime, 'receiveScalingMessage'>,
  report: HoloErrorReporter,
): (payload: string) => void {
  return (payload) => {
    void runtime.receiveScalingMessage(payload).catch((error) => {
      report(error, { capability: 'broadcast', operation: 'worker.scalingMessage' })
    })
  }
}

export interface StartedBroadcastWorker {
  readonly host: string
  readonly port: number
  readonly stop: () => Promise<void>
}

type BunWebSocketLike = {
  data: WorkerConnectionInfo
  send(value: string): void
  close(code?: number, reason?: string): void
  getBufferedAmount(): number
}

type BroadcastWorkerBunGlobal = {
  serve(options: {
    readonly hostname?: string
    readonly port?: number
    readonly fetch: (request: Request, server: { upgrade(request: Request, options?: { data?: unknown }): boolean }) => Promise<Response> | Response
    readonly websocket: {
      open: (socket: BunWebSocketLike) => void
      message: (socket: BunWebSocketLike, message: string | Uint8Array) => void
      close: (socket: BunWebSocketLike) => void
    }
  }): BunServerLike
}

type NodeWebSocketLike = {
  readonly bufferedAmount: number
  send(value: string): void
  ping(): void
  terminate(): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: string | Uint8Array | Buffer | readonly Buffer[] | ArrayBuffer) => void): unknown
  on(event: 'pong', listener: () => void): unknown
  on(event: 'close', listener: () => void): unknown
}

type NodeWebSocketServerLike = {
  readonly clients: Set<NodeWebSocketLike>
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
  WebSocketServer: new (options: { noServer: true, maxPayload: number }) => NodeWebSocketServerLike
}

function isOverBufferedBound(connection: { readonly bufferedAmount: () => number }): boolean {
  return connection.bufferedAmount() > MAX_BUFFERED_BYTES_PER_CONNECTION
}

function wouldExceedBufferedBound(connection: { readonly bufferedAmount: () => number }, payload: string): boolean {
  return connection.bufferedAmount() + Buffer.byteLength(payload) > MAX_BUFFERED_BYTES_PER_CONNECTION
}

function isAllowedWorkerOrigin(request: Request, allowedOrigins: readonly string[]): boolean {
  const origin = request.headers.get('origin')
  if (!origin) {
    return true
  }

  try {
    const normalized = new URL(origin).origin
    return allowedOrigins.includes('*') || allowedOrigins.includes(normalized)
  } catch {
    return false
  }
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

type BroadcastScalingDatabaseInvalidationMessage = {
  readonly type: 'database-invalidation'
  readonly originNodeId: string
  readonly appId: string
  readonly invalidation: unknown
}

function createScalingDatabaseInvalidationPayload(originNodeId: string, appId: string, invalidation: unknown): string {
  return JSON.stringify({
    type: 'database-invalidation',
    originNodeId,
    appId,
    invalidation,
  } satisfies BroadcastScalingDatabaseInvalidationMessage)
}

function resolveDefaultBroadcastAppId(config: NormalizedHoloBroadcastConfig): string | undefined {
  const connection = config.connections[config.default]
  if (!connection || connection.driver !== 'holo' || !('appId' in connection)) {
    return undefined
  }

  return connection.appId
}

function resolveBroadcastAppIds(config: NormalizedHoloBroadcastConfig): readonly string[] {
  return Object.values(config.connections).flatMap(connection => {
    if (connection.driver !== 'holo' || !('appId' in connection)) {
      return []
    }

    return [connection.appId]
  })
}

type BroadcastScalingMessage =
  | BroadcastScalingEventMessage
  | BroadcastScalingPresenceMemberAddedMessage
  | BroadcastScalingPresenceMemberRemovedMessage
  | BroadcastScalingDatabaseInvalidationMessage

type RealtimeSocketAction = 'query' | 'mutation' | 'subscribe' | 'unsubscribe'

type RealtimeSocketMessage = {
  readonly id: string
  readonly action: RealtimeSocketAction
  readonly name?: string
  readonly args: Record<string, unknown>
}

type RealtimeWireErrorKind = 'authorization' | 'transport' | 'runtime'

type RealtimeWireReplacePatchOperation = {
  readonly op: 'replace'
  readonly path: readonly (string | number)[]
  readonly value: unknown
}

type RealtimeWireMergePatchOperation = {
  readonly op: 'merge'
  readonly path: readonly (string | number)[]
  readonly fields: Readonly<Record<string, unknown>>
}

type RealtimeWireSplicePatchOperation = {
  readonly op: 'splice'
  readonly path: readonly (string | number)[]
  readonly index: number
  readonly deleteCount: number
  readonly values: readonly unknown[]
}

type RealtimeWireMovePatchOperation = {
  readonly op: 'move'
  readonly path: readonly (string | number)[]
  readonly from: number
  readonly to: number
}

type RealtimeWirePatchOperation =
  | RealtimeWireReplacePatchOperation
  | RealtimeWireMergePatchOperation
  | RealtimeWireSplicePatchOperation
  | RealtimeWireMovePatchOperation

type RealtimeWireSnapshotPatch = {
  readonly dependencies?: readonly string[]
  readonly operations: readonly RealtimeWirePatchOperation[]
  readonly version: number
}

type BroadcastRealtimeSubscribeOptions = Parameters<BroadcastRealtimeRuntimeBindings['subscribe']>[2] & {
  readonly onPatch?: (patch: RealtimeWireSnapshotPatch) => void | Promise<void>
}

type BroadcastPatchCapableRealtimeRuntimeBindings = Omit<BroadcastRealtimeRuntimeBindings, 'subscribe'> & {
  subscribe(
    name: string,
    args: Record<string, unknown>,
    options: BroadcastRealtimeSubscribeOptions,
  ): Promise<BroadcastRealtimeSubscription>
}

type BroadcastRedisScalingConnection = {
  readonly url?: string
  readonly clusters?: readonly {
    readonly url?: string
    readonly host: string
    readonly port: number
  }[]
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
  setWithExpiry(key: string, value: string, ttlMs: number): Promise<void>
  exists(key: string): Promise<boolean>
  close(): Promise<void>
}

type BroadcastScalingLiveness = {
  readonly leaseTtlMs: number
  readonly refreshIntervalMs: number
}

const MAX_PUBLISH_TIMESTAMP_SKEW_SECONDS = 300
const SUBSCRIPTION_ERROR_MESSAGE = 'Unable to authorize the channel subscription.'
const REALTIME_ERROR_MESSAGE = 'Realtime request failed.'
const PUBLISH_ERROR_MESSAGE = 'Broadcast publish failed.'
const REALTIME_SUBSCRIPTION_LIMIT_MESSAGE = 'Too many realtime subscriptions.'
const MAX_CHANNELS_PER_CONNECTION = 100
const MAX_REALTIME_SUBSCRIPTIONS_PER_CONNECTION = 100
const MAX_MESSAGES_PER_CONNECTION_PER_WINDOW = 200
const MESSAGE_RATE_WINDOW_MS = 1000
const MAX_BUFFERED_BYTES_PER_CONNECTION = 4 * 1024 * 1024
const SUBSCRIPTION_LIMIT_STATUS = 429
const POLICY_VIOLATION_CLOSE_CODE = 1008
const MESSAGE_RATE_EXCEEDED_REASON = 'Message rate limit exceeded'
const SLOW_CONSUMER_REASON = 'Slow consumer'
const ACTIVITY_TIMEOUT_SECONDS = 120
const HEARTBEATS_PER_ACTIVITY_TIMEOUT = 4
const HEARTBEAT_INTERVAL_MS = (ACTIVITY_TIMEOUT_SECONDS * 1000) / HEARTBEATS_PER_ACTIVITY_TIMEOUT
const DEFAULT_SCALING_LIVENESS: BroadcastScalingLiveness = Object.freeze({
  leaseTtlMs: 30_000,
  refreshIntervalMs: 10_000,
})

class BroadcastSubscriptionDeniedError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`[@holo-js/broadcast] Channel authorization was denied (${status}).`)
    this.name = 'BroadcastSubscriptionDeniedError'
    this.status = status
  }
}

type BroadcastWorkerScalingRuntime = {
  readonly driver: 'redis'
  readonly connection: string
  readonly nodeId: string
  readonly eventChannel: string
  readonly adapter: BroadcastScalingAdapter
  readonly liveness?: BroadcastScalingLiveness
}

type RedisScalingClientLike = {
  on(event: 'message', callback: (channel: string, payload: string) => void): unknown
  off(event: 'message', callback: (channel: string, payload: string) => void): unknown
  subscribe(channel: string): Promise<number>
  unsubscribe(channel: string): Promise<number>
  publish(channel: string, payload: string): Promise<number>
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>
  exists(key: string): Promise<number>
  hset(key: string, field: string, value: string): Promise<number>
  hdel(key: string, ...fields: string[]): Promise<number>
  hgetall(key: string): Promise<Record<string, string>>
  quit(): Promise<unknown>
  disconnect(): void
}

type RedisScalingModuleLike = {
  default: new (
    target: string | {
      host?: string
      port?: number
      path?: string
      username?: string
      password?: string
      db?: number
    },
    options?: {
      username?: string
      password?: string
      db?: number
    },
  ) => RedisScalingClientLike
  Cluster: new (
    startupNodes: readonly {
      readonly host: string
      readonly port: number
    }[],
    options?: {
      readonly redisOptions?: {
        readonly username?: string
        readonly password?: string
        readonly db?: number
      }
    },
  ) => RedisScalingClientLike
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeRealtimeAction(value: unknown): RealtimeSocketAction {
  if (value === 'query' || value === 'mutation' || value === 'subscribe' || value === 'unsubscribe') {
    return value
  }

  throw new Error('[@holo-js/broadcast] Realtime action is invalid.')
}

function normalizeRealtimeArgs(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    return {}
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectRecord(value)
}

function parseRealtimeSocketMessage(data: Record<string, unknown>): RealtimeSocketMessage {
  const id = normalizeRequiredString(String(data.id ?? ''), 'Realtime request id')
  const action = normalizeRealtimeAction(data.action)
  const name = typeof data.name === 'string'
    ? normalizeRequiredString(data.name, 'Realtime definition name')
    : undefined

  if (action !== 'unsubscribe' && !name) {
    throw new Error('[@holo-js/broadcast] Realtime definition name is required.')
  }

  return Object.freeze({
    id,
    action,
    ...(typeof name === 'undefined' ? {} : { name }),
    args: normalizeRealtimeArgs(data.args),
  })
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function signChannelAuth(secret: string, socketId: string, channel: string, channelData: string): string {
  const value = channelData ? `${socketId}:${channel}:${channelData}` : `${socketId}:${channel}`
  return createHmac('sha256', secret).update(value).digest('hex')
}

function parseClientChannelAuth(data: Record<string, unknown>): ClientChannelAuth | undefined {
  if (typeof data.auth !== 'string') {
    return undefined
  }

  return Object.freeze({
    auth: normalizeRequiredString(data.auth, 'Subscription auth'),
    ...(typeof data.channel_data === 'string' ? { channelData: data.channel_data } : {}),
  })
}

function parseSignedChannelData(value: string | undefined): { readonly whispers: readonly string[], readonly member?: PresenceMember } {
  if (!value) {
    return Object.freeze({
      whispers: Object.freeze([]),
    })
  }

  const data = parseJsonObject(value, 'Subscription channel data')
  const whispers = Array.isArray(data.whispers)
    ? Object.freeze(data.whispers.map(item => normalizeRequiredString(String(item), 'Auth whisper')))
    : Object.freeze([])
  const member = data.member && typeof data.member === 'object' && !Array.isArray(data.member)
    ? Object.freeze(data.member as PresenceMember)
    : undefined

  return Object.freeze({
    whispers,
    ...(typeof member === 'undefined' ? {} : { member }),
  })
}

function verifyClientChannelAuth(
  app: BroadcastWorkerApp,
  socketId: string,
  channel: string,
  clientAuth: ClientChannelAuth,
): { readonly whispers: readonly string[], readonly member?: PresenceMember } {
  const [key, signature] = clientAuth.auth.split(':', 2)
  if (key !== app.key || !signature) {
    throw new BroadcastSubscriptionDeniedError(403)
  }

  const expected = signChannelAuth(app.secret, socketId, channel, clientAuth.channelData ?? '')
  if (!safeEqual(signature, expected)) {
    throw new BroadcastSubscriptionDeniedError(403)
  }

  return parseSignedChannelData(clientAuth.channelData)
}

function unsubscribeRealtimeSubscription(subscription: BroadcastRealtimeSubscription, report: HoloErrorReporter): void {
  try {
    subscription.unsubscribe()
  } catch (error) {
    report(error, { capability: 'broadcast', operation: 'worker.realtimeSubscriptionCleanup' })
  }
}

function isRealtimeSubscriptionCurrent(socket: SocketState, id: string, token: object): boolean {
  return socket.active && socket.realtimeSubscriptionTokens.get(id) === token
}

function createSocketId(): string {
  return `${randomInt(1, 1_000_000_000)}.${randomInt(1, 1_000_000_000)}`
}

function createScalingNodeId(): string {
  return normalizeRequiredString(`${process.env.HOSTNAME ?? 'node'}-${randomUUID()}`, 'Broadcast worker node id')
}

let processScalingNodeId: string | undefined

function getProcessScalingNodeId(): string {
  processScalingNodeId ??= createScalingNodeId()
  return processScalingNodeId
}

// Node IDs are only unique per scaling connection: a node on another connection may reuse an explicit
// node ID, so local origins are scoped to the event channel Redis isolates the connection by.
const localScalingOriginCounts = new Map<string, number>()

function resolveLocalScalingOriginKey(eventChannel: string, nodeId: string): string {
  return `${eventChannel}\u0000${nodeId}`
}

function registerLocalScalingOrigin(eventChannel: string, nodeId: string): () => void {
  const key = resolveLocalScalingOriginKey(eventChannel, nodeId)
  localScalingOriginCounts.set(key, (localScalingOriginCounts.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }

    released = true
    const remaining = (localScalingOriginCounts.get(key) ?? 1) - 1
    if (remaining > 0) {
      localScalingOriginCounts.set(key, remaining)
      return
    }

    localScalingOriginCounts.delete(key)
  }
}

function isLocalScalingOrigin(eventChannel: string, originNodeId: string): boolean {
  return originNodeId === getProcessScalingNodeId()
    || localScalingOriginCounts.has(resolveLocalScalingOriginKey(eventChannel, originNodeId))
}

function resolveScalingEventChannel(connection: string): string {
  return `holo:broadcast:scaling:${connection}:events`
}

// A database invalidation is published once per app on each channel, because each app's remote workers
// accept only their own app's messages. Registrations for the same app and channel coalesce into one.
function resolveDatabaseInvalidationPublisherScope(eventChannel: string, appId: string): string {
  return `${eventChannel}\u0000${appId}`
}

function resolvePresenceHashKey(connection: string, appId: string, channel: string): string {
  return `holo:broadcast:scaling:${connection}:presence:${appId}:${channel}`
}

function resolveNodeLeaseKey(connection: string, nodeId: string): string {
  return `holo:broadcast:scaling:${connection}:nodes:${nodeId}`
}

function createNodeSocketRef(nodeId: string, socketId: string): string {
  return `${nodeId}:${socketId}`
}

function resolveSocketRefNodeId(socketRef: string): string {
  const separator = socketRef.lastIndexOf(':')
  return separator < 0 ? socketRef : socketRef.slice(0, separator)
}

function startNodeSocketHeartbeat(wsServer: NodeWebSocketServerLike): {
  readonly recordActivity: (socket: NodeWebSocketLike) => void
  readonly stop: () => void
} {
  const awaitingPong = new WeakSet<NodeWebSocketLike>()
  const timer = setInterval(() => {
    for (const client of wsServer.clients) {
      if (awaitingPong.has(client)) {
        client.terminate()
        continue
      }

      awaitingPong.add(client)
      client.ping()
    }
  }, HEARTBEAT_INTERVAL_MS)

  return Object.freeze({
    recordActivity(socket: NodeWebSocketLike) {
      awaitingPong.delete(socket)
    },
    stop() {
      clearInterval(timer)
    },
  })
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
  redisConfig?: NormalizedHoloRedisConfig,
): BroadcastRedisScalingConnection {
  const queueConnection = queueConfig?.connections[connectionName]
  if (queueConnection?.driver === 'redis') {
    const redisQueueConnection = queueConnection as NormalizedQueueRedisConnectionConfig
    return Object.freeze({
      ...(typeof redisQueueConnection.redis.url === 'undefined' ? {} : { url: redisQueueConnection.redis.url }),
      ...(typeof redisQueueConnection.redis.clusters === 'undefined' ? {} : { clusters: redisQueueConnection.redis.clusters }),
      host: redisQueueConnection.redis.host,
      port: redisQueueConnection.redis.port,
      username: redisQueueConnection.redis.username,
      password: redisQueueConnection.redis.password,
      db: redisQueueConnection.redis.db,
    })
  }

  const redisConnection = redisConfig?.connections[connectionName]
  if (redisConnection) {
    return Object.freeze({
      ...(typeof redisConnection.url === 'undefined' ? {} : { url: redisConnection.url }),
      ...(typeof redisConnection.clusters === 'undefined' ? {} : { clusters: redisConnection.clusters }),
      host: redisConnection.host,
      port: redisConnection.port,
      username: redisConnection.username,
      password: redisConnection.password,
      db: redisConnection.db,
    })
  }

  if (queueConnection) {
    throw new Error(
      `[@holo-js/broadcast] Broadcast scaling connection "${connectionName}" must use the Redis queue driver.`,
    )
  }

  if (redisConfig && typeof redisConfig.connections === 'object') {
    const availableConnections = Object.keys(redisConfig.connections)
    throw new Error(
      `[@holo-js/broadcast] Broadcast scaling connection "${connectionName}" was not found in top-level redis connections. `
      + `Available redis connections: ${availableConnections.join(', ') || '(none)'}.`,
    )
  }

  if (!queueConfig) {
    throw new Error('[@holo-js/broadcast] Broadcast scaling requires either redis config or a Redis queue connection so the Redis connection can be resolved.')
  }

  throw new Error(`[@holo-js/broadcast] Broadcast scaling connection "${connectionName}" was not found in queue connections.`)
}

function resolveScalingConnectionName(
  connectionName: string,
  queueConfig: NormalizedHoloQueueConfig | undefined,
  redisConfig?: NormalizedHoloRedisConfig,
): string {
  const queueDefaultConnection = queueConfig
    ? queueConfig.connections[queueConfig.default]
    : undefined

  if (connectionName !== 'default') {
    return connectionName
  }

  if (queueDefaultConnection?.driver === 'redis') {
    return queueConfig!.default
  }

  return redisConfig?.default ?? connectionName
}

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://') || value.startsWith('/')
}

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
}

function parseRedisClusterNodeUrl(url: string, label: string): { readonly host: string, readonly port: number } {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`)
    }

    if (!parsed.hostname) {
      throw new Error('missing hostname')
    }

    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    }
  } catch (error) {
    throw new Error(`[@holo-js/broadcast] ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveRedisClusterStartupNodes(
  clusters: readonly NonNullable<BroadcastRedisScalingConnection['clusters']>[number][],
): readonly { readonly host: string, readonly port: number, readonly tls?: Record<string, never> }[] {
  return clusters.map((node, index) => {
    const label = `Broadcast scaling cluster node ${index + 1}`
    if (typeof node.url === 'string') {
      return parseRedisClusterNodeUrl(node.url, `${label} url`)
    }

    if (isRedisSocketConnectionTarget(node.host)) {
      throw new Error(`[@holo-js/broadcast] ${label} cannot use a Unix socket path in Redis cluster mode.`)
    }

    return {
      host: node.host,
      port: node.port,
    }
  })
}

async function loadRedisScalingModule(
  loadModule?: () => Promise<unknown>,
): Promise<RedisScalingModuleLike> {
  try {
    /* v8 ignore next 4 -- exercised only when ioredis is installed and no test loader override is provided. */
    const loadDefaultModule = async (): Promise<unknown> => {
      const specifier = 'ioredis' as string
      return await import(/* webpackIgnore: true */ specifier)
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
  if (connection.clusters && connection.clusters.length > 0 && connection.db !== 0) {
    throw new Error('[@holo-js/broadcast] Redis Cluster does not support selecting a non-zero database. Remove redis.db or set it to 0.')
  }

  const redisModule = await loadRedisScalingModule(dependencies.loadRedisModule)
  const RedisCtor = redisModule.default
  const createClient = (): RedisScalingClientLike => {
    if (connection.clusters && connection.clusters.length > 0) {
      const startupNodes = resolveRedisClusterStartupNodes(connection.clusters)

      return new redisModule.Cluster(
        startupNodes,
        {
          redisOptions: {
            username: connection.username,
            password: connection.password,
            db: connection.db,
            ...(startupNodes.some(node => typeof node.tls !== 'undefined') ? { tls: {} } : {}),
          },
        },
      )
    }

    if (typeof connection.url === 'string') {
      return new RedisCtor(connection.url, {
        username: connection.username,
        password: connection.password,
        db: connection.db,
      })
    }

    return new RedisCtor(
      isRedisSocketConnectionTarget(connection.host)
        ? {
            path: toRedisSocketPath(connection.host),
            username: connection.username,
            password: connection.password,
            db: connection.db,
          }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            db: connection.db,
          },
    )
  }
  const commandClient = createClient()
  let subscriberClient: RedisScalingClientLike | undefined
  const openSubscriberClient = (): RedisScalingClientLike => {
    subscriberClient ??= createClient()
    return subscriberClient
  }
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
      const client = openSubscriberClient()
      listeners.set(channel, listener)
      client.on('message', listener)
      await client.subscribe(channel)
      return async () => {
        const existing = listeners.get(channel)
        if (existing) {
          await client.unsubscribe(channel)
          client.off('message', existing)
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
    async setWithExpiry(key: string, value: string, ttlMs: number) {
      await commandClient.set(key, value, 'PX', ttlMs)
    },
    async exists(key: string) {
      return (await commandClient.exists(key)) > 0
    },
    async close() {
      if (subscriberClient) {
        const opened = subscriberClient
        try {
          await opened.quit()
        } catch {
          opened.disconnect()
        }
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
    requireBroadcastCredentials(holoConnection, 'run the broadcast worker', name)
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
  clientAuth?: ClientChannelAuth,
  channelAuth?: BroadcastChannelAuthRuntimeBindings,
  fetcher?: typeof fetch,
): Promise<{ readonly whispers: readonly string[], readonly member?: PresenceMember }> {
  const { kind, canonical } = parseChannelKind(channel)
  if (kind === 'public') {
    return Object.freeze({
      whispers: Object.freeze([]),
    })
  }

  if (clientAuth) {
    return verifyClientChannelAuth(app, connection.socketId, channel, clientAuth)
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
    if (response.status >= 500) {
      throw new Error(`[@holo-js/broadcast] Channel authorization endpoint failed (${response.status}).`)
    }

    if (!response.ok) {
      throw new BroadcastSubscriptionDeniedError(response.status)
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

  const guard = await resolveBroadcastChannelGuard({
    channel: canonical,
    socketId: connection.socketId,
  }, channelAuth)
  const resolvedUser = typeof channelAuth?.resolveUser === 'function'
    ? await channelAuth.resolveUser({
      headers: connection.headers,
      socketId: connection.socketId,
      channel: canonical,
      ...(typeof guard === 'undefined' ? {} : { guard }),
      appId: app.appId,
      connection: app.connection,
    })
    : null
  if (typeof resolvedUser === 'undefined' || resolvedUser === null) {
    throw new BroadcastSubscriptionDeniedError(403)
  }

  const authorized = await authorizeBroadcastChannel({
    channel: canonical,
    socketId: connection.socketId,
    user: resolvedUser,
  }, channelAuth)

  if (!authorized.ok) {
    throw new BroadcastSubscriptionDeniedError(403)
  }

  return Object.freeze({
    whispers: authorized.whispers,
    /* v8 ignore next -- exercised in integration tests for private and presence channel auth; expression is kept for TS narrowing. */
    ...(authorized.type === 'presence' ? { member: authorized.member } : {}),
  })
}

function resolveRealtimeErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  const decision = isRecord(error.decision) ? error.decision : undefined
  const status = decision?.status ?? error.status ?? error.statusCode
  if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599) {
    return status
  }

  const name = typeof error.name === 'string' ? error.name : ''
  if (name === 'RealtimeUnauthorizedError') {
    return 401
  }

  if (name === 'RealtimeForbiddenError') {
    return 403
  }

  if (name !== 'RealtimeAuthUnavailableError' && isRealtimeApplicationError(error)) {
    return 400
  }

  return undefined
}

const CLIENT_FACING_REALTIME_ERROR_NAMES = new Set(['AuthorizationError', 'ValidationException'])

function isClientFacingRealtimeError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false
  }

  const name = typeof error.name === 'string' ? error.name : ''
  return CLIENT_FACING_REALTIME_ERROR_NAMES.has(name)
    || (name !== 'RealtimeAuthUnavailableError' && isRealtimeApplicationError(error))
}

function isRealtimeApplicationError(error: object): boolean {
  for (let prototype: unknown = Object.getPrototypeOf(error); isRecord(prototype); prototype = Object.getPrototypeOf(prototype)) {
    if (typeof prototype.constructor === 'function' && prototype.constructor.name === 'RealtimeError') {
      return true
    }
  }

  return false
}

function resolveRealtimeErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined
  }

  const decision = isRecord(error.decision) ? error.decision : undefined
  const code = decision?.code ?? error.code
  return typeof code === 'string' ? code : undefined
}

function resolveRealtimeErrorKind(error: unknown, status: number | undefined): RealtimeWireErrorKind {
  if (!isRecord(error)) {
    return 'runtime'
  }

  const name = typeof error.name === 'string' ? error.name : ''
  if (
    name === 'AuthorizationError'
    || name === 'RealtimeUnauthorizedError'
    || name === 'RealtimeForbiddenError'
    || status === 401
    || status === 403
    || status === 404
  ) {
    return 'authorization'
  }

  return name === 'RealtimeAuthUnavailableError' ? 'transport' : 'runtime'
}

export function createBroadcastWorkerRuntime(options: WorkerRuntimeOptions): BroadcastWorkerRuntime {
  const report = captureErrorReporter()
  const appsByKey = buildWorkerApps(options.config)
  const connectedSockets = new Map<string, SocketState>()
  const channels = new Map<string, Set<string>>()
  const channelWhispers = new Map<string, Map<string, Set<string>>>()
  const presenceMembers = new Map<string, Map<string, PresenceMember>>()
  const presenceSockets = new Map<string, Map<string, string>>()
  const scaling = options.scaling
  const scalingLiveness = scaling?.liveness ?? DEFAULT_SCALING_LIVENESS
  const currentTime = (): number => options.now?.() ?? performance.now()
  const startedAt = currentTime()
  const servedAppIds = resolveBroadcastAppIds(options.config)
  const databaseInvalidationAppId = resolveDefaultBroadcastAppId(options.config)
  const disconnectDatabaseInvalidation = scaling && options.realtime?.databaseInvalidation && databaseInvalidationAppId !== undefined
    ? options.realtime.databaseInvalidation.connect(
      invalidation => publishScalingDatabaseInvalidation(invalidation),
      resolveDatabaseInvalidationPublisherScope(scaling.eventChannel, databaseInvalidationAppId),
    )
    : undefined
  const scalingUnsubscribe = options.scalingUnsubscribe
    ? Promise.resolve(options.scalingUnsubscribe)
    : scaling && options.scalingAutoSubscribe !== false
      ? scaling.adapter.subscribe(scaling.eventChannel, createScalingMessageListener({
          receiveScalingMessage: handleScalingMessage,
        }, report))
    : Promise.resolve(async () => {})
  let livenessCycle: Promise<void> | undefined
  function scheduleLivenessCycle(): void {
    livenessCycle ??= runScalingLivenessCycle()
      .catch((error: unknown) => {
        report(error, { capability: 'broadcast', operation: 'worker.scalingLiveness' })
      })
      .finally(() => {
        livenessCycle = undefined
      })
  }
  const livenessTimer = scaling
    ? setInterval(scheduleLivenessCycle, scalingLiveness.refreshIntervalMs)
    : undefined

  const presenceQueues = new Map<string, Promise<void>>()
  const ownedPresenceChannels = new Map<string, { readonly app: BroadcastWorkerApp, readonly channel: string }>()
  const pendingSocketCleanups = new Set<Promise<void>>()

  function runPresenceExclusive<T>(key: string, task: () => T | Promise<T>): Promise<T> {
    const previous = presenceQueues.get(key) ?? Promise.resolve()
    const result = previous.then(task)
    const settled = result.then(() => undefined, () => undefined)
    presenceQueues.set(key, settled)
    void settled.then(() => {
      if (presenceQueues.get(key) === settled) {
        presenceQueues.delete(key)
      }
    })
    return result
  }

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

  async function refreshNodeLease(): Promise<void> {
    if (!scaling) {
      return
    }

    await scaling.adapter.setWithExpiry(resolveNodeLeaseKey(scaling.connection, scaling.nodeId), scaling.nodeId, scalingLiveness.leaseTtlMs)
  }

  async function listDeadNodeSocketRefs(socketRefs: readonly string[]): Promise<string[]> {
    if (!scaling) {
      return []
    }

    const liveNodes = new Map<string, boolean>()
    const deadSocketRefs: string[] = []
    for (const socketRef of socketRefs) {
      const nodeId = resolveSocketRefNodeId(socketRef)
      if (nodeId === scaling.nodeId) {
        continue
      }

      let isLive = liveNodes.get(nodeId)
      if (isLive === undefined) {
        isLive = await scaling.adapter.exists(resolveNodeLeaseKey(scaling.connection, nodeId))
        liveNodes.set(nodeId, isLive)
      }
      if (!isLive) {
        deadSocketRefs.push(socketRef)
      }
    }
    return deadSocketRefs
  }

  function removePresenceSocketRefsLocal(appId: string, channel: string, socketRefs: readonly string[], excludeSocketId?: string): void {
    const key = composeSubscriptionKey(appId, channel)
    const roster = presenceMembers.get(key)
    const memberSockets = presenceSockets.get(key)
    if (!roster || !memberSockets) {
      return
    }

    for (const socketRef of socketRefs) {
      const memberId = memberSockets.get(socketRef)
      if (memberId === undefined) {
        continue
      }

      memberSockets.delete(socketRef)
      if ([...memberSockets.values()].includes(memberId)) {
        continue
      }

      const member = roster.get(memberId)
      roster.delete(memberId)
      if (member) {
        deliverPresenceMemberRemovedLocal(appId, channel, member, excludeSocketId, memberId)
      }
    }
    if (memberSockets.size === 0) {
      presenceSockets.delete(key)
    }
    if (roster.size === 0) {
      presenceMembers.delete(key)
    }
  }

  async function reconcilePresenceEntries(appId: string, channel: string, excludeSocketId?: string): Promise<Map<string, PresenceMember>> {
    if (!scaling) {
      return new Map()
    }

    const presenceKey = resolvePresenceHashKey(scaling.connection, appId, channel)
    const entries = parsePresenceHashMembers(await scaling.adapter.hashGetAll(presenceKey))
    const localSocketRefs = [...(presenceSockets.get(composeSubscriptionKey(appId, channel))?.keys() ?? [])]
    const deadSocketRefs = await listDeadNodeSocketRefs([...new Set([...entries.keys(), ...localSocketRefs])])
    for (const socketRef of deadSocketRefs) {
      await refreshNodeLease()
      await scaling.adapter.hashDelete(presenceKey, socketRef)
      entries.delete(socketRef)
    }
    removePresenceSocketRefsLocal(appId, channel, deadSocketRefs, excludeSocketId)
    return entries
  }

  function listPresenceChannelsWithLocalSubscribers(): Array<{ readonly appId: string, readonly channel: string }> {
    const channelsByKey = new Map<string, { readonly appId: string, readonly channel: string }>()
    for (const socket of connectedSockets.values()) {
      for (const channel of socket.subscribedChannels) {
        if (parseChannelKind(channel).kind === 'presence') {
          channelsByKey.set(composeSubscriptionKey(socket.app.appId, channel), { appId: socket.app.appId, channel })
        }
      }
    }
    return [...channelsByKey.values()]
  }

  async function reconcileOwnPresenceEntries(app: BroadcastWorkerApp, channel: string): Promise<boolean> {
    if (!scaling) {
      return false
    }

    const presenceKey = resolvePresenceHashKey(scaling.connection, app.appId, channel)
    const entries = parsePresenceHashMembers(await scaling.adapter.hashGetAll(presenceKey))
    let remainingOwnEntries = 0
    for (const [socketRef, member] of entries) {
      if (resolveSocketRefNodeId(socketRef) !== scaling.nodeId) {
        continue
      }

      const socketId = socketRef.slice(socketRef.lastIndexOf(':') + 1)
      const socket = connectedSockets.get(socketId)
      if (socket?.active && socket.subscribedChannels.has(channel)) {
        remainingOwnEntries += 1
        continue
      }

      await publishScalingPresenceMemberRemoved(app, channel, socketId, member)
      await scaling.adapter.hashDelete(presenceKey, socketRef)
    }
    const hasLiveSubscriber = [...connectedSockets.values()].some(socket => {
      return socket.active && socket.app.appId === app.appId && socket.subscribedChannels.has(channel)
    })
    return remainingOwnEntries > 0 || hasLiveSubscriber
  }

  async function runScalingLivenessCycle(): Promise<void> {
    if (!scaling) {
      return
    }

    const reportLivenessError = (error: unknown) => {
      report(error, { capability: 'broadcast', operation: 'worker.scalingLiveness' })
    }
    await refreshNodeLease()
    for (const [key, { app, channel }] of [...ownedPresenceChannels]) {
      await refreshNodeLease()
      await runPresenceExclusive(key, async () => {
        if (!await reconcileOwnPresenceEntries(app, channel)) {
          ownedPresenceChannels.delete(key)
        }
      }).catch(reportLivenessError)
    }
    for (const { appId, channel } of listPresenceChannelsWithLocalSubscribers()) {
      await refreshNodeLease()
      await runPresenceExclusive(composeSubscriptionKey(appId, channel), () => reconcilePresenceEntries(appId, channel)).catch(reportLivenessError)
    }
  }

  function findPresenceMemberOfSocket(appId: string, socketId: string, channel: string): PresenceMember | undefined {
    const key = composeSubscriptionKey(appId, channel)
    const memberId = presenceSockets.get(key)?.get(createPresenceSocketRef(channel, socketId))
    return memberId === undefined ? undefined : presenceMembers.get(key)?.get(memberId)
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

    let departedPresenceMember: PresenceMember | undefined
    let removed = false
    const roster = presenceMembers.get(key)
    const memberSockets = presenceSockets.get(key)
    if (roster && memberSockets) {
      const presenceSocketRef = createPresenceSocketRef(channel, socketId)
      const memberId = memberSockets.get(presenceSocketRef)
      if (memberId) {
        departedPresenceMember = roster.get(memberId)
        memberSockets.delete(presenceSocketRef)
        if (memberSockets.size === 0) {
          presenceSockets.delete(key)
        }

        if (![...memberSockets.values()].includes(memberId)) {
          removed = typeof departedPresenceMember !== 'undefined'
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
      ...(typeof departedPresenceMember === 'undefined' ? {} : { member: departedPresenceMember }),
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

    await refreshNodeLease()
    ownedPresenceChannels.set(key, { app, channel })
    await scaling.adapter.hashSet(
      resolvePresenceHashKey(scaling.connection, app.appId, channel),
      socketRef,
      JSON.stringify(member),
    )
    const merged = await reconcilePresenceEntries(app.appId, channel, socketId)
    const hasExistingMember = [...merged.entries()].some(([existingSocketRef, existingMember]) => {
      return existingSocketRef !== socketRef
        && resolvePresenceMemberId(existingMember, existingSocketRef) === memberId
    })
    const previousRoster = new Map(presenceMembers.get(key) ?? [])
    const roster = setPresenceState(key, merged)
    for (const [departedId, departed] of previousRoster) {
      if (!roster.has(departedId)) {
        deliverPresenceMemberRemovedLocal(app.appId, channel, departed, socketId, departedId)
      }
    }
    for (const [arrivedId, arrived] of roster) {
      if (!previousRoster.has(arrivedId) && arrivedId !== memberId) {
        deliverPresenceMemberAddedLocal(app.appId, channel, arrived, socketId)
      }
    }
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

      if (socket.send(pusherEvent(event, data, channel))) {
        deliveredSockets += 1
      }
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

  function sendRealtimeMessage(socket: SocketState, event: string, data: Record<string, unknown>): void {
    if (!socket.active) {
      return
    }

    socket.send(pusherEvent(event, data))
  }

  function sendRealtimeError(socket: SocketState, id: string, error: unknown): void {
    const status = resolveRealtimeErrorStatus(error)
    const kind = resolveRealtimeErrorKind(error, status)
    if (!isClientFacingRealtimeError(error) || (typeof status === 'number' && status >= 500)) {
      report(error, { capability: 'broadcast', operation: 'worker.realtime' })
      sendRealtimeMessage(socket, 'holo:realtime:error', {
        id,
        message: REALTIME_ERROR_MESSAGE,
        kind: kind === 'authorization' ? 'runtime' : kind,
        status: 500,
      })
      return
    }

    const code = resolveRealtimeErrorCode(error)
    const name = error instanceof Error ? error.name : undefined
    sendRealtimeMessage(socket, 'holo:realtime:error', {
      id,
      message: error instanceof Error ? error.message : String(error),
      kind,
      ...(typeof name === 'undefined' ? {} : { name }),
      ...(typeof status === 'undefined' ? {} : { status }),
      ...(typeof code === 'undefined' ? {} : { code }),
    })
  }

  function createRealtimeExecutionContext(socket: SocketState) {
    return Object.freeze({
      headers: socket.headers,
      socketId: socket.socketId,
      appId: socket.app.appId,
      connection: socket.app.connection,
    })
  }

  async function handleRealtimeMessage(socket: SocketState, data: Record<string, unknown>): Promise<void> {
    const realtime = options.realtime as BroadcastPatchCapableRealtimeRuntimeBindings | undefined
    const request = parseRealtimeSocketMessage(data)
    if (!realtime) {
      sendRealtimeError(socket, request.id, new Error('[@holo-js/broadcast] Realtime requires broadcast worker support. Run "holo broadcast:work" from a project with @holo-js/realtime installed.'))
      return
    }

    if (request.action === 'unsubscribe') {
      const subscription = socket.realtimeSubscriptions.get(request.id)
      socket.realtimeSubscriptionTokens.delete(request.id)
      if (subscription) {
        unsubscribeRealtimeSubscription(subscription, report)
      }
      socket.realtimeSubscriptions.delete(request.id)
      sendRealtimeMessage(socket, 'holo:realtime:unsubscribed', {
        id: request.id,
      })
      return
    }

    const context = createRealtimeExecutionContext(socket)
    let pendingSubscriptionToken: object | undefined
    try {
      if (request.action === 'query') {
        const result = await realtime.query(request.name!, request.args, context)
        sendRealtimeMessage(socket, 'holo:realtime:result', {
          id: request.id,
          action: request.action,
          snapshot: {
            ...result,
            version: 1,
          },
        })
        return
      }

      if (request.action === 'mutation') {
        const result = await realtime.mutate(request.name!, request.args, context)
        sendRealtimeMessage(socket, 'holo:realtime:result', {
          id: request.id,
          action: request.action,
          result,
        })
        return
      }

      if (exceedsRealtimeSubscriptionLimit(socket, request.id)) {
        sendRealtimeMessage(socket, 'holo:realtime:error', {
          id: request.id,
          message: REALTIME_SUBSCRIPTION_LIMIT_MESSAGE,
          kind: 'runtime',
          status: SUBSCRIPTION_LIMIT_STATUS,
        })
        return
      }

      const previousSubscription = socket.realtimeSubscriptions.get(request.id)
      socket.realtimeSubscriptionTokens.delete(request.id)
      if (previousSubscription) {
        unsubscribeRealtimeSubscription(previousSubscription, report)
        socket.realtimeSubscriptions.delete(request.id)
      }

      const subscriptionToken = {}
      pendingSubscriptionToken = subscriptionToken
      socket.realtimeSubscriptionTokens.set(request.id, subscriptionToken)
      const subscription = await realtime.subscribe(request.name!, request.args, {
        context,
        onData(snapshot) {
          if (!isRealtimeSubscriptionCurrent(socket, request.id, subscriptionToken)) {
            return
          }

          sendRealtimeMessage(socket, 'holo:realtime:snapshot', {
            id: request.id,
            snapshot,
          })
        },
        onPatch(patch) {
          if (!isRealtimeSubscriptionCurrent(socket, request.id, subscriptionToken)) {
            return
          }

          sendRealtimeMessage(socket, 'holo:realtime:patch', {
            id: request.id,
            patch,
          })
        },
        onError(error) {
          if (!isRealtimeSubscriptionCurrent(socket, request.id, subscriptionToken)) {
            return
          }

          sendRealtimeError(socket, request.id, error)
        },
      })
      if (!isRealtimeSubscriptionCurrent(socket, request.id, subscriptionToken)) {
        unsubscribeRealtimeSubscription(subscription, report)
        return
      }

      socket.realtimeSubscriptions.set(request.id, subscription)
    } catch (error) {
      if (pendingSubscriptionToken) {
        if (!isRealtimeSubscriptionCurrent(socket, request.id, pendingSubscriptionToken)) {
          return
        }

        socket.realtimeSubscriptionTokens.delete(request.id)
      }

      sendRealtimeError(socket, request.id, error)
    }
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

  async function publishScalingDatabaseInvalidation(invalidation: unknown): Promise<void> {
    if (!scaling || databaseInvalidationAppId === undefined) {
      return
    }

    await scaling.adapter.publish(scaling.eventChannel, createScalingDatabaseInvalidationPayload(scaling.nodeId, databaseInvalidationAppId, invalidation))
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

    if (message.type === 'database-invalidation') {
      if (scaling && typeof message.originNodeId === 'string' && isLocalScalingOrigin(scaling.eventChannel, message.originNodeId)) {
        return
      }

      if (typeof message.appId !== 'string' || !servedAppIds.includes(message.appId)) {
        return
      }

      await options.realtime?.databaseInvalidation?.receive(message.invalidation)
      return
    }

    if (message.type === 'event') {
      if (typeof message.name !== 'string' || !Array.isArray(message.channels) || typeof message.data !== 'string' || typeof message.appId !== 'string') {
        return
      }

      const socketId = typeof message.socketId === 'string'
        ? message.socketId
        : typeof (message as Record<string, unknown>).socket_id === 'string'
          ? (message as Record<string, unknown>).socket_id as string
          : undefined

      for (const channel of message.channels) {
        if (typeof channel !== 'string') {
          continue
        }
        deliverEventLocal(
          message.appId,
          channel,
          message.name,
          message.data,
          socketId,
        )
      }
      return
    }

    if (
      (message.type === 'presence-member-added' || message.type === 'presence-member-removed')
      && typeof message.appId === 'string'
      && typeof message.channel === 'string'
    ) {
      await runPresenceExclusive(composeSubscriptionKey(message.appId, message.channel), () => applyScalingPresenceMessage(message as BroadcastScalingPresenceMemberAddedMessage | BroadcastScalingPresenceMemberRemovedMessage))
    }
  }

  function applyScalingPresenceMessage(message: BroadcastScalingPresenceMemberAddedMessage | BroadcastScalingPresenceMemberRemovedMessage): void {
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
      if (roster?.has(memberId) && !memberSockets?.has(socketRef)) {
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

  function isSocketCurrent(socket: SocketState): boolean {
    return socket.active && connectedSockets.get(socket.socketId) === socket
  }

  function admitSocketMessage(socket: SocketState): boolean {
    const time = currentTime()
    if (time - socket.messageWindowStartedAt >= MESSAGE_RATE_WINDOW_MS) {
      socket.messageWindowStartedAt = time
      socket.messagesInWindow = 0
    }
    socket.messagesInWindow += 1
    return socket.messagesInWindow <= MAX_MESSAGES_PER_CONNECTION_PER_WINDOW
  }

  function exceedsChannelLimit(socket: SocketState, channel: string): boolean {
    const heldChannels = new Set([...socket.subscribedChannels, ...socket.presenceCleanupPending])
    return !heldChannels.has(channel) && heldChannels.size >= MAX_CHANNELS_PER_CONNECTION
  }

  function exceedsRealtimeSubscriptionLimit(socket: SocketState, id: string): boolean {
    return !socket.realtimeSubscriptionTokens.has(id)
      && socket.realtimeSubscriptionTokens.size >= MAX_REALTIME_SUBSCRIPTIONS_PER_CONNECTION
  }

  function closeSocket(socket: SocketState, code: number, reason: string): void {
    socket.close(code, reason)
    disconnectSocket(socket.socketId)
  }

  function closeSlowSocket(socket: SocketState): void {
    socket.active = false
    queueMicrotask(() => {
      if (connectedSockets.get(socket.socketId) !== socket) {
        return
      }

      socket.close(POLICY_VIOLATION_CLOSE_CODE, SLOW_CONSUMER_REASON)
      disconnectSocket(socket.socketId)
    })
  }

  function sendSubscriptionError(socket: SocketState, channel: string, status: number): void {
    if (!isSocketCurrent(socket)) {
      return
    }

    socket.send(pusherEvent('pusher:subscription_error', {
      type: 'AuthError',
      error: SUBSCRIPTION_ERROR_MESSAGE,
      status,
    }, channel))
  }

  async function rollBackFailedPresenceSubscription(socket: SocketState, channel: string, error: unknown): Promise<void> {
    report(error, { capability: 'broadcast', operation: 'worker.subscription' })
    socket.subscribedChannels.delete(channel)
    await runPresenceExclusive(composeSubscriptionKey(socket.app.appId, channel), () => {
      const removedPresenceMember = removeSubscriptionLocal(socket.app.appId, socket.socketId, channel)
      if (removedPresenceMember.removed && removedPresenceMember.member) {
        deliverPresenceMemberRemovedLocal(socket.app.appId, channel, removedPresenceMember.member, socket.socketId)
      }
    })
    await removePresenceMemberFromScaling(socket.app, socket.socketId, channel).then(
      () => {
        socket.presenceCleanupPending.delete(channel)
      },
      (cleanupError: unknown) => {
        report(cleanupError, { capability: 'broadcast', operation: 'worker.subscription' })
        socket.presenceCleanupPending.add(channel)
      },
    )
    sendSubscriptionError(socket, channel, 500)
  }

  async function handleSubscribe(socket: SocketState, rawChannel: string, clientAuth?: ClientChannelAuth): Promise<void> {
    const channel = normalizeRequiredString(rawChannel, 'Subscription channel')
    if (exceedsChannelLimit(socket, channel)) {
      sendSubscriptionError(socket, channel, SUBSCRIPTION_LIMIT_STATUS)
      return
    }

    let authorization: Awaited<ReturnType<typeof authenticateSubscription>>
    try {
      authorization = await authenticateSubscription(socket.app, socket, channel, clientAuth, options.channelAuth, options.fetch)
    } catch (error) {
      if (!(error instanceof BroadcastSubscriptionDeniedError)) {
        report(error, { capability: 'broadcast', operation: 'worker.subscription' })
      }

      sendSubscriptionError(socket, channel, error instanceof BroadcastSubscriptionDeniedError ? error.status : 500)
      return
    }

    if (!isSocketCurrent(socket)) {
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
      try {
        const synchronized = await runPresenceExclusive(key, () => isSocketCurrent(socket)
          ? synchronizePresenceChannel(socket.app, channel, member, socket.socketId)
          : undefined)
        if (!synchronized) {
          return
        }
        socket.presenceCleanupPending.delete(channel)
        if (synchronized.isNewMember) {
          deliverPresenceMemberAddedLocal(socket.app.appId, channel, member, socket.socketId)
        }
        await publishScalingPresenceMemberAdded(socket.app, channel, socket.socketId, member)
      } catch (error) {
        await rollBackFailedPresenceSubscription(socket, channel, error)
        return
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
    await runPresenceExclusive(composeSubscriptionKey(socket.app.appId, channel), async () => {
      const departingMember = findPresenceMemberOfSocket(socket.app.appId, socket.socketId, channel)
      await removePresenceMemberFromScaling(socket.app, socket.socketId, channel)
      if (departingMember) {
        await publishScalingPresenceMemberRemoved(socket.app, channel, socket.socketId, departingMember)
      }
      socket.presenceCleanupPending.delete(channel)
      socket.subscribedChannels.delete(channel)
      const removedPresenceMember = removeSubscriptionLocal(socket.app.appId, socket.socketId, channel)
      if (removedPresenceMember.removed && removedPresenceMember.member) {
        deliverPresenceMemberRemovedLocal(socket.app.appId, channel, removedPresenceMember.member, socket.socketId)
      }
    })
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
    await publishToChannels(payload)
  }

  async function publishToChannels(
    body: ResolvedPublishBody,
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

    await publishScalingEvent(body)

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

    let bodyText: string
    try {
      bodyText = await readLimitedRequestText(request, options.config.worker.maxRequestBytes)
    } catch (error) {
      if (error instanceof BroadcastPayloadTooLargeError) {
        return new Response('Payload Too Large', { status: 413 })
      }
      throw error
    }
    const bodyMd5 = createHash('md5').update(bodyText).digest('hex')
    if (url.searchParams.get('body_md5') !== bodyMd5) {
      return new Response('Invalid body signature', { status: 401 })
    }

    let authKey: string
    try {
      authKey = normalizeRequiredString(url.searchParams.get('auth_key') ?? '', 'Publish auth_key')
    } catch (error) {
      /* v8 ignore next -- defensive guard; normalizeRequiredString always throws Error */
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
      /* v8 ignore next -- defensive guard; normalizeRequiredString always throws Error */
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
      /* v8 ignore next -- defensive guard; normalizeRequiredString always throws Error */
      const message = error instanceof Error ? error.message : 'Invalid auth signature'
      return new Response(message, { status: 401 })
    }

    if (!verifyPusherSignature(providedSignature, expectedSignature)) {
      return new Response('Invalid auth signature', { status: 401 })
    }

    let publishBody: PublishBody
    try {
      publishBody = normalizePublishBody(parseJsonObject(bodyText, 'Publish body'))
    } catch (error) {
      return new Response((error as Error).message, { status: 400 })
    }
    let result: PublishDelivery
    try {
      result = await publishToChannels({
        ...publishBody,
        appId: app.appId,
      })
    } catch (error) {
      report(error, { capability: 'broadcast', operation: 'worker.publish' })
      return new Response(PUBLISH_ERROR_MESSAGE, { status: 500 })
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

  function disconnectSocket(socketId: string): void {
    const socket = connectedSockets.get(socketId)
    if (!socket) {
      return
    }

    socket.active = false
    connectedSockets.delete(socketId)
    for (const subscription of socket.realtimeSubscriptions.values()) {
      unsubscribeRealtimeSubscription(subscription, report)
    }
    socket.realtimeSubscriptions.clear()
    socket.realtimeSubscriptionTokens.clear()
    const channelsToCleanup = [...new Set([...socket.subscribedChannels, ...socket.presenceCleanupPending])]
    socket.presenceCleanupPending.clear()
    const scalingCleanupTasks = channelsToCleanup.map(channel => runPresenceExclusive(composeSubscriptionKey(socket.app.appId, channel), async () => {
      const removedPresenceMember = removeSubscriptionLocal(socket.app.appId, socket.socketId, channel)
      if (removedPresenceMember.removed && removedPresenceMember.member) {
        deliverPresenceMemberRemovedLocal(socket.app.appId, channel, removedPresenceMember.member, socket.socketId)
      }
      const removedFromScaling = await removePresenceMemberFromScaling(socket.app, socket.socketId, channel).then(() => true, (error: unknown) => {
        report(error, { capability: 'broadcast', operation: 'worker.socketCleanup' })
        return false
      })
      if (removedFromScaling && removedPresenceMember.member) {
        await publishScalingPresenceMemberRemoved(socket.app, channel, socket.socketId, removedPresenceMember.member).catch((error) => {
          report(error, { capability: 'broadcast', operation: 'worker.socketCleanup' })
        })
      }
    }))
    socket.subscribedChannels.clear()
    const cleanup = Promise.all([socket.pendingMessage, ...scalingCleanupTasks]).then(() => undefined, (error: unknown) => {
      report(error, { capability: 'broadcast', operation: 'worker.socketCleanup' })
    })
    pendingSocketCleanups.add(cleanup)
    void cleanup.then(() => pendingSocketCleanups.delete(cleanup))
    socket.pendingMessage = cleanup
  }

  let closing: Promise<void> | undefined
  const unregisterLocalScalingOrigin = scaling ? registerLocalScalingOrigin(scaling.eventChannel, scaling.nodeId) : undefined
  async function closeRuntime(): Promise<void> {
    unregisterLocalScalingOrigin?.()
  if (livenessTimer !== undefined) {
    clearInterval(livenessTimer)
  }
  await Promise.all([...connectedSockets.values()].map(async socket => {
    socket.close(1001, 'Worker shutdown')
    disconnectSocket(socket.socketId)
  }))
  await Promise.all([...pendingSocketCleanups])
  await livenessCycle
  disconnectDatabaseInvalidation?.()
  const unsubscribe = await scalingUnsubscribe
  await unsubscribe()
  if (scaling) {
    await scaling.adapter.close()
  }
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

      if (options.config.worker.statsEnabled && request.method.toUpperCase() === 'GET' && url.pathname === options.config.worker.statsPath) {
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
      if (connectedSockets.has(connection.socketId)) {
        throw new Error(`[@holo-js/broadcast] Socket id "${connection.socketId}" is already connected.`)
      }

      const socket: SocketState = {
        socketId: connection.socketId,
        app: connection.app,
        headers: connection.headers,
        send(payload) {
          if (!socket.active) {
            return false
          }

          if (wouldExceedBufferedBound(connection, payload)) {
            closeSlowSocket(socket)
            return false
          }

          connection.send(payload)
          if (isOverBufferedBound(connection)) {
            closeSlowSocket(socket)
          }
          return true
        },
        close: connection.close,
        subscribedChannels: new Set(),
        realtimeSubscriptions: new Map(),
        realtimeSubscriptionTokens: new Map(),
        presenceCleanupPending: new Set(),
        messageWindowStartedAt: currentTime(),
        messagesInWindow: 0,
        active: true,
        pendingMessage: Promise.resolve(),
      }
      connectedSockets.set(connection.socketId, socket)

      try {
        connection.send(pusherEvent('pusher:connection_established', {
          socket_id: connection.socketId,
          activity_timeout: ACTIVITY_TIMEOUT_SECONDS,
        }))
      } catch (error) {
        socket.active = false
        if (connectedSockets.get(connection.socketId) === socket) {
          connectedSockets.delete(connection.socketId)
        }
        throw error
      }
    },
    async receiveWebSocketMessage(socketId: string, rawMessage: string): Promise<void> {
      const socket = connectedSockets.get(socketId)
      if (!socket) {
        return
      }

      if (!admitSocketMessage(socket)) {
        closeSocket(socket, POLICY_VIOLATION_CLOSE_CODE, MESSAGE_RATE_EXCEEDED_REASON)
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
          await handleSubscribe(socket, String(message.data.channel ?? ''), parseClientChannelAuth(message.data))
          return
        }

        if (message.event === 'pusher:unsubscribe') {
          await handleUnsubscribe(socket, String(message.data.channel ?? ''))
          return
        }

        if (message.event.startsWith('client-')) {
          await handleClientEvent(socket, message)
          return
        }

        if (message.event === 'holo:realtime') {
          await handleRealtimeMessage(socket, message.data)
        }
      })
      socket.pendingMessage = task.catch(() => {})
      await task
    },
    async receiveScalingMessage(payload: string): Promise<void> {
      await handleScalingMessage(payload)
    },
    disconnectWebSocket: disconnectSocket,
    getStats(): BroadcastWorkerStats {
      return Object.freeze({
        nodeId: scaling?.nodeId ?? 'standalone',
        uptimeMs: currentTime() - startedAt,
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
    close(): Promise<void> {
      closing ??= closeRuntime()
      return closing
    },
  })
}

async function handleSubscribeFailure(
  runtime: BroadcastWorkerRuntime,
  subscribeError: unknown,
): Promise<never> {
  try {
    await runtime.close()
  } catch {
    // Suppress — runtime.close() already closes the adapter;
    // the original subscribeError is the meaningful failure.
  }
  throw subscribeError
}

export async function startBroadcastWorker(
  runtimeBindings: Pick<BroadcastRuntimeBindings, 'config' | 'channelAuth'> & {
    readonly realtime?: BroadcastRealtimeRuntimeBindings
    readonly queue?: NormalizedHoloQueueConfig
    readonly redis?: NormalizedHoloRedisConfig
    readonly nodeId?: string
    readonly scalingLiveness?: BroadcastScalingLiveness
    readonly fetch?: typeof fetch
    readonly createScalingAdapter?: (connection: BroadcastRedisScalingConnection) => Promise<BroadcastScalingAdapter>
    readonly loadRedisModule?: () => Promise<unknown>
    readonly loadWebSocketModule?: () => Promise<unknown>
  },
): Promise<StartedBroadcastWorker> {
  const report = captureErrorReporter()
  const config = runtimeBindings.config
  if (!config) {
    throw new Error('[@holo-js/broadcast] Broadcast worker requires a loaded broadcast config.')
  }

  const scalingConnectionName = config.worker.scaling
    ? resolveScalingConnectionName(config.worker.scaling.connection, runtimeBindings.queue, runtimeBindings.redis)
    : undefined
  const scalingConfig = config.worker.scaling
    ? Object.freeze({
        driver: 'redis' as const,
        connection: scalingConnectionName!,
        nodeId: runtimeBindings.nodeId ?? getProcessScalingNodeId(),
        eventChannel: resolveScalingEventChannel(scalingConnectionName!),
        liveness: runtimeBindings.scalingLiveness,
        adapter: await (runtimeBindings.createScalingAdapter
          ? runtimeBindings.createScalingAdapter(
            resolveRedisScalingConnection(runtimeBindings.queue, scalingConnectionName!, runtimeBindings.redis),
          )
          : createRedisScalingAdapter(
            resolveRedisScalingConnection(runtimeBindings.queue, scalingConnectionName!, runtimeBindings.redis),
            { loadRedisModule: runtimeBindings.loadRedisModule },
          )),
      })
    : undefined

  let scalingUnsubscribe: (() => Promise<void> | void) | undefined
  const runtime = createBroadcastWorkerRuntime({
    config,
    channelAuth: runtimeBindings.channelAuth,
    realtime: runtimeBindings.realtime,
    fetch: runtimeBindings.fetch ?? fetch,
    scaling: scalingConfig,
    scalingAutoSubscribe: false,
    scalingUnsubscribe: async () => {
      await scalingUnsubscribe?.()
    },
  })
  try {
    if (scalingConfig) {
      scalingUnsubscribe = await scalingConfig.adapter.subscribe(
        scalingConfig.eventChannel,
        createScalingMessageListener(runtime, report),
      ).catch((subscribeError: unknown) => handleSubscribeFailure(runtime, subscribeError))
    }
    const bun = (globalThis as { Bun?: BroadcastWorkerBunGlobal }).Bun
    const appsByKey = buildWorkerApps(config)
    const pathPrefix = config.worker.path.replace(/\/$/, '')
    const appPathRegex = new RegExp(`^${escapeRegExp(pathPrefix)}/([^/]+)$`)
    if (bun?.serve) {
      const rejectedSockets = new WeakSet<object>()
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

            if (!isAllowedWorkerOrigin(request, config.worker.allowedOrigins)) {
              return new Response('Forbidden', { status: 403 })
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
            try {
              runtime.connectWebSocket({
                ...socket.data,
                send(payload) {
                  socket.send(payload)
                },
                /* v8 ignore next 3 -- Bun websocket close callback forwarding is adapter glue; close is driven by Bun, not by unit tests. */
                close(code, reason) {
                  socket.close(code, reason)
                },
                bufferedAmount() {
                  return socket.getBufferedAmount()
                },
              })
            } catch (error) {
              rejectedSockets.add(socket)
              rejectSocketConnection(socket, error, report)
            }
          },
          message(socket, message) {
            if (rejectedSockets.has(socket)) {
              return
            }
            const messageBytes = typeof message === 'string'
              ? Buffer.byteLength(message)
              : message.byteLength
            if (messageBytes > config.worker.maxMessageBytes) {
              runtime.disconnectWebSocket(socket.data.socketId)
              socket.close(1009, 'Message too large')
              return
            }
            const value = typeof message === 'string'
              ? message
              : new TextDecoder().decode(message)
            void runtime.receiveWebSocketMessage(socket.data.socketId, value).catch((error) => {
              report(error, { capability: 'broadcast', operation: 'worker.socketMessage' })
              runtime.disconnectWebSocket(socket.data.socketId)
              socket.close(4001, 'Protocol error')
            })
          },
          close(socket) {
            if (rejectedSockets.has(socket)) {
              return
            }

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
    const wsServer = new WebSocketServer({ noServer: true, maxPayload: config.worker.maxMessageBytes })
    const heartbeat = startNodeSocketHeartbeat(wsServer)
    /* v8 ignore start -- Node websocket connection handler is adapter glue; exercised by real ws integration tests */
    wsServer.on('connection', (socket, request) => {
      const connectionInfo = requestConnectionInfo.get(request)!

      const socketId = connectionInfo.socketId
      try {
        runtime.connectWebSocket({
          ...connectionInfo,
          send(payload) {
            socket.send(payload)
          },
          close(code, reason) {
            socket.close(code, reason)
          },
          bufferedAmount() {
            return socket.bufferedAmount
          },
        })
      } catch (error) {
        rejectSocketConnection(socket, error, report)
        return
      }
      socket.on('pong', () => {
        heartbeat.recordActivity(socket)
      })
      socket.on('message', (message) => {
        heartbeat.recordActivity(socket)
        const messageBytes = getNodeWebSocketMessageBytes(message)
        if (messageBytes > config.worker.maxMessageBytes) {
          runtime.disconnectWebSocket(socketId)
          socket.close(1009, 'Message too large')
          return
        }
        const value = decodeNodeWebSocketMessage(message)
        void runtime.receiveWebSocketMessage(socketId, value).catch((error) => {
          report(error, { capability: 'broadcast', operation: 'worker.socketMessage' })
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
      let requestBody: Buffer | undefined
      try {
        requestBody = await readNodeRequestBody(request, config.worker.maxRequestBytes)
      } catch (error) {
        writeNodeRequestBodyError(response, error)
        return
      }
      const requestInit: RequestInit = {
        method: request.method,
        headers: toNodeHeaders(request.headers),
      }

      if (typeof requestBody !== 'undefined') {
        requestInit.body = new Uint8Array(requestBody)
      }

      const runtimeRequest = new Request(requestUrl, {
        ...requestInit,
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

      const originRequest = new Request(requestUrl, { headers: toNodeHeaders(request.headers) })
      if (!isAllowedWorkerOrigin(originRequest, config.worker.allowedOrigins)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
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
      heartbeat.stop()
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
        await runtime.close()
        heartbeat.stop()
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
      },
    })
  } catch (error) {
    await runtime.close().catch(() => undefined)
    throw error
  }
}

function createScalingInvalidationSender(input: {
  readonly config: NormalizedBroadcastWorkerScalingConfig
  readonly queue?: NormalizedHoloQueueConfig
  readonly redis?: NormalizedHoloRedisConfig
  readonly appId: string
}): { readonly publisherScope: string, publish(invalidation: unknown): Promise<void>, close(): Promise<void> } {
  const connectionName = resolveScalingConnectionName(input.config.connection, input.queue, input.redis)
  const redisConnection = resolveRedisScalingConnection(input.queue, connectionName, input.redis)
  const eventChannel = resolveScalingEventChannel(connectionName)
  const nodeId = getProcessScalingNodeId()
  let adapter: Promise<BroadcastScalingAdapter> | undefined
  const openAdapter = (): Promise<BroadcastScalingAdapter> => {
    adapter ??= createRedisScalingAdapter(redisConnection)
      .catch((error: unknown) => {
        adapter = undefined
        throw error
      })
    return adapter
  }

  return {
    publisherScope: resolveDatabaseInvalidationPublisherScope(eventChannel, input.appId),
    async publish(invalidation) {
      const scalingAdapter = await openAdapter()
      await scalingAdapter.publish(eventChannel, createScalingDatabaseInvalidationPayload(nodeId, input.appId, invalidation))
    },
    async close() {
      const opened = adapter
      adapter = undefined
      await opened?.then(client => client.close(), () => undefined)
    },
  }
}

export const workerInternals = {
  buildWorkerApps,
  createScalingInvalidationSender,
  resolveBroadcastAppIds,
  resolveDefaultBroadcastAppId,
  createScalingNodeId,
  createRedisScalingAdapter,
  createPusherSignature,
  verifyPusherSignature,
  createSocketId,
  resolveRedisScalingConnection,
  resolveScalingEventChannel,
  normalizePublishBody,
  parseChannelKind,
  parsePresenceHashMembers,
  parseSocketMessage,
  isAllowedWorkerOrigin,
  readLimitedRequestText,
  normalizeRealtimeAction,
  normalizeRealtimeArgs,
  parseRealtimeSocketMessage,
  safeEqual,
  signChannelAuth,
  parseClientChannelAuth,
  parseSignedChannelData,
  verifyClientChannelAuth,
  resolvePresenceMemberId,
  resolveRealtimeErrorStatus,
  resolveRealtimeErrorCode,
  resolveRealtimeErrorKind,
  writeNodeRequestBodyError,
}
