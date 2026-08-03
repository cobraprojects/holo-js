import { holoNotificationsDefaults } from './config'
import {
  createAnonymousNotificationTarget,
  normalizeNotificationDefinition,
  type AnonymousNotificationTarget,
  type InferNotificationNotifiable,
  type NotificationBuildFactories,
  type NotificationBuildContext,
  type NotificationChannel,
  type NotificationChannelDispatchResult,
  type NotificationChannelName,
  type NotificationDefinition,
  type NotificationDelayValue,
  type NotificationDispatchInput,
  type NotificationDispatchOptions,
  type NotificationDispatchResult,
  type NotificationDispatchTarget,
  type NotificationQueueOptions,
  type NotificationPage,
  type NotificationPagination,
  type NotificationQuery,
  type NotificationRouteFor,
  type NotificationRuntimeBindings,
  type NotificationSendContext,
  type PendingAnonymousNotification,
  type PendingNotificationDispatch,
} from './contracts'
import { getRegisteredNotificationChannel } from './registry'
import { loadNotificationPluginChannels, resetNotificationPluginChannels } from './plugins'
import {
  normalizeNotificationDelay,
  normalizeNotificationQueueOptions,
  normalizeOptionalNotificationString,
} from './queueOptions'
import {
  createBuildContext,
  createBuiltInChannels,
  createNotificationContext,
  isAnonymousTarget,
  isObject,
  normalizeBroadcastRouteFromValue,
  normalizeDatabaseRouteFromValue,
  normalizeEmailRouteFromValue,
  normalizeNotificationRecord,
  normalizeNotificationRecordIds,
  normalizeNotificationPagination,
  normalizeNotificationQuery,
  requireStore,
  resolveBroadcastRouteFromNotifiable,
  resolveDatabaseRouteFromNotifiable,
  resolveEmailRouteFromNotifiable,
  type BuiltInChannelDefinition,
} from './runtime-channels'

const HOLO_NOTIFICATIONS_DELIVER_JOB = 'holo.notifications.deliver'

const normalizeOptionalString = normalizeOptionalNotificationString
const normalizeDelayValue = normalizeNotificationDelay
const normalizeQueueOptions = normalizeNotificationQueueOptions

function normalizeDeduplicationKey(value: string): string {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,200}$/u.test(value)) {
    throw new Error('[@holo-js/notifications] Notification deduplication keys must contain between 1 and 200 printable ASCII characters.')
  }

  return value
}

function getRuntimeBindings(): NotificationRuntimeBindings {
  return getRuntimeState().bindings ?? {}
}

type RuntimeState = {
  bindings?: NotificationRuntimeBindings
  projectRoot?: string
  pluginNames?: readonly string[]
  loadQueueModule?: () => Promise<QueueModule>
}

type RuntimeBindingsWithProjectRoot = NotificationRuntimeBindings & {
  readonly projectRoot?: string
  readonly plugins?: readonly string[]
}

type ResolvedTargetChannels = {
  readonly target: ResolvedTarget
  readonly channels: readonly string[]
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
  return import(/* @vite-ignore */ /* webpackIgnore: true */ specifier) as Promise<TModule>
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

  /* v8 ignore start -- native optional-peer import failure is covered through loader override tests. */
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
  /* v8 ignore stop */
}

type MutableDispatchOptions = {
  connection?: string
  queue?: string
  delay?: NotificationDelayValue
  delayByChannel?: Record<string, NotificationDelayValue>
  afterCommit?: boolean
  deduplicationKey?: string
}

type DispatchTargetInput = NotificationDispatchTarget | (() => NotificationDispatchTarget)

type ResolvedTarget = {
  readonly index: number
  readonly anonymous: boolean
  readonly notifiable: unknown
  readonly routes?: Record<string, unknown>
}

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

