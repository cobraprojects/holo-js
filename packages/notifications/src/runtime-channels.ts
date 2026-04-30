import { randomUUID } from 'node:crypto'
import type {
  AnonymousNotificationTarget,
  NotificationBroadcastMessage,
  NotificationBroadcastRoute,
  NotificationBuildContext,
  NotificationChannel,
  NotificationDatabaseMessage,
  NotificationDatabaseRoute,
  NotificationEmailRoute,
  NotificationMailMessage,
  NotificationRecord,
  NotificationRuntimeBindings,
  NotificationSendContext,
} from './contracts'

export type RouteResolver = (notifiable: unknown) => unknown

export type BuiltInChannelDefinition = NotificationChannel & {
  readonly resolveRoute?: RouteResolver
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isAnonymousTarget(value: unknown): value is AnonymousNotificationTarget {
  return isObject(value)
    && value.anonymous === true
    && isObject(value.routes)
}

export function createNotificationContext(anonymous: boolean): { readonly anonymous: boolean } {
  return Object.freeze({ anonymous })
}

export function createBuildContext<TChannel extends string>(
  channel: TChannel,
  anonymous: boolean,
): NotificationBuildContext<TChannel> {
  return Object.freeze({
    channel,
    anonymous,
  })
}

export function normalizeEmailRouteFromValue(
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

export function resolveEmailRouteFromNotifiable(notifiable: unknown): NotificationEmailRoute {
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

export function normalizeDatabaseRouteFromValue(
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

export function resolveDatabaseRouteFromNotifiable(notifiable: unknown): NotificationDatabaseRoute {
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

export function normalizeBroadcastRouteFromValue(
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

export function resolveBroadcastRouteFromNotifiable(notifiable: unknown): NotificationBroadcastRoute {
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

export function normalizeNotificationRecord(
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

export function requireStore(bindings: NotificationRuntimeBindings) {
  if (!bindings.store) {
    throw new Error('[@holo-js/notifications] Database notifications require a configured notification store runtime.')
  }

  return bindings.store
}

export function normalizeNotificationRecordIds(ids: readonly string[]): readonly string[] {
  const normalized = ids.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`[@holo-js/notifications] Notification id at index ${index} must be a non-empty string.`)
    }

    return value.trim()
  })

  return Object.freeze([...new Set(normalized)])
}

export function createBuiltInChannels(
  getBindings: () => NotificationRuntimeBindings,
): Readonly<Record<'email' | 'database' | 'broadcast', BuiltInChannelDefinition>> {
  return Object.freeze({
    email: Object.freeze({
      resolveRoute: resolveEmailRouteFromNotifiable,
      async send(input: NotificationSendContext) {
        await requireMailer(getBindings()).send(
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

        await requireStore(getBindings()).create(
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
        await requireBroadcaster(getBindings()).send(
          input.payload as NotificationBroadcastMessage,
          input as NotificationSendContext<NotificationBroadcastRoute, NotificationBroadcastMessage>,
        )
      },
    }),
  })
}
