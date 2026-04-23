import { defineNotificationsConfig, type NormalizedHoloNotificationsConfig } from '@holo-js/config'

const HOLO_NOTIFICATION_DEFINITION_MARKER = Symbol.for('holo-js.notifications.definition')
const BUILT_IN_NOTIFICATION_CHANNELS = ['email', 'database', 'broadcast'] as const

type NotificationJsonPrimitive = string | number | boolean | null
export type NotificationJsonValue
  = NotificationJsonPrimitive
  | readonly NotificationJsonValue[]
  | { readonly [key: string]: NotificationJsonValue }

export type NotificationDelayValue = number | Date

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/notifications] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeDelayValue(value: NotificationDelayValue, label: string): NotificationDelayValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[@holo-js/notifications] ${label} must be a finite number greater than or equal to 0.`)
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`[@holo-js/notifications] ${label} dates must be valid Date instances.`)
  }

  return value
}

function normalizeOptionalBoolean(
  value: boolean | undefined,
  label: string,
): boolean | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw new Error(`[@holo-js/notifications] ${label} must be a boolean when provided.`)
  }

  return value
}

export interface NotificationMailMessage {
  readonly subject: string
  readonly greeting?: string
  readonly lines?: readonly string[]
  readonly action?: {
    readonly label: string
    readonly url: string
  }
  readonly html?: string
  readonly text?: string
  readonly metadata?: Readonly<Record<string, NotificationJsonValue>>
}

export interface NotificationDatabaseMessage<TData extends NotificationJsonValue = NotificationJsonValue> {
  readonly data: TData
}

export interface NotificationBroadcastMessage<TData extends NotificationJsonValue = NotificationJsonValue> {
  readonly event?: string
  readonly data: TData
}

export type NotificationEmailRoute
  = string
  | {
      readonly email: string
      readonly name?: string
    }

export interface NotificationDatabaseRoute {
  readonly id: string | number
  readonly type: string
}

export type NotificationBroadcastRoute
  = string
  | readonly string[]
  | {
      readonly channels: readonly string[]
    }

export interface NotificationContext {
  readonly anonymous: boolean
}

export interface NotificationBuildContext<TChannel extends string = string> extends NotificationContext {
  readonly channel: TChannel
}

export interface NotificationSendContext<
  TRoute = unknown,
  TPayload = unknown,
  TNotifiable = unknown,
  TChannel extends string = string,
> extends NotificationBuildContext<TChannel> {
  readonly route?: TRoute
  readonly notifiable: TNotifiable
  readonly notificationType?: string
  readonly payload: TPayload
  readonly targetIndex: number
}

export interface NotificationChannel<TRoute = unknown, TPayload = unknown, TResult = unknown> {
  validateRoute?(route: TRoute): TRoute
  send(input: NotificationSendContext<TRoute, TPayload>): TResult | Promise<TResult>
}

export interface BuiltInNotificationChannelRegistry {
  readonly email: NotificationChannel<NotificationEmailRoute, NotificationMailMessage, void>
  readonly database: NotificationChannel<NotificationDatabaseRoute, NotificationDatabaseMessage, void>
  readonly broadcast: NotificationChannel<NotificationBroadcastRoute, NotificationBroadcastMessage, void>
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloNotificationChannelRegistry {}

export type NotificationChannelRegistry = BuiltInNotificationChannelRegistry & HoloNotificationChannelRegistry
export type NotificationChannelName = Extract<keyof NotificationChannelRegistry, string>

type ResolveRegisteredChannel<TChannel extends string>
  = TChannel extends NotificationChannelName
    ? Extract<NotificationChannelRegistry[TChannel], NotificationChannel> extends never
      ? NotificationChannel
      : Extract<NotificationChannelRegistry[TChannel], NotificationChannel>
    : NotificationChannel

export type NotificationRouteFor<TChannel extends string>
  = ResolveRegisteredChannel<TChannel> extends NotificationChannel<infer TRoute, unknown, unknown>
    ? TRoute
    : never

export type NotificationPayloadFor<TChannel extends string>
  = ResolveRegisteredChannel<TChannel> extends NotificationChannel<unknown, infer TPayload, unknown>
    ? TPayload
    : never

export type NotificationResultFor<TChannel extends string>
  = ResolveRegisteredChannel<TChannel> extends NotificationChannel<unknown, unknown, infer TResult>
    ? TResult
    : unknown

export interface NotificationQueueOptions {
  readonly connection?: string
  readonly queue?: string
  readonly delay?: NotificationDelayValue
  readonly afterCommit?: boolean
}

export type NotificationQueueResolver<TNotifiable, TChannel extends string>
  = (notifiable: TNotifiable, channel: TChannel, context: NotificationContext) => boolean | NotificationQueueOptions

export type NotificationDelayResolver<TNotifiable, TChannel extends string>
  = (notifiable: TNotifiable, channel: TChannel, context: NotificationContext) => NotificationDelayValue | undefined

export type NotificationBuildFactories<TNotifiable> = Partial<{
  [TChannel in NotificationChannelName]: (
    notifiable: TNotifiable,
    context: NotificationBuildContext<TChannel>,
  ) => NotificationPayloadFor<TChannel>
}>

export interface NotificationDefinition<
  TNotifiable = unknown,
  TBuild extends NotificationBuildFactories<TNotifiable> = NotificationBuildFactories<TNotifiable>,
> {
  readonly type?: string
  via(
    notifiable: TNotifiable,
    context: NotificationContext,
  ): readonly Extract<keyof TBuild, string>[]
  readonly build: TBuild
  readonly queue?: boolean | NotificationQueueOptions | NotificationQueueResolver<TNotifiable, string>
  readonly delay?:
    | NotificationDelayValue
    | Partial<Record<Extract<keyof TBuild, string>, NotificationDelayValue>>
    | NotificationDelayResolver<TNotifiable, string>
}

export type InferNotificationNotifiable<TNotification>
  = TNotification extends NotificationDefinition<infer TNotifiable, NotificationBuildFactories<unknown>>
    ? TNotifiable
    : TNotification extends NotificationDefinition<infer TNotifiable, infer _TBuild>
      ? TNotifiable
      : never

export type InferNotificationChannels<TNotification>
  = TNotification extends NotificationDefinition<unknown, infer TBuild>
    ? Extract<keyof TBuild, string>
    : never

export interface AnonymousNotificationTarget<
  TRoutes extends Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }>
    = Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }>,
> {
  readonly anonymous: true
  readonly routes: TRoutes
}

type AnonymousRoutesWithChannel<
  TRoutes extends Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }>,
  TChannel extends NotificationChannelName,
> = Readonly<Omit<TRoutes, TChannel> & {
  readonly [TKey in TChannel]: NotificationRouteFor<TChannel>
}>

export interface NotificationChannelDispatchResult<TChannel extends string = string> {
  readonly channel: TChannel
  readonly targetIndex: number
  readonly queued: boolean
  readonly success: boolean
  readonly deferred?: boolean
  readonly result?: NotificationResultFor<TChannel>
  readonly error?: unknown
}

export interface NotificationDispatchResult {
  readonly totalTargets: number
  readonly channels: readonly NotificationChannelDispatchResult[]
  readonly deferred?: boolean
}

export interface PendingNotificationDispatch<TResult = NotificationDispatchResult> extends PromiseLike<TResult> {
  onConnection(name: string): PendingNotificationDispatch<TResult>
  onQueue(name: string): PendingNotificationDispatch<TResult>
  delay(value: NotificationDelayValue): PendingNotificationDispatch<TResult>
  delayFor<TChannel extends NotificationChannelName>(
    channel: TChannel,
    value: NotificationDelayValue,
  ): PendingNotificationDispatch<TResult>
  afterCommit(): PendingNotificationDispatch<TResult>
  then<TResult1 = TResult, TResult2 = never>(
    onfulfilled?: ((value: TResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult | TResult1>
  finally(onfinally?: (() => void) | null): Promise<TResult>
}

export interface PendingAnonymousNotification<
  TRoutes extends Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }>
    = Record<never, never>,
> {
  readonly target: AnonymousNotificationTarget<TRoutes>
  channel<TChannel extends NotificationChannelName>(
    channel: TChannel,
    route: NotificationRouteFor<TChannel>,
  ): PendingAnonymousNotification<AnonymousRoutesWithChannel<TRoutes, TChannel>>
  notify<TNotification extends NotificationDefinition<unknown, NotificationBuildFactories<unknown>>>(
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult>
}

export interface NotificationMailSender {
  send(message: NotificationMailMessage, context: NotificationSendContext<NotificationEmailRoute, NotificationMailMessage>): Promise<void> | void
}

export interface NotificationBroadcaster {
  send(message: NotificationBroadcastMessage, context: NotificationSendContext<NotificationBroadcastRoute, NotificationBroadcastMessage>): Promise<void> | void
}

export interface NotificationRecord<TData extends NotificationJsonValue = NotificationJsonValue> {
  readonly id: string
  readonly type?: string
  readonly notifiableType: string
  readonly notifiableId: string | number
  readonly data: TData
  readonly readAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface NotificationStore {
  create(record: NotificationRecord): Promise<void>
  list(notifiable: NotificationDatabaseRoute): Promise<readonly NotificationRecord[]>
  unread(notifiable: NotificationDatabaseRoute): Promise<readonly NotificationRecord[]>
  markAsRead(ids: readonly string[]): Promise<number>
  markAsUnread(ids: readonly string[]): Promise<number>
  delete(ids: readonly string[]): Promise<number>
}

export interface NotificationDispatchTarget {
  readonly kind: 'notifiable' | 'many' | 'anonymous'
  readonly value: unknown
}

export interface NotificationDispatchOptions {
  readonly connection?: string
  readonly queue?: string
  readonly delay?: NotificationDelayValue
  readonly delayByChannel?: Partial<Record<string, NotificationDelayValue>>
  readonly afterCommit?: boolean
}

export interface NotificationDispatchInput<
  TNotification extends NotificationDefinition = NotificationDefinition,
> {
  readonly target: NotificationDispatchTarget
  readonly notification: TNotification
  readonly options: NotificationDispatchOptions
}

export interface NotificationRuntimeBindings {
  readonly config?: NormalizedHoloNotificationsConfig
  readonly mailer?: NotificationMailSender
  readonly broadcaster?: NotificationBroadcaster
  readonly store?: NotificationStore
  dispatch?<TNotification extends NotificationDefinition = NotificationDefinition>(
    input: NotificationDispatchInput<TNotification>,
  ): Promise<NotificationDispatchResult>
}

export interface RegisterNotificationChannelOptions {
  readonly replaceExisting?: boolean
}

export interface RegisteredNotificationChannel<TChannel extends string = string> {
  readonly name: TChannel
  readonly channel: NotificationChannel
}

export function isNotificationDefinition(value: unknown): value is NotificationDefinition {
  return !!value
    && typeof value === 'object'
    && 'via' in value
    && typeof (value as { via?: unknown }).via === 'function'
    && 'build' in value
    && isObject((value as { build?: unknown }).build)
}

function normalizeQueueOptions(
  value: NotificationQueueOptions | undefined,
): NotificationQueueOptions | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return Object.freeze({
    connection: normalizeOptionalString(value.connection, 'Notification queue connection'),
    queue: normalizeOptionalString(value.queue, 'Notification queue name'),
    ...(typeof value.delay === 'undefined'
      ? {}
      : { delay: normalizeDelayValue(value.delay, 'Notification queue delay') }),
    ...(typeof normalizeOptionalBoolean(value.afterCommit, 'Notification queue afterCommit') === 'undefined'
      ? {}
      : { afterCommit: value.afterCommit }),
  })
}

function normalizeDelayConfig<TChannels extends string>(
  value: NotificationDefinition<unknown, NotificationBuildFactories<unknown>>['delay'] | undefined,
): NotificationDefinition<unknown, NotificationBuildFactories<unknown>>['delay'] | undefined {
  if (typeof value === 'undefined' || typeof value === 'function') {
    return value
  }

  if (typeof value === 'number' || value instanceof Date) {
    return normalizeDelayValue(value, 'Notification delay')
  }

  if (!isObject(value)) {
    throw new Error('[@holo-js/notifications] Notification delay must be a number, Date, plain object, or function.')
  }

  return Object.freeze(Object.fromEntries(Object.entries(value).map(([channel, delay]) => {
    const normalizedChannel = normalizeOptionalString(channel, 'Notification delay channel')
    return [normalizedChannel!, normalizeDelayValue(delay as NotificationDelayValue, `Notification delay for channel "${channel}"`)]
  }))) as Partial<Record<TChannels, NotificationDelayValue>>
}

export function normalizeNotificationDefinition<
  TNotifiable,
  TBuild extends NotificationBuildFactories<TNotifiable>,
>(
  definition: NotificationDefinition<TNotifiable, TBuild>,
): NotificationDefinition<TNotifiable, TBuild> {
  if (!isNotificationDefinition(definition)) {
    throw new Error('[@holo-js/notifications] Notifications must define via() and build.')
  }

  const buildEntries = Object.entries(definition.build)
  if (buildEntries.length === 0) {
    throw new Error('[@holo-js/notifications] Notifications must define at least one channel payload builder.')
  }

  const build = Object.freeze(Object.fromEntries(buildEntries.map(([channel, factory]) => {
    const normalizedChannel = normalizeOptionalString(channel, 'Notification channel name')
    if (typeof factory !== 'function') {
      throw new Error(`[@holo-js/notifications] Notification channel "${normalizedChannel}" must be a function.`)
    }

    return [normalizedChannel!, factory]
  }))) as TBuild

  const queue = typeof definition.queue === 'function'
    ? definition.queue
    : typeof definition.queue === 'boolean'
      ? definition.queue
      : normalizeQueueOptions(definition.queue)

  const normalized = {
    ...definition,
    ...(typeof definition.type === 'undefined'
      ? {}
      : { type: normalizeOptionalString(definition.type, 'Notification type') }),
    build,
    queue,
    delay: normalizeDelayConfig(definition.delay),
  } as NotificationDefinition<TNotifiable, TBuild>

  Object.defineProperty(normalized, HOLO_NOTIFICATION_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })

  return Object.freeze(normalized)
}

export function defineNotification<
  TNotifiable,
  TBuild extends NotificationBuildFactories<TNotifiable>,
>(
  definition: NotificationDefinition<TNotifiable, TBuild>,
): NotificationDefinition<TNotifiable, TBuild> {
  return normalizeNotificationDefinition(definition)
}

export function createAnonymousNotificationTarget<
  TRoutes extends Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }>,
>(
  routes: TRoutes,
): AnonymousNotificationTarget<TRoutes> {
  return Object.freeze({
    anonymous: true as const,
    routes: Object.freeze({ ...routes }),
  })
}

export const notificationsInternals = {
  BUILT_IN_NOTIFICATION_CHANNELS,
  HOLO_NOTIFICATION_DEFINITION_MARKER,
  createAnonymousNotificationTarget,
  isObject,
  normalizeDelayConfig,
  normalizeDelayValue,
  normalizeNotificationDefinition,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  normalizeQueueOptions,
}

export { defineNotificationsConfig }