type QueuedNotificationDeliveryPayload = Readonly<{
  readonly channel: string
  readonly anonymous: boolean
  readonly notifiable: unknown
  readonly route?: unknown
  readonly notificationType?: string
  readonly payload: unknown
  readonly targetIndex: number
  readonly deduplicationKey?: string
}>

const builtInChannels = createBuiltInChannels(getRuntimeBindings)

function getNotificationChannel(name: string): NotificationChannel | BuiltInChannelDefinition | undefined {
  const registered = getRegisteredNotificationChannel(name)?.channel
  if (registered) {
    return registered
  }

  if (name in builtInChannels) {
    return builtInChannels[name as keyof typeof builtInChannels]
  }

  return undefined
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

function resolveRegisteredChannels(
  channels: readonly string[],
): readonly string[] {
  return Object.freeze(channels.map((channel) => {
    if (!getNotificationChannel(channel)) {
      throw new Error(`[@holo-js/notifications] Notification channel "${channel}" is not registered.`)
    }

    return channel
  }))
}

function resolveDeclaredChannels(
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

    return normalizeOptionalString(channel, 'Notification channel')
  }))
}

function resolveChannels(
  notification: NotificationDefinition,
  target: ResolvedTarget,
): readonly string[] {
  return resolveRegisteredChannels(resolveDeclaredChannels(notification, target))
}

function resolveTargetChannels(
  notification: NotificationDefinition,
  targets: readonly ResolvedTarget[],
): readonly ResolvedTargetChannels[] {
  return Object.freeze(targets.map(target => Object.freeze({
    target,
    channels: resolveDeclaredChannels(notification, target),
  })))
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
): boolean | NotificationQueueOptions {
  const queue = typeof notification.queue === 'function'
    ? notification.queue(
      target.notifiable,
      channel as NotificationChannelName,
      createNotificationContext(target.anonymous),
    )
    : notification.queue ?? false

  if (typeof queue === 'boolean') {
    return queue
  }

  return normalizeQueueOptions(queue) ?? false
}

