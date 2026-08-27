import { createHash, randomUUID } from 'node:crypto'
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
  NotificationPagination,
  NotificationQuery,
  NotificationRecord,
  NotificationRuntimeBindings,
  NotificationSendContext,
} from './contracts'

export type RouteResolver = (notifiable: unknown) => unknown

export type BuiltInChannelDefinition = NotificationChannel & {
  readonly resolveRoute?: RouteResolver
  readonly sendDeduplicated?: (input: NotificationSendContext, key: string) => Promise<void>
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
  if (!isObject(value)) throw new Error('[@holo-js/notifications] Database routes must be objects.')

  const id = typeof value.id === 'string' ? value.id.trim() : value.id
  if (
    (typeof id === 'string' && (!id || id.length > 200))
    || (typeof id === 'number' && !Number.isFinite(id))
    || (typeof id !== 'string' && typeof id !== 'number')
  ) throw new Error('[@holo-js/notifications] Database route ids must be non-empty strings of at most 200 characters or finite numbers.')

  const type = typeof value.type === 'string' ? value.type.trim() : ''
  if (!type || type.length > 200) {
    throw new Error('[@holo-js/notifications] Database route types must be between 1 and 200 characters.')
  }

  return Object.freeze({
    id,
    type,
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
    return normalizeDatabaseRouteFromValue({
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

  return normalizeDatabaseRouteFromValue({
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
  id: string = randomUUID(),
): NotificationRecord {
  const now = new Date()
  return Object.freeze({
    id,
    type: notificationType,
    notifiableType: route.type,
    notifiableId: route.id,
    data: payload.data,
    readAt: null,
    createdAt: now,
    updatedAt: now,
  })
}

function deduplicatedNotificationId(
  key: string,
  route: NotificationDatabaseRoute,
  notificationType: string | undefined,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify([key, route.type, String(route.id), notificationType ?? null]))
    .digest('hex')
  const variant = ((Number.parseInt(hash.charAt(16), 16) & 3) | 8).toString(16)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
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
  if (ids.length > 100) {
    throw new Error('[@holo-js/notifications] Notification mutations accept at most 100 ids.')
  }
  const normalized = ids.map((value, index) => {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`[@holo-js/notifications] Notification id at index ${index} must be a non-empty string.`)
    }

    return value.trim()
  })

  return Object.freeze([...new Set(normalized)])
}

const NOTIFICATION_DATA_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/u

export function normalizeNotificationQuery(query: NotificationQuery): NotificationQuery {
  if (!isObject(query)) {
    throw new Error('[@holo-js/notifications] Notification queries must be objects.')
  }
  const recipient = normalizeDatabaseRouteFromValue(query.recipient)
  const rawId: unknown = query.id
  if (rawId !== undefined && (typeof rawId !== 'string' || !rawId.trim() || rawId.trim().length > 200)) {
    throw new Error('[@holo-js/notifications] Notification query ids must be between 1 and 200 characters.')
  }
  const id = typeof rawId === 'string' ? rawId.trim() : undefined
  const rawType: unknown = query.type
  if (typeof rawType !== 'undefined' && typeof rawType !== 'string') {
    throw new Error('[@holo-js/notifications] Notification query types must be strings when provided.')
  }
  const type = typeof rawType === 'string' ? rawType.trim() : undefined
  if (typeof rawType !== 'undefined' && (!type || type.length > 200)) {
    throw new Error('[@holo-js/notifications] Notification query types must be between 1 and 200 characters.')
  }
  const matches = query.dataMatches ?? []
  if (!Array.isArray(matches) || matches.length > 32) {
    throw new Error('[@holo-js/notifications] Notification queries accept at most 32 data matches.')
  }
  const paths = new Set<string>()
  const dataMatches = matches.map((match, matchIndex) => {
    if (!isObject(match) || !Array.isArray(match.path) || match.path.length < 1 || match.path.length > 16) {
      throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} requires between 1 and 16 path segments.`)
    }
    const path = match.path.map((segment, segmentIndex) => {
      if (typeof segment !== 'string' || !NOTIFICATION_DATA_PATH_SEGMENT.test(segment) || segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
        throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} path segment ${segmentIndex} is invalid.`)
      }
      return segment
    })
    const pathKey = JSON.stringify(path)
    if (paths.has(pathKey)) {
      throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} duplicates an existing path.`)
    }
    paths.add(pathKey)
    const value = match.value
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} values must be JSON scalars.`)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} numeric values must be finite.`)
    }
    if (typeof value === 'string' && value.length > 4_096) {
      throw new Error(`[@holo-js/notifications] Notification data match ${matchIndex} string values cannot exceed 4096 characters.`)
    }
    return Object.freeze({ path: Object.freeze(path), value })
  })
  return Object.freeze({
    recipient,
    ...(id === undefined ? {} : { id }),
    ...(type ? { type } : {}),
    ...(dataMatches.length > 0 ? { dataMatches: Object.freeze(dataMatches) } : {}),
  })
}

export function normalizeNotificationPagination(pagination: NotificationPagination): NotificationPagination {
  if (!isObject(pagination) || !Number.isSafeInteger(pagination.limit) || pagination.limit < 1 || pagination.limit > 100) {
    throw new Error('[@holo-js/notifications] Notification pagination limits must be integers between 1 and 100.')
  }
  if (!Number.isSafeInteger(pagination.offset) || pagination.offset < 0 || pagination.offset > 1_000_000) {
    throw new Error('[@holo-js/notifications] Notification pagination offsets must be integers between 0 and 1000000.')
  }
  return Object.freeze({ limit: pagination.limit, offset: pagination.offset })
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
      async sendDeduplicated(input: NotificationSendContext, key: string) {
        const route = input.route as NotificationDatabaseRoute | undefined
        if (!route) {
          throw new Error('[@holo-js/notifications] Database notifications require a resolved route.')
        }

        await requireStore(getBindings()).create(
          normalizeNotificationRecord(
            route,
            input.payload as NotificationDatabaseMessage,
            input.notificationType,
            deduplicatedNotificationId(key, route, input.notificationType),
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
