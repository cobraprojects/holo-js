import { randomUUID } from 'node:crypto'
import { holoNotificationsDefaults } from '@holo-js/config'
import {
  createAnonymousNotificationTarget,
  normalizeNotificationDefinition,
  type AnonymousNotificationTarget,
  type InferNotificationNotifiable,
  type NotificationBroadcastMessage,
  type NotificationBroadcastRoute,
  type NotificationBuildContext,
  type NotificationBuildFactories,
  type NotificationChannel,
  type NotificationChannelDispatchResult,
  type NotificationChannelName,
  type NotificationDatabaseMessage,
  type NotificationDatabaseRoute,
  type NotificationDefinition,
  type NotificationDelayValue,
  type NotificationDispatchInput,
  type NotificationDispatchOptions,
  type NotificationDispatchResult,
  type NotificationDispatchTarget,
  type NotificationEmailRoute,
  type NotificationMailMessage,
  type NotificationRecord,
  type NotificationRouteFor,
  type NotificationRuntimeBindings,
  type NotificationSendContext,
  type PendingAnonymousNotification,
  type PendingNotificationDispatch,
} from './contracts'
import { getRegisteredNotificationChannel } from './registry'

const HOLO_NOTIFICATIONS_DELIVER_JOB = 'holo.notifications.deliver'