function resolveNotificationDelay(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
): NotificationDelayValue | undefined {
  if (typeof notification.delay === 'function') {
    const delay = notification.delay(
      target.notifiable,
      channel as NotificationChannelName,
      createNotificationContext(target.anonymous),
    )

    return typeof delay === 'undefined'
      ? undefined
      : normalizeDelayValue(delay, 'Notification delay')
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
    const registered = getRegisteredNotificationChannel(channel)?.channel
    if (registered) {
      return typeof registered.validateRoute === 'function'
        ? registered.validateRoute(route)
        : route
    }

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

  const queued = notificationQueue === true
    || Boolean(notificationQueueOptions)
    || typeof options.connection !== 'undefined'
    || typeof options.queue !== 'undefined'
    || typeof resolvedDelay !== 'undefined'
  const resolvedConnection = queued
    ? options.connection
      ?? notificationQueueOptions?.connection
      ?? config.queue.connection
    : undefined
  const resolvedQueue = queued
    ? options.queue
      ?? notificationQueueOptions?.queue
      ?? config.queue.queue
    : undefined
  const afterCommit = options.afterCommit
    ?? notificationQueueOptions?.afterCommit
    ?? (queued ? config.queue.afterCommit : false)

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
  deduplicationKey?: string,
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

  if (deduplicationKey !== undefined) {
    if (!('sendDeduplicated' in definition) || typeof definition.sendDeduplicated !== 'function') {
      throw new Error('[@holo-js/notifications] Notification deduplication requires the built-in database channel.')
    }

    return await definition.sendDeduplicated(runtimeContext, deduplicationKey)
  }

  return await definition.send(runtimeContext)
}

function createQueuedDeliveryPayload(
  context: NotificationSendContext,
  deduplicationKey?: string,
): QueuedNotificationDeliveryPayload {
  return Object.freeze({
    channel: context.channel,
    anonymous: context.anonymous,
    notifiable: context.notifiable,
    ...(typeof context.route === 'undefined' ? {} : { route: context.route }),
    ...(typeof context.notificationType === 'undefined' ? {} : { notificationType: context.notificationType }),
    payload: context.payload,
    targetIndex: context.targetIndex,
    ...(deduplicationKey === undefined ? {} : { deduplicationKey }),
  })
}

async function runQueuedNotificationDelivery(
  payload: QueuedNotificationDeliveryPayload,
): Promise<unknown> {
  if (!getNotificationChannel(payload.channel)) {
    const state = getRuntimeState()
    await loadNotificationPluginChannels(state.projectRoot, state.pluginNames)
  }

  return await deliverResolvedNotificationChannel(Object.freeze({
    channel: payload.channel,
    anonymous: payload.anonymous,
    notifiable: payload.notifiable,
    route: payload.route,
    notificationType: payload.notificationType,
    payload: payload.payload,
    targetIndex: payload.targetIndex,
  }), payload.deduplicationKey)
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
  deduplicationKey?: string,
): Promise<void> {
  const queueModule = await ensureNotificationsQueueJobRegistered()
  let pending = queueModule.dispatch(
    HOLO_NOTIFICATIONS_DELIVER_JOB,
    createQueuedDeliveryPayload(context, deduplicationKey),
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
  notification: NotificationDefinition,
  targetChannels: readonly ResolvedTargetChannels[],
): Promise<NotificationDispatchResult | null> {
  const deferAfterCommit = getRuntimeBindings().deferAfterCommit
  if (!deferAfterCommit) {
    return null
  }

  const channels: NotificationChannelDispatchResult[] = []
  for (const { target, channels: resolvedChannels } of targetChannels) {
    for (const channel of resolvedChannels) {
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

  const deferred = deferAfterCommit(async () => {
    await dispatchNotifications(input, { allowAfterCommitDeferral: false })
  })
  if (!deferred) {
    return null
  }

  return Object.freeze({
    totalTargets: targetChannels.length,
    channels: Object.freeze(channels),
    deferred: true,
  })
}

function shouldDeferDispatchAfterCommit(
  notification: NotificationDefinition,
  targetChannels: readonly ResolvedTargetChannels[],
  options: NotificationDispatchOptions,
): boolean {
  if (options.afterCommit) {
    return true
  }

  return targetChannels.some(({ target, channels }) => channels.some(channel => {
    try {
      return resolveChannelDispatchPlan(notification, target, channel, options).afterCommit
    } catch {
      return false
    }
  }))
}

async function dispatchNotifications(
  input: NotificationDispatchInput,
  execution: DispatchExecutionOptions = {},
): Promise<NotificationDispatchResult> {
  const notification = normalizeNotificationDefinition(input.notification)
  const targets = resolveTargets(input.target)
  const declaredTargetChannels = resolveTargetChannels(notification, targets)
  if (hasUnresolvedNotificationChannels(declaredTargetChannels)) {
    const state = getRuntimeState()
    await loadNotificationPluginChannels(state.projectRoot, state.pluginNames)
  }
  const targetChannels = resolveRegisteredTargetChannels(declaredTargetChannels)
  const deduplicationKey = input.options.deduplicationKey === undefined
    ? undefined
    : normalizeDeduplicationKey(input.options.deduplicationKey)

  if (deduplicationKey !== undefined) {
    const channels = targetChannels.flatMap(target => target.channels)
    const databaseChannel = getNotificationChannel('database')
    if (
      channels.length === 0
      || channels.some(channel => channel !== 'database')
      || !databaseChannel
      || !('sendDeduplicated' in databaseChannel)
      || typeof databaseChannel.sendDeduplicated !== 'function'
    ) {
      throw new Error('[@holo-js/notifications] Notification deduplication requires every resolved channel to be the built-in database channel.')
    }
  }

  if (execution.allowAfterCommitDeferral !== false && shouldDeferDispatchAfterCommit(notification, targetChannels, input.options)) {
    const deferredResult = await deferDispatchUntilCommit(input, notification, targetChannels)
    if (deferredResult) {
      return deferredResult
    }
  }

  const results: NotificationChannelDispatchResult[] = []

  for (const { target, channels } of targetChannels) {
    for (const channel of channels) {
      try {
        const context = resolveChannelSendContext(notification, channel, target)
        const plan = resolveChannelDispatchPlan(notification, target, channel, input.options)
        const result = plan.queued
          ? await dispatchQueuedNotificationChannel(context, plan, deduplicationKey)
          : await deliverResolvedNotificationChannel(context, deduplicationKey)
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

function hasUnresolvedNotificationChannels(
  targetChannels: readonly ResolvedTargetChannels[],
): boolean {
  return targetChannels.some(({ channels }) => channels.some(channel => !getNotificationChannel(channel)))
}

function resolveRegisteredTargetChannels(
  targetChannels: readonly ResolvedTargetChannels[],
): readonly ResolvedTargetChannels[] {
  return Object.freeze(targetChannels.map(({ target, channels }) => Object.freeze({
    target,
    channels: resolveRegisteredChannels(channels),
  })))
}

class PendingDispatch<TResult = NotificationDispatchResult> implements PendingNotificationDispatch<TResult> {
  #promise?: Promise<TResult>

  constructor(
    private readonly target: DispatchTargetInput,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must accept any NotificationDefinition variant
    private readonly notification: NotificationDefinition<any, any>,
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

  deduplicate(key: string): this {
    this.options.deduplicationKey = normalizeDeduplicationKey(key)
    return this
  }

  dispatch(): Promise<TResult> {
    return this.#execute()
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
            ...(this.options.deduplicationKey === undefined ? {} : { deduplicationKey: this.options.deduplicationKey }),
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
  ): PendingAnonymousNotification<Readonly<Omit<TRoutes, TChannel> & { readonly [TKey in TChannel]: NotificationRouteFor<TChannel> }>> {
    const normalizedChannel = normalizeOptionalString(channel, 'Notification channel')
    return new AnonymousNotificationBuilder({
      ...this.target.routes,
      [normalizedChannel]: route,
    } as Readonly<Omit<TRoutes, TChannel> & { readonly [TKey in TChannel]: NotificationRouteFor<TChannel> }>)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must accept any NotificationDefinition variant
  notify<TNotification extends NotificationDefinition<any, any>>(
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult> {
    return new PendingDispatch({
      kind: 'anonymous',
      value: this.target,
    }, notification)
  }
}

export interface NotificationRuntimeFacade {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- notify must accept any NotificationDefinition variant without TBuild variance issues
  notify<TNotification extends NotificationDefinition<any, any>>(
    notifiable: InferNotificationNotifiable<TNotification>,
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- notifyMany must accept any NotificationDefinition variant without TBuild variance issues
  notifyMany<TNotification extends NotificationDefinition<any, any>>(
    notifiables: readonly InferNotificationNotifiable<TNotification>[] | Iterable<InferNotificationNotifiable<TNotification>>,
    notification: TNotification,
  ): PendingNotificationDispatch<NotificationDispatchResult>
  notifyUsing(): PendingAnonymousNotification
  listNotifications(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
  unreadNotifications(query: NotificationQuery, pagination: NotificationPagination): Promise<NotificationPage>
  markNotificationsAsRead(query: NotificationQuery, ids: readonly string[]): Promise<number>
  markNotificationsAsUnread(query: NotificationQuery, ids: readonly string[]): Promise<number>
  deleteNotifications(query: NotificationQuery, ids: readonly string[]): Promise<number>
}

export function configureNotificationsRuntime(bindings?: NotificationRuntimeBindings): void {
  const state = getRuntimeState()
  if (!bindings) {
    state.bindings = undefined
    state.projectRoot = undefined
    state.pluginNames = undefined
    return
  }

  const { projectRoot, plugins, ...runtimeBindings } = bindings as RuntimeBindingsWithProjectRoot
  state.bindings = runtimeBindings
  const normalizedProjectRoot = typeof projectRoot === 'string' ? projectRoot.trim() : ''
  state.projectRoot = normalizedProjectRoot
    ? normalizedProjectRoot
    : undefined
  state.pluginNames = Object.freeze([...new Set((plugins ?? [])
    .map(plugin => plugin.trim())
    .filter(plugin => plugin.length > 0))])
}

export function getNotificationsRuntimeBindings(): NotificationRuntimeBindings {
  return getRuntimeBindings()
}

export function resetNotificationsRuntime(): void {
  const state = getRuntimeState()
  state.bindings = undefined
  state.projectRoot = undefined
  state.pluginNames = undefined
  state.loadQueueModule = undefined
  resetNotificationPluginChannels()
}

type NotificationDefinitionLike<TNotification>
  = TNotification extends NotificationDefinition<infer _TNotifiable, infer _TBuild>
    ? TNotification
    : never

export function notify<
  TNotifiable,
  TBuild extends NotificationBuildFactories<TNotifiable>,
>(
  notifiable: TNotifiable,
  notification: NotificationDefinition<TNotifiable, TBuild>,
): PendingNotificationDispatch<NotificationDispatchResult>

export function notify<TNotification>(
  notifiable: InferNotificationNotifiable<TNotification>,
  notification: NotificationDefinitionLike<TNotification>,
): PendingNotificationDispatch<NotificationDispatchResult>

export function notify(
  notifiable: unknown,
  notification: NotificationDefinition,
): PendingNotificationDispatch<NotificationDispatchResult> {
  return new PendingDispatch({
    kind: 'notifiable',
    value: notifiable,
  }, notification)
}

export function notifyMany<TNotification>(
  notifiables: readonly InferNotificationNotifiable<TNotification>[] | Iterable<InferNotificationNotifiable<TNotification>>,
  notification: NotificationDefinitionLike<TNotification>,
): PendingNotificationDispatch<NotificationDispatchResult>

export function notifyMany(
  notifiables: readonly unknown[] | Iterable<unknown>,
  notification: NotificationDefinition,
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
  query: NotificationQuery,
  pagination: NotificationPagination,
): Promise<NotificationPage> {
  return requireStore(getRuntimeBindings()).list(normalizeNotificationQuery(query), normalizeNotificationPagination(pagination))
}

export async function unreadNotifications(
  query: NotificationQuery,
  pagination: NotificationPagination,
): Promise<NotificationPage> {
  return requireStore(getRuntimeBindings()).unread(normalizeNotificationQuery(query), normalizeNotificationPagination(pagination))
}

export async function markNotificationsAsRead(query: NotificationQuery, ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).markAsRead(normalizeNotificationQuery(query), normalizeNotificationRecordIds(ids))
}

export async function markNotificationsAsUnread(query: NotificationQuery, ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).markAsUnread(normalizeNotificationQuery(query), normalizeNotificationRecordIds(ids))
}

export async function deleteNotifications(query: NotificationQuery, ids: readonly string[]): Promise<number> {
  return requireStore(getRuntimeBindings()).delete(normalizeNotificationQuery(query), normalizeNotificationRecordIds(ids))
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
  loadQueueModule,
  normalizeBroadcastRouteFromValue,
  normalizeDatabaseRouteFromValue,
  normalizeDelayValue,
  normalizeEmailRouteFromValue,
  normalizeNotificationRecord,
  normalizeNotificationRecordIds,
  normalizeNotificationPagination,
  normalizeNotificationQuery,
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
  setQueueModuleLoader(loader: (() => Promise<QueueModule>) | undefined) {
    getRuntimeState().loadQueueModule = loader
  },
}
