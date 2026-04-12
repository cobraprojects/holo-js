import type {
  NotificationChannel,
  RegisterNotificationChannelOptions,
  RegisteredNotificationChannel,
} from './contracts'

function normalizeChannelName(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('[@holo-js/notifications] Notification channel names must be non-empty strings.')
  }

  return normalized
}

function getRegistry(): Map<string, RegisteredNotificationChannel> {
  const runtime = globalThis as typeof globalThis & {
    __holoNotificationChannelRegistry__?: Map<string, RegisteredNotificationChannel>
  }

  runtime.__holoNotificationChannelRegistry__ ??= new Map()
  return runtime.__holoNotificationChannelRegistry__
}

export function registerNotificationChannel<TChannel extends string>(
  name: TChannel,
  channel: NotificationChannel,
  options: RegisterNotificationChannelOptions = {},
): void {
  const normalizedName = normalizeChannelName(name)

  if (typeof channel?.send !== 'function') {
    throw new Error(`[@holo-js/notifications] Notification channel "${normalizedName}" must define send().`)
  }

  const registry = getRegistry()
  if (registry.has(normalizedName) && options.replaceExisting !== true) {
    throw new Error(`[@holo-js/notifications] Notification channel "${normalizedName}" is already registered.`)
  }

  registry.set(normalizedName, Object.freeze({
    name: normalizedName,
    channel,
  }))
}

export function getRegisteredNotificationChannel<TChannel extends string>(
  name: TChannel,
): RegisteredNotificationChannel<TChannel> | undefined {
  return getRegistry().get(normalizeChannelName(name)) as RegisteredNotificationChannel<TChannel> | undefined
}

export function listRegisteredNotificationChannels(): readonly RegisteredNotificationChannel[] {
  return Object.freeze([...getRegistry().values()])
}

export function resetNotificationChannelRegistry(): void {
  getRegistry().clear()
}

export const notificationRegistryInternals = {
  getRegistry,
  normalizeChannelName,
}
