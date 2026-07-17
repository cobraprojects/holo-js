import type { NotificationDelayValue, NotificationQueueOptions } from './contracts'

export function normalizeOptionalNotificationString(value: string, label: string): string
export function normalizeOptionalNotificationString(value: string | undefined, label: string): string | undefined
export function normalizeOptionalNotificationString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') return undefined

  const normalized = value.trim()
  if (!normalized) throw new Error(`[@holo-js/notifications] ${label} must be a non-empty string.`)
  return normalized
}

export function normalizeNotificationDelay(
  value: NotificationDelayValue,
  label: string,
): NotificationDelayValue {
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

function normalizeOptionalBoolean(value: boolean | undefined, label: string): boolean | undefined {
  if (typeof value === 'undefined') return undefined
  if (typeof value !== 'boolean') throw new Error(`[@holo-js/notifications] ${label} must be a boolean.`)
  return value
}

export function normalizeNotificationQueueOptions(
  value: NotificationQueueOptions | undefined,
): NotificationQueueOptions | undefined {
  if (typeof value === 'undefined') return undefined

  const afterCommit = normalizeOptionalBoolean(value.afterCommit, 'Notification queue afterCommit')
  return Object.freeze({
    connection: normalizeOptionalNotificationString(value.connection, 'Notification queue connection'),
    queue: normalizeOptionalNotificationString(value.queue, 'Notification queue name'),
    ...(typeof value.delay === 'undefined'
      ? {}
      : { delay: normalizeNotificationDelay(value.delay, 'Notification queue delay') }),
    ...(typeof afterCommit === 'undefined' ? {} : { afterCommit }),
  })
}
