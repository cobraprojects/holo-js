import { holoNotificationsDefaults, type NormalizedHoloNotificationsConfig } from './config'
import type {
  NotificationChannelDispatchResult,
  NotificationChannelName,
  NotificationDefinition,
  NotificationDelayValue,
  NotificationDispatchOptions,
  NotificationDispatchResult,
  NotificationQueueOptions,
  NotificationRuntimeBindings,
  NotificationSendContext,
} from './contracts'
import { createNotificationContext } from './runtime-channels'
import {
  normalizeNotificationDelay as normalizeDelayValue,
  normalizeNotificationQueueOptions as normalizeQueueOptions,
} from './queueOptions'

export type ResolvedTarget = {
  readonly index: number
  readonly anonymous: boolean
  readonly notifiable: unknown
  readonly routes?: Record<string, unknown>
}

export type ResolvedTargetChannels = {
  readonly target: ResolvedTarget
  readonly channels: readonly string[]
}

export type ResolvedChannelPlan = {
  readonly channel: string
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly delay?: NotificationDelayValue
  readonly afterCommit: boolean
}

type PlannedDelivery = {
  readonly target: ResolvedTarget
  readonly channel: string
} & (
  | { readonly success: true, readonly plan: ResolvedChannelPlan }
  | { readonly success: false, readonly error: unknown }
)

type DeliveryAdapter = {
  createContext(notification: NotificationDefinition, channel: string, target: ResolvedTarget): NotificationSendContext
  send(context: NotificationSendContext, deduplicationKey?: string): Promise<unknown>
  enqueue(context: NotificationSendContext, plan: ResolvedChannelPlan, deduplicationKey?: string): Promise<void>
}

export function resolveNotificationQueueOptions(
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

export function resolveNotificationDelay(
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

function resolveChannelDispatchPlan(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
  options: NotificationDispatchOptions,
  config: NormalizedHoloNotificationsConfig,
): ResolvedChannelPlan {
  const notificationQueue = resolveNotificationQueueOptions(notification, target, channel)
  const notificationQueueOptions = notificationQueue && notificationQueue !== true
    ? notificationQueue
    : undefined

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
    delay: queued && resolvedDelay instanceof Date
      ? new Date(resolvedDelay.getTime())
      : queued ? resolvedDelay : undefined,
    afterCommit,
  })
}

function planDelivery(
  notification: NotificationDefinition,
  target: ResolvedTarget,
  channel: string,
  options: NotificationDispatchOptions,
  config: NormalizedHoloNotificationsConfig,
): PlannedDelivery {
  try {
    return {
      target,
      channel,
      success: true,
      plan: resolveChannelDispatchPlan(notification, target, channel, options, config),
    }
  } catch (error) {
    return { target, channel, success: false, error }
  }
}

export async function dispatchNotificationDelivery(
  input: {
    readonly notification: NotificationDefinition
    readonly targetChannels: readonly ResolvedTargetChannels[]
    readonly options: NotificationDispatchOptions
  },
  bindings: NotificationRuntimeBindings,
  adapter: DeliveryAdapter,
): Promise<NotificationDispatchResult> {
  const { notification, targetChannels, options } = input
  const config = bindings.config ?? holoNotificationsDefaults
  const deliveries = targetChannels.flatMap(({ target, channels }) => channels.map(channel =>
    planDelivery(notification, target, channel, options, config),
  ))

  async function execute(): Promise<NotificationDispatchResult> {
    const results: NotificationChannelDispatchResult[] = []
    for (const delivery of deliveries) {
      const { target, channel } = delivery
      try {
        if (!delivery.success) {
          throw delivery.error
        }

        const context = adapter.createContext(notification, channel, target)
        const { plan } = delivery
        const result = plan.queued
          ? await adapter.enqueue(context, plan, options.deduplicationKey)
          : await adapter.send(context, options.deduplicationKey)
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

    return Object.freeze({
      totalTargets: targetChannels.length,
      channels: Object.freeze(results),
    })
  }

  const afterCommit = options.afterCommit
    || deliveries.some(delivery => delivery.success && delivery.plan.afterCommit)
  if (afterCommit && bindings.deferAfterCommit) {
    const channels = deliveries.map((delivery): NotificationChannelDispatchResult => {
      if (!delivery.success) {
        throw delivery.error
      }

      return Object.freeze({
        channel: delivery.channel,
        targetIndex: delivery.target.index,
        queued: delivery.plan.queued,
        deferred: true,
        success: true,
      })
    })
    const deferred = bindings.deferAfterCommit(async () => {
      await execute()
    })
    if (deferred) {
      return Object.freeze({
        totalTargets: targetChannels.length,
        channels: Object.freeze(channels),
        deferred: true,
      })
    }
  }

  return await execute()
}
