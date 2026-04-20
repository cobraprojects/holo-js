import type { SupportedDatabaseDriver } from './runtime'

export interface HoloProjectPaths {
  models: string
  migrations: string
  generatedSchema: string
  seeders: string
  observers: string
  factories: string
  commands: string
  jobs: string
  events: string
  listeners: string
  authorizationPolicies: string
  authorizationAbilities: string
}

export interface HoloProjectConnectionConfig {
  driver?: SupportedDatabaseDriver
  url?: string
  host?: string
  port?: number | string
  username?: string
  password?: string
  database?: string
  filename?: string
  schema?: string
  ssl?: boolean | Record<string, unknown>
  logging?: boolean
}

export interface HoloProjectDatabaseConfig {
  defaultConnection?: string
  connections?: Record<string, HoloProjectConnectionConfig | string>
}

export interface HoloProjectConfig {
  paths?: Partial<HoloProjectPaths>
  database?: HoloProjectDatabaseConfig
  models?: readonly string[]
  migrations?: readonly string[]
  seeders?: readonly string[]
}

export const DEFAULT_HOLO_PROJECT_PATHS: Readonly<HoloProjectPaths> = Object.freeze({
  models: 'server/models',
  migrations: 'server/db/migrations',
  generatedSchema: 'server/db/schema.generated.ts',
  seeders: 'server/db/seeders',
  observers: 'server/db/observers',
  factories: 'server/db/factories',
  commands: 'server/commands',
  jobs: 'server/jobs',
  events: 'server/events',
  listeners: 'server/listeners',
  authorizationPolicies: 'server/policies',
  authorizationAbilities: 'server/abilities',
})

export interface NormalizedHoloProjectConfig {
  readonly paths: Readonly<HoloProjectPaths>
  readonly database?: HoloProjectDatabaseConfig
  readonly models: readonly string[]
  readonly migrations: readonly string[]
  readonly seeders: readonly string[]
}

export function normalizeHoloProjectConfig(
  config: HoloProjectConfig = {},
): NormalizedHoloProjectConfig {
  return Object.freeze({
    paths: Object.freeze({
      ...DEFAULT_HOLO_PROJECT_PATHS,
      ...(config.paths ?? {}),
    }),
    ...(config.database ? { database: { ...config.database } } : {}),
    models: Object.freeze([...(config.models ?? [])]),
    migrations: Object.freeze([...(config.migrations ?? [])]),
    seeders: Object.freeze([...(config.seeders ?? [])]),
  })
}

export function defineHoloProject<TConfig extends HoloProjectConfig>(
  config: TConfig,
): NormalizedHoloProjectConfig & TConfig {
  return normalizeHoloProjectConfig(config) as NormalizedHoloProjectConfig & TConfig
}