function normalizeOptionalString(
  value: string,
  label: string,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/notifications] ${label} must be a non-empty string.`)
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

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isAnonymousTarget(value: unknown): value is AnonymousNotificationTarget {
  return isObject(value)
    && value.anonymous === true
    && isObject(value.routes)
}

function getRuntimeBindings(): NotificationRuntimeBindings {
  return getRuntimeState().bindings ?? {}
}

type RuntimeState = {
  bindings?: NotificationRuntimeBindings
  loadQueueModule?: () => Promise<QueueModule>
  loadDbModule?: () => Promise<DbModule | null>
}

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoNotificationsRuntime__?: RuntimeState
  }

  runtime.__holoNotificationsRuntime__ ??= {}
  return runtime.__holoNotificationsRuntime__
}

function getDispatchHandler() {
  const bindings = getRuntimeBindings()
  return bindings.dispatch ?? dispatchNotifications
}

function dynamicImport<TModule>(specifier: string): Promise<TModule> {
  if (process.env.VITEST) {
    return import(/* @vite-ignore */ specifier) as Promise<TModule>
  }

  const indirectEval = globalThis.eval as (source: string) => Promise<TModule>
  return indirectEval(`import(${JSON.stringify(specifier)})`)
}

async function loadQueueModule(): Promise<QueueModule> {
  const override = getRuntimeState().loadQueueModule
  if (override) {
    try {
      return await override()
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        throw new Error('[@holo-js/notifications] Queued or delayed notifications require @holo-js/queue to be installed.')
      }

      throw error
    }
  }

  try {
    return await dynamicImport<QueueModule>('@holo-js/queue')
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error('[@holo-js/notifications] Queued or delayed notifications require @holo-js/queue to be installed.')
    }

    throw error
  }
}

async function loadDbModule(): Promise<DbModule | null> {
  const override = getRuntimeState().loadDbModule
  if (override) {
    return await override()
  }

  try {
    return await dynamicImport<DbModule>('@holo-js/db')
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return null
    }

    throw error
  }
}

type MutableDispatchOptions = {
  connection?: string
  queue?: string
  delay?: NotificationDelayValue
  delayByChannel?: Record<string, NotificationDelayValue>
  afterCommit?: boolean
}

type DispatchTargetInput = NotificationDispatchTarget | (() => NotificationDispatchTarget)

type ResolvedTarget = {
  readonly index: number
  readonly anonymous: boolean
  readonly notifiable: unknown
  readonly routes?: Record<string, unknown>
}

type RouteResolver = (notifiable: unknown) => unknown

type ResolvedChannelPlan = {
  readonly channel: string
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly delay?: NotificationDelayValue
  readonly afterCommit: boolean
}

type DispatchExecutionOptions = {
  readonly allowAfterCommitDeferral?: boolean
}

type QueueDispatchChain = {
  onConnection(name: string): QueueDispatchChain
  onQueue(name: string): QueueDispatchChain
  delay(value: number | Date): QueueDispatchChain
  dispatch(): Promise<unknown>
}

type QueueModule = {
  defineJob(definition: { handle(payload: QueuedNotificationDeliveryPayload): Promise<unknown> | unknown }): unknown
  dispatch(jobName: string, payload: QueuedNotificationDeliveryPayload): QueueDispatchChain
  getRegisteredQueueJob(name: string): unknown
  registerQueueJob(definition: unknown, options: { name: string }): void
}

type DbModule = {
  connectionAsyncContext: {
    getActive(): { connection: { getScope(): { kind: string }, afterCommit(callback: () => Promise<void>): void } } | undefined
  }
}

type QueuedNotificationDeliveryPayload = Readonly<{
  readonly channel: string
  readonly anonymous: boolean
  readonly notifiable: unknown
  readonly route?: unknown
  readonly notificationType?: string
  readonly payload: unknown
  readonly targetIndex: number
}>

type BuiltInChannelDefinition = NotificationChannel & {
  readonly resolveRoute?: RouteResolver
}

function createNotificationContext(anonymous: boolean): { readonly anonymous: boolean } {
  return Object.freeze({ anonymous })
}

function createBuildContext<TChannel extends string>(
  channel: TChannel,
  anonymous: boolean,
): NotificationBuildContext<TChannel> {
  return Object.freeze({
    channel,
    anonymous,
  })
}

function normalizeEmailRouteFromValue(
  value: unknown,
): NotificationEmailRoute {
  if (typeof value === 'string') {
    const email = value.trim()
    if (!email) {
      throw new Error('[@holo-js/notifications] Email routes must be non-empty strings.')
    }

    return email
  }

  if (!isObject(value) || typeof value.email !== 'string' || !value.email.trim()) {
    throw new Error('[@holo-js/notifications] Email routes must be a string or an object with a non-empty email.')
  }

  return Object.freeze({
    email: value.email.trim(),
    ...(typeof value.name === 'string' && value.name.trim()
      ? { name: value.name.trim() }
      : {}),
  })
}

function resolveEmailRouteFromNotifiable(notifiable: unknown): NotificationEmailRoute {
  if (!isObject(notifiable) || typeof notifiable.email !== 'string' || !notifiable.email.trim()) {
    throw new Error('[@holo-js/notifications] Email notifications require a notifiable with a non-empty email.')
  }

  return Object.freeze({
    email: notifiable.email.trim(),
    ...(typeof notifiable.name === 'string' && notifiable.name.trim()
      ? { name: notifiable.name.trim() }
      : {}),
  })
}

function normalizeDatabaseRouteFromValue(
  value: unknown,
): NotificationDatabaseRoute {
  if (
    !isObject(value)
    || (typeof value.id !== 'string' && typeof value.id !== 'number')
    || typeof value.type !== 'string'
    || !value.type.trim()
  ) {
    throw new Error('[@holo-js/notifications] Database routes must include a string or numeric id and a non-empty type.')
  }

  return Object.freeze({
    id: value.id,
    type: value.type.trim(),
  })
}

function resolveDatabaseRouteFromNotifiable(notifiable: unknown): NotificationDatabaseRoute {
  if (!isObject(notifiable) || (typeof notifiable.id !== 'string' && typeof notifiable.id !== 'number')) {
    throw new Error('[@holo-js/notifications] Database notifications require a notifiable with a string or numeric id.')
  }

  const explicitType = typeof notifiable.type === 'string' && notifiable.type.trim()
    ? notifiable.type.trim()
    : undefined

  if (explicitType) {
    return Object.freeze({
      id: notifiable.id,
      type: explicitType,
    })
  }

  const constructorName = isObject(notifiable)
    && 'constructor' in notifiable
    && typeof notifiable.constructor === 'function'
    && typeof notifiable.constructor.name === 'string'
    ? notifiable.constructor.name.trim()
    : ''

  if (!constructorName || constructorName === 'Object') {
    throw new Error(
      '[@holo-js/notifications] Database notifications require a notifiable.type or a non-plain-object constructor name.',
    )
  }

  return Object.freeze({
    id: notifiable.id,
    type: constructorName,
  })
}

function normalizeBroadcastRouteFromValue(
  value: unknown,
): NotificationBroadcastRoute {
  if (typeof value === 'string') {
    const channel = value.trim()
    if (!channel) {
      throw new Error('[@holo-js/notifications] Broadcast routes must be non-empty strings.')
    }

    return channel
  }

  if (Array.isArray(value)) {
    const channels = value.map((entry, index) => {
      if (typeof entry !== 'string' || !entry.trim()) {
        throw new Error(`[@holo-js/notifications] Broadcast route entry at index ${index} must be a non-empty string.`)
      }

      return entry.trim()
    })

    if (channels.length === 0) {
      throw new Error('[@holo-js/notifications] Broadcast routes must include at least one channel.')
    }

    return Object.freeze(channels)
  }

  if (!isObject(value) || !Array.isArray(value.channels)) {
    throw new Error('[@holo-js/notifications] Broadcast routes must be a string, string array, or object with channels.')
  }

  return Object.freeze({
    channels: normalizeBroadcastRouteFromValue(value.channels) as readonly string[],
  })
}

function resolveBroadcastRouteFromNotifiable(notifiable: unknown): NotificationBroadcastRoute {
  if (!isObject(notifiable)) {
    throw new Error(
      '[@holo-js/notifications] Broadcast notifications require an anonymous route or a routeNotificationForBroadcast() method.',
    )
  }

  if (typeof notifiable.routeNotificationForBroadcast === 'function') {
    return normalizeBroadcastRouteFromValue(notifiable.routeNotificationForBroadcast())
  }

  if (typeof notifiable.broadcastChannels === 'function') {
    return normalizeBroadcastRouteFromValue(notifiable.broadcastChannels())
  }

  if ('broadcastChannels' in notifiable) {
    return normalizeBroadcastRouteFromValue(notifiable.broadcastChannels)
  }

  throw new Error(
    '[@holo-js/notifications] Broadcast notifications require an anonymous route or a routeNotificationForBroadcast() method.',
  )
}

function normalizeNotificationRecord(
  route: NotificationDatabaseRoute,
  payload: NotificationDatabaseMessage,
  notificationType: string | undefined,
): NotificationRecord {
  const now = new Date()
  return Object.freeze({
    id: randomUUID(),
    type: notificationType,
    notifiableType: route.type,
    notifiableId: route.id,
    data: payload.data,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  })
}

function requireMailer(bindings: NotificationRuntimeBindings) {
  if (!bindings.mailer) {
    throw new Error('[@holo-js/notifications] Email notifications require a configured mailer runtime.')
  }

  return bindings.mailer
}

function requireBroadcaster(bindings: NotificationRuntimeBindings) {
  if (!bindings.broadcaster) {
    throw new Error('[@holo-js/notifications] Broadcast notifications require a configured broadcaster runtime.')
  }

  return bindings.broadcaster
}

function requireStore(bindings: NotificationRuntimeBindings) {
  if (!bindings.store) {
    throw new Error('[@holo-js/notifications] Database notifications require a configured notification store runtime.')
  }

  return bindings.store
}

function normalizeNotificationRecordIds(ids: readonly string[]): readonly string[] {
  const normalized = ids.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`[@holo-js/notifications] Notification id at index ${index} must be a non-empty string.`)
    }

    return value.trim()
  })

  return Object.freeze([...new Set(normalized)])
}

const builtInChannels: Readonly<Record<'email' | 'database' | 'broadcast', BuiltInChannelDefinition>> = Object.freeze({
  email: Object.freeze({
    resolveRoute: resolveEmailRouteFromNotifiable,
    async send(input: NotificationSendContext) {
      await requireMailer(getRuntimeBindings()).send(
        input.payload as NotificationMailMessage,
        input as NotificationSendContext<NotificationEmailRoute, NotificationMailMessage>,
      )
    },
  }),
  database: Object.freeze({
    resolveRoute: resolveDatabaseRouteFromNotifiable,
    async send(input: NotificationSendContext) {
      const route = input.route as NotificationDatabaseRoute | undefined
      if (!route) {
        throw new Error('[@holo-js/notifications] Database notifications require a resolved route.')
      }

      await requireStore(getRuntimeBindings()).create(
        normalizeNotificationRecord(
          route,
          input.payload as NotificationDatabaseMessage,
          input.notificationType,
        ),
      )
    },
  }),
  broadcast: Object.freeze({
    resolveRoute: resolveBroadcastRouteFromNotifiable,
    async send(input: NotificationSendContext) {
      await requireBroadcaster(getRuntimeBindings()).send(
        input.payload as NotificationBroadcastMessage,
        input as NotificationSendContext<NotificationBroadcastRoute, NotificationBroadcastMessage>,
      )
    },
  }),
})

function getNotificationChannel(name: string): NotificationChannel | BuiltInChannelDefinition | undefined {
  if (name in builtInChannels) {
    return builtInChannels[name as keyof typeof builtInChannels]
  }

  return getRegisteredNotificationChannel(name)?.channel
}

function resolveTargets(target: NotificationDispatchTarget): readonly ResolvedTarget[] {
  if (target.kind === 'anonymous') {
    const anonymous = target.value
    if (!isAnonymousTarget(anonymous)) {
      throw new Error('[@holo-js/notifications] Anonymous notification targets must be created through notifyUsing().')
    }

    return Object.freeze([Object.freeze({
      index: 0,
      anonymous: true,
      notifiable: anonymous,
      routes: anonymous.routes as Record<string, unknown>,
    })])
  }

  if (target.kind === 'many') {
    if (!Array.isArray(target.value)) {
      throw new Error('[@holo-js/notifications] Multi-target notification dispatch requires an array target.')
    }

    return Object.freeze(target.value.map((notifiable, index) => Object.freeze({
      index,
      anonymous: false,
      notifiable,
    })))
  }

  return Object.freeze([Object.freeze({
    index: 0,
    anonymous: false,
    notifiable: target.value,
  })])
}

function resolveChannels(
  notification: NotificationDefinition,
  target: ResolvedTarget,
): readonly string[] {
  const channels = notification.via(target.notifiable, createNotificationContext(target.anonymous))
  if (!Array.isArray(channels)) {
    throw new Error('[@holo-js/notifications] Notification via() must return an array of channel names.')
  }

  return Object.freeze(channels.map((channel, index) => {
    if (typeof channel !== 'string') {
      throw new Error(`[@holo-js/notifications] Notification channel at index ${index} must be a string.`)
    }

    const normalized = normalizeOptionalString(channel, 'Notification channel')
    if (!getNotificationChannel(normalized)) {
      throw new Error(`[@holo-js/notifications] Notification channel "${normalized}" is not registered.`)
    }

    return normalized
  }))
}

function resolvePayload(
  notification: NotificationDefinition,
  channel: string,
  target: ResolvedTarget,
): unknown {
  const factory = notification.build[channel as keyof typeof notification.build] as
    | ((notifiable: unknown, context: NotificationBuildContext) => unknown)
    | undefined
  if (typeof factory !== 'function') {
    throw new Error(
      `[@holo-js/notifications] Notification channel "${channel}" is listed in via() but has no build.${channel}() payload factory.`,
    )
  }

  return factory(target.notifiable, createBuildContext(channel, target.anonymous))
}

function resolveNotificationQueueOptions(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
): boolean | NotificationDispatchOptions {
  if (typeof notification.queue === 'function') {
    return notification.queue(
      target.notifiable,
      channel as NotificationChannelName,
      createNotificationContext(target.anonymous),
    )
  }

  return notification.queue ?? false
}

function resolveNotificationDelay(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
): NotificationDelayValue | undefined {
  if (typeof notification.delay === 'function') {
    return notification.delay(
      target.notifiable,
      channel as NotificationChannelName,
      createNotificationContext(target.anonymous),
    )
  }

  if (typeof notification.delay === 'undefined') {
    return undefined
  }

  if (typeof notification.delay === 'number' || notification.delay instanceof Date) {
    return notification.delay
  }

  return notification.delay[channel as NotificationChannelName]
}

function resolveRoute(
  channel: string,
  target: ResolvedTarget,
): unknown {
  if (target.anonymous) {
    if (!(channel in (target.routes ?? {}))) {
      throw new Error(`[@holo-js/notifications] Anonymous notifications must define a route for channel "${channel}".`)
    }

    const route = target.routes?.[channel]
    if (channel === 'email') {
      return normalizeEmailRouteFromValue(route)
    }

    if (channel === 'database') {
      return normalizeDatabaseRouteFromValue(route)
    }

    if (channel === 'broadcast') {
      return normalizeBroadcastRouteFromValue(route)
    }

    return route
  }

  const registered = getNotificationChannel(channel)
  if (!registered) {
    throw new Error(`[@holo-js/notifications] Notification channel "${channel}" is not registered.`)
  }

  if ('resolveRoute' in registered && typeof registered.resolveRoute === 'function') {
    return registered.resolveRoute(target.notifiable)
  }

  if (isObject(registered) && typeof registered.validateRoute === 'function') {
    const routedNotifiable = isObject(target.notifiable) && typeof target.notifiable.routeNotificationFor === 'function'
      ? target.notifiable.routeNotificationFor(channel)
      : undefined
    if (typeof routedNotifiable === 'undefined') {
      return undefined
    }

    return registered.validateRoute(routedNotifiable)
  }

  if (isObject(target.notifiable) && typeof target.notifiable.routeNotificationFor === 'function') {
    return target.notifiable.routeNotificationFor(channel)
  }

  return undefined
}

function resolveChannelSendContext(
  notification: NotificationDefinition,
  channel: string,
  target: ResolvedTarget,
): NotificationSendContext {
  const payload = resolvePayload(notification, channel, target)

  return Object.freeze({
    channel,
    anonymous: target.anonymous,
    notifiable: target.notifiable,
    route: resolveRoute(channel, target),
    notificationType: notification.type,
    payload,
    targetIndex: target.index,
  })
}

function resolveChannelDispatchPlan(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
  options: NotificationDispatchOptions,
): ResolvedChannelPlan {
  const notificationQueue = resolveNotificationQueueOptions(notification, target, channel)
  const notificationQueueOptions = notificationQueue && notificationQueue !== true
    ? notificationQueue
    : undefined
  const config = getRuntimeBindings().config ?? holoNotificationsDefaults

  const resolvedDelay = options.delayByChannel?.[channel]
    ?? options.delay
    ?? resolveNotificationDelay(notification, target, channel)
  const resolvedConnection = options.connection
    ?? notificationQueueOptions?.connection
    ?? config.queue.connection
  const resolvedQueue = options.queue
    ?? notificationQueueOptions?.queue
    ?? config.queue.queue
  const afterCommit = options.afterCommit
    ?? notificationQueueOptions?.afterCommit
    ?? config.queue.afterCommit

  const queued = notificationQueue === true
    || !!notificationQueueOptions
    || typeof resolvedDelay !== 'undefined'
    || typeof resolvedConnection !== 'undefined'
    || typeof resolvedQueue !== 'undefined'

  return Object.freeze({
    channel,
    queued,
    connection: queued ? resolvedConnection : undefined,
    queue: queued ? resolvedQueue : undefined,
    delay: queued ? resolvedDelay : undefined,
    afterCommit,
  })
}

async function deliverResolvedNotificationChannel(
  context: NotificationSendContext,
): Promise<unknown> {
  const definition = getNotificationChannel(context.channel)
  if (!definition) {
    throw new Error(`[@holo-js/notifications] Notification channel "${context.channel}" is not registered.`)
  }

  const routeValidated = isObject(definition)
    && typeof definition.validateRoute === 'function'
    && typeof context.route !== 'undefined'
    ? definition.validateRoute(context.route)
    : context.route
  const runtimeContext = typeof routeValidated === 'undefined'
    ? context
    : Object.freeze({
        ...context,
        route: routeValidated,
      })

  return await definition.send(runtimeContext)
}

function createQueuedDeliveryPayload(context: NotificationSendContext): QueuedNotificationDeliveryPayload {
  return Object.freeze({
    channel: context.channel,
    anonymous: context.anonymous,
    notifiable: context.notifiable,
    ...(typeof context.route === 'undefined' ? {} : { route: context.route }),
    ...(typeof context.notificationType === 'undefined' ? {} : { notificationType: context.notificationType }),
    payload: context.payload,
    targetIndex: context.targetIndex,
  })
}

async function runQueuedNotificationDelivery(
  payload: QueuedNotificationDeliveryPayload,
): Promise<unknown> {
  return await deliverResolvedNotificationChannel(Object.freeze({
    channel: payload.channel,
    anonymous: payload.anonymous,
    notifiable: payload.notifiable,
    route: payload.route,
    notificationType: payload.notificationType,
    payload: payload.payload,
    targetIndex: payload.targetIndex,
  }))
}

async function ensureNotificationsQueueJobRegistered(queueModule?: QueueModule): Promise<QueueModule> {
  const resolvedQueueModule = queueModule ?? await loadQueueModule()
  if (resolvedQueueModule.getRegisteredQueueJob(HOLO_NOTIFICATIONS_DELIVER_JOB)) {
    return resolvedQueueModule
  }

  resolvedQueueModule.registerQueueJob(
    resolvedQueueModule.defineJob({
      async handle(payload: QueuedNotificationDeliveryPayload) {
        return await runQueuedNotificationDelivery(payload)
      },
    }),
    { name: HOLO_NOTIFICATIONS_DELIVER_JOB },
  )

  return resolvedQueueModule
}

async function dispatchQueuedNotificationChannel(
  context: NotificationSendContext,
  plan: ResolvedChannelPlan,
): Promise<void> {
  const queueModule = await ensureNotificationsQueueJobRegistered()
  let pending = queueModule.dispatch(
    HOLO_NOTIFICATIONS_DELIVER_JOB,
    createQueuedDeliveryPayload(context),
  )

  if (typeof plan.connection !== 'undefined') {
    pending = pending.onConnection(plan.connection)
  }

  if (typeof plan.queue !== 'undefined') {
    pending = pending.onQueue(plan.queue)
  }

  if (typeof plan.delay !== 'undefined') {
    pending = pending.delay(plan.delay)
  }

  await pending.dispatch()
}

async function deferDispatchUntilCommit(
  input: NotificationDispatchInput,
  targets: readonly ResolvedTarget[],
  notification: NotificationDefinition,
): Promise<NotificationDispatchResult | null> {
  const dbModule = await loadDbModule()
  const active = dbModule?.connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return null
  }

  const channels: NotificationChannelDispatchResult[] = []
  for (const target of targets) {
    for (const channel of resolveChannels(notification, target)) {
      const plan = resolveChannelDispatchPlan(notification, target, channel, input.options)
      channels.push(Object.freeze({
        channel,
        targetIndex: target.index,
        queued: plan.queued,
        deferred: true,
        success: true,
      }))
    }
  }

  active.afterCommit(async () => {
    await dispatchNotifications(input, { allowAfterCommitDeferral: false })
  })

  return Object.freeze({
    totalTargets: targets.length,
    channels: Object.freeze(channels),
    deferred: true,
  })
}

function shouldDeferDispatchAfterCommit(
  notification: NotificationDefinition,
  targets: readonly ResolvedTarget[],
  options: NotificationDispatchOptions,
): boolean {
  if (options.afterCommit) {
    return true
  }

  return targets.some(target => resolveChannels(notification, target).some(channel => {
    return resolveChannelDispatchPlan(notification, target, channel, options).afterCommit
  }))
}

async function dispatchNotifications(
  input: NotificationDispatchInput,
  execution: DispatchExecutionOptions = {},
): Promise<NotificationDispatchResult> {
  const notification = normalizeNotificationDefinition(input.notification)
  const targets = resolveTargets(input.target)
  if (execution.allowAfterCommitDeferral !== false && shouldDeferDispatchAfterCommit(notification, targets, input.options)) {
    const deferredResult = await deferDispatchUntilCommit(input, targets, notification)
    if (deferredResult) {
      return deferredResult
    }
  }

  const results: NotificationChannelDispatchResult[] = []

  for (const target of targets) {
    const channels = resolveChannels(notification, target)

    for (const channel of channels) {
      try {
        const context = resolveChannelSendContext(notification, channel, target)
        const plan = resolveChannelDispatchPlan(notification, target, channel, input.options)
        const result = plan.queued
          ? await dispatchQueuedNotificationChannel(context, plan)
          : await deliverResolvedNotificationChannel(context)
        results.push(Object.freeze({
          channel,
          targetIndex: target.index,
          queued: plan.queued,
          success: true,
          ...(typeof result === 'undefined' ? {} : { result }),
        }))
      } catch (error) {
        results.push(Object.freeze({
          channel,
          targetIndex: target.index,
          queued: false,
          success: false,
          error,
        }))
      }
    }
  }

  return Object.freeze({
    totalTargets: targets.length,
    channels: Object.freeze(results),
  })
}

class PendingDispatch<TResult = NotificationDispatchResult> implements PendingNotificationDispatch<TResult> {
  #promise?: Promise<TResult>

  constructor(
    private readonly target: DispatchTargetInput,
    private readonly notification: NotificationDefinition,
    private readonly options: MutableDispatchOptions = {},
  ) {}

  onConnection(name: string): PendingNotificationDispatch<TResult> {
    this.options.connection = normalizeOptionalString(name, 'Notification queue connection')
    return this
  }

  onQueue(name: string): PendingNotificationDispatch<TResult> {
    this.options.queue = normalizeOptionalString(name, 'Notification queue name')
    return this
  }

  delay(value: NotificationDelayValue): PendingNotificationDispatch<TResult> {
    this.options.delay = normalizeDelayValue(value, 'Notification delay')
    return this
  }

  delayFor<TChannel extends NotificationChannelName>(
    channel: TChannel,
    value: NotificationDelayValue,
  ): PendingNotificationDispatch<TResult> {
    const normalizedChannel = normalizeOptionalString(channel, 'Notification channel')
    this.options.delayByChannel ??= {}
    this.options.delayByChannel[normalizedChannel] = normalizeDelayValue(value, `Notification delay for channel "${normalizedChannel}"`)
    return this
  }

  afterCommit(): PendingNotificationDispatch<TResult> {
    this.options.afterCommit = true
    return this
  }

  then<TResult1 = TResult, TResult2 = never>(
    onfulfilled?: ((value: TResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.#execute().then(onfulfilled, onrejected)
  }

  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult | TResult1> {
    return this.#execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<TResult> {
    return this.#execute().finally(onfinally ?? undefined)
  }

  #execute(): Promise<TResult> {
    if (!this.#promise) {
      try {
        this.#promise = getDispatchHandler()({
          target: typeof this.target === 'function' ? this.target() : this.target,
          notification: this.notification,
          options: Object.freeze({
            connection: this.options.connection,
            queue: this.options.queue,
            delay: this.options.delay,
            delayByChannel: this.options.delayByChannel ? Object.freeze({ ...this.options.delayByChannel }) : undefined,
            afterCommit: this.options.afterCommit,
          }) satisfies NotificationDispatchOptions,
        } as NotificationDispatchInput) as Promise<TResult>
      } catch (error) {
        this.#promise = Promise.reject(error)
      }
    }

    return this.#promise
  }
}

class AnonymousNotificationBuilder<
  TRoutes extends Partial<{ readonly [TChannel in NotificationChannelName]: NotificationRouteFor<TChannel> }> = Record<never, never>,
> implements PendingAnonymousNotification<TRoutes> {
  readonly target: AnonymousNotificationTarget<TRoutes>

  constructor(routes: TRoutes = {} as TRoutes) {
    this.target = createAnonymousNotificationTarget(routes)
  }

  channel<TChannel extends NotificationChannelName>(
    channel: TChannel,
    route: NotificationRouteFor<TChannel>,
  ): PendingAnonymousNotification<TRoutes & { readonly [TKey in TChannel]: NotificationRouteFor<TChannel> }> {
    const normalizedChannel = normalizeOptionalString(channel, 'Notification channel')
    return new AnonymousNotificationBuilder({
      ...this.target.routes,
      [normalizedChannel]: route,
    } as TRoutes & { readonly [TKey in TChannel]: NotificationRouteFor<TChannel> })
  }

  notify<TNotification extends NotificationDefinition>(
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult> {
    return new PendingDispatch({
      kind: 'anonymous',
      value: this.target,
    }, notification)
  }
}

export interface NotificationRuntimeFacade {
  notify<TNotification extends NotificationDefinition<unknown, NotificationBuildFactories<unknown>>>(
    notifiable: InferNotificationNotifiable<TNotification>,
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult>
  notifyMany<TNotification extends NotificationDefinition<unknown, NotificationBuildFactories<unknown>>>(
    notifiables: readonly InferNotificationNotifiable<TNotification>[] | Iterable<InferNotificationNotifiable<TNotification>>,
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult>
  notifyUsing(): PendingAnonymousNotification
  listNotifications(notifiable: NotificationDatabaseRoute | Record<string, unknown>): Promise<readonly NotificationRecord[]>
  unreadNotifications(notifiable: NotificationDatabaseRoute | Record<string, unknown>): Promise<readonly NotificationRecord[]>
  markNotificationsAsRead(ids: readonly string[]): Promise<number>
  markNotificationsAsUnread(ids: readonly string[]): Promise<number>
  deleteNotifications(ids: readonly string[]): Promise<number>
}

export function configureNotificationsRuntime(bindings?: NotificationRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function getNotificationsRuntimeBindings(): NotificationRuntimeBindings {
  return getRuntimeBindings()
}

export function resetNotificationsRuntime(): void {
  const state = getRuntimeState()
  state.bindings = undefined
  state.loadQueueModule = undefined
  state.loadDbModule = undefined
}

export function notify<TNotification extends NotificationDefinition<unknown, NotificationBuildFactories<unknown>>>(
  notifiable: InferNotificationNotifiable<TNotification>,
  notification: TNotification,
): PendingNotificationDispatch<NotificationDispatchResult> {
  return new PendingDispatch({
    kind: 'notifiable',
    value: notifiable,
  }, notification)
}

export function notifyMany<TNotification extends NotificationDefinition<unknown, NotificationBuildFactories<unknown>>>(
  notifiables: readonly InferNotificationNotifiable<TNotification>[] | Iterable<InferNotificationNotifiable<TNotification>>,
  notification: TNotification,
): PendingNotificationDispatch<NotificationDispatchResult> {
  return new PendingDispatch(() => ({
    kind: 'many',
    value: Object.freeze([...notifiables]),
  }), notification)
}

export function notifyUsing(): PendingAnonymousNotification {
  return new AnonymousNotificationBuilder()
}

export async function listNotifications(
  notifiable: NotificationDatabaseRoute | Record<string, unknown>,
): Promise<readonly NotificationRecord[]> {
  return requireStore(getRuntimeBindings()).list(resolveDatabaseRouteFromNotifiable(notifiable))
}

export async function unreadNotifications(
  notifiable: NotificationDatabaseRoute | Record<string, unknown>,
): Promise<readonly NotificationRecord[]> {
  return requireStore(getRuntimeBindings()).unread(resolveDatabaseRouteFromNotifiable(notifiable))
}

export async function markNotificationsAsRead(ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).markAsRead(normalizeNotificationRecordIds(ids))
}

export async function markNotificationsAsUnread(ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).markAsUnread(normalizeNotificationRecordIds(ids))
}

export async function deleteNotifications(ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).delete(normalizeNotificationRecordIds(ids))
}

export function getNotificationsRuntime(): NotificationRuntimeFacade {
  return Object.freeze({
    notify,
    notifyMany,
    notifyUsing,
    listNotifications,
    unreadNotifications,
    markNotificationsAsRead,
    markNotificationsAsUnread,
    deleteNotifications,
  })
}

export const notificationsRuntimeInternals = {
  HOLO_NOTIFICATIONS_DELIVER_JOB,
  AnonymousNotificationBuilder,
  PendingDispatch,
  builtInChannels,
  createBuildContext,
  createNotificationContext,
  createQueuedDeliveryPayload,
  deferDispatchUntilCommit,
  deliverResolvedNotificationChannel,
  dispatchNotifications,
  dispatchQueuedNotificationChannel,
  ensureNotificationsQueueJobRegistered,
  getDispatchHandler,
  getRuntimeBindings,
  getRuntimeState,
  getNotificationChannel,
  isAnonymousTarget,
  isObject,
  loadDbModule,
  loadQueueModule,
  normalizeBroadcastRouteFromValue,
  normalizeDatabaseRouteFromValue,
  normalizeDelayValue,
  normalizeEmailRouteFromValue,
  normalizeNotificationRecord,
  normalizeNotificationRecordIds,
  normalizeOptionalString,
  resolveBroadcastRouteFromNotifiable,
  resolveChannelDispatchPlan,
  resolveChannels,
  resolveDatabaseRouteFromNotifiable,
  resolveEmailRouteFromNotifiable,
  resolveNotificationDelay,
  resolveNotificationQueueOptions,
  resolvePayload,
  resolveRoute,
  runQueuedNotificationDelivery,
  resolveTargets,
  setDbModuleLoader(loader: (() => Promise<DbModule | null>) | undefined) {
    getRuntimeState().loadDbModule = loader
  },
  setQueueModuleLoader(loader: (() => Promise<QueueModule>) | undefined) {
    getRuntimeState().loadQueueModule = loader
  },
}
