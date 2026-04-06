import {
  DEFAULT_HOLO_PROJECT_PATHS,
  normalizeHoloProjectConfig,
} from '@holo-js/db'
import {
  normalizeQueueConfig,
  holoQueueDefaults,
} from '@holo-js/queue'
import type {
  NormalizedHoloAppConfig,
  NormalizedHoloDatabaseConfig,
  NormalizedHoloQueueConfig,
  NormalizedHoloStorageConfig,
  HoloAppConfig,
  HoloAppEnv,
  HoloDatabaseConfig,
  HoloQueueConfig,
  HoloStorageConfig,
} from './types'

export const DEFAULT_APP_NAME = 'Holo'

export const holoAppDefaults: Readonly<NormalizedHoloAppConfig> = Object.freeze({
  name: DEFAULT_APP_NAME,
  key: '',
  url: 'http://localhost:3000',
  debug: true,
  env: 'development',
  paths: Object.freeze({ ...DEFAULT_HOLO_PROJECT_PATHS }),
  models: Object.freeze([]),
  migrations: Object.freeze([]),
  seeders: Object.freeze([]),
})

export const holoDatabaseDefaults: Readonly<NormalizedHoloDatabaseConfig> = Object.freeze({
  defaultConnection: 'default',
  connections: Object.freeze({
    default: Object.freeze({
      driver: 'sqlite',
      url: './data/database.sqlite',
      schema: 'public',
      logging: false,
    }),
  }),
})

export const holoStorageDefaults: Readonly<NormalizedHoloStorageConfig> = Object.freeze({
  defaultDisk: 'local',
  routePrefix: '/storage',
  disks: Object.freeze({
    local: Object.freeze({
      driver: 'local',
      root: './storage/app',
    }),
    public: Object.freeze({
      driver: 'public',
      root: './storage/app/public',
      visibility: 'public',
    }),
  }),
})

export const holoQueueDefaultsNormalized: Readonly<NormalizedHoloQueueConfig> = holoQueueDefaults

export function normalizeAppEnv(value: string | undefined, fallback: HoloAppEnv = 'development'): HoloAppEnv {
  if (!value) {
    return fallback
  }

  if (value === 'development' || value === 'production' || value === 'test') {
    return value
  }

  return fallback
}

export function normalizeAppConfig(
  config: HoloAppConfig = {},
): NormalizedHoloAppConfig {
  const project = normalizeHoloProjectConfig(config)
  const rawDebug = (config as { debug?: unknown }).debug
  const debug = typeof rawDebug === 'string'
    ? !['false', '0', 'off', 'no'].includes(rawDebug.trim().toLowerCase())
    : config.debug

  return Object.freeze({
    name: config.name ?? holoAppDefaults.name,
    key: config.key ?? holoAppDefaults.key,
    url: config.url ?? holoAppDefaults.url,
    debug: debug ?? holoAppDefaults.debug,
    env: normalizeAppEnv(config.env, holoAppDefaults.env),
    paths: project.paths,
    models: project.models,
    migrations: project.migrations,
    seeders: project.seeders,
  })
}

export function normalizeDatabaseConfig(
  config: HoloDatabaseConfig = {},
): NormalizedHoloDatabaseConfig {
  const configuredConnections = config.connections
  const connections = configuredConnections && Object.keys(configuredConnections).length > 0
    ? Object.freeze({ ...configuredConnections })
    : holoDatabaseDefaults.connections

  const defaultConnection = config.defaultConnection
    ?? Object.keys(connections)[0]

  return Object.freeze({
    /* v8 ignore next */
    defaultConnection: defaultConnection ?? 'default',
    connections,
  })
}

export function normalizeStorageConfig(
  config: HoloStorageConfig = {},
): NormalizedHoloStorageConfig {
  return Object.freeze({
    defaultDisk: config.defaultDisk ?? holoStorageDefaults.defaultDisk,
    routePrefix: config.routePrefix ?? holoStorageDefaults.routePrefix,
    disks: Object.freeze({
      ...(holoStorageDefaults.disks as Record<string, unknown>),
      ...(config.disks ?? {}),
    }) as NormalizedHoloStorageConfig['disks'],
  })
}

export function normalizeQueueConfigForHolo(
  config: HoloQueueConfig = {},
): NormalizedHoloQueueConfig {
  return normalizeQueueConfig(config)
}
