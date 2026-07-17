export interface HoloNotificationsConfig {
  readonly table?: string
  readonly queue?: {
    readonly connection?: string
    readonly queue?: string
    readonly afterCommit?: boolean
  }
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    notifications: NormalizedHoloNotificationsConfig
  }
}

export interface NormalizedHoloNotificationsConfig {
  readonly table: string
  readonly queue: {
    readonly connection?: string
    readonly queue?: string
    readonly afterCommit: boolean
  }
}

export const DEFAULT_NOTIFICATIONS_TABLE = 'notifications'

export const holoNotificationsDefaults: Readonly<NormalizedHoloNotificationsConfig> = Object.freeze({
  table: DEFAULT_NOTIFICATIONS_TABLE,
  queue: Object.freeze({
    connection: undefined,
    queue: undefined,
    afterCommit: false,
  }),
})

function normalizeOptionalString(value: string | undefined, label: string): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/notifications] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

export function defineNotificationsConfig<const TConfig extends HoloNotificationsConfig>(
  config: TConfig,
): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

export function normalizeNotificationsConfig(
  config: HoloNotificationsConfig = {},
): NormalizedHoloNotificationsConfig {
  return Object.freeze({
    table: normalizeOptionalString(config.table, 'Notifications table') ?? DEFAULT_NOTIFICATIONS_TABLE,
    queue: Object.freeze({
      connection: normalizeOptionalString(config.queue?.connection, 'Notifications queue connection'),
      queue: normalizeOptionalString(config.queue?.queue, 'Notifications queue name'),
      afterCommit: config.queue?.afterCommit === true,
    }),
  })
}

registerConfigNormalizer<HoloNotificationsConfig, NormalizedHoloNotificationsConfig>({
  name: 'notifications',
  normalize: normalizeNotificationsConfig,
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
