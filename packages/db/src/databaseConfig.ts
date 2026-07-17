import type {
  HoloProjectConnectionConfig,
  HoloProjectDatabaseConfig,
} from '@holo-js/kernel'
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'

export type HoloDatabaseConnectionConfig = HoloProjectConnectionConfig
export type HoloDatabaseConfig = HoloProjectDatabaseConfig

export interface NormalizedHoloDatabaseConfig {
  readonly defaultConnection?: string
  readonly connections: Readonly<Record<string, HoloDatabaseConnectionConfig | string>>
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    database: NormalizedHoloDatabaseConfig
  }
}

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

export function defineDatabaseConfig<TConfig extends HoloDatabaseConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

export function normalizeDatabaseConfig(
  config: HoloDatabaseConfig = {},
): NormalizedHoloDatabaseConfig {
  const configuredConnections = config.connections
  const connections = configuredConnections && Object.keys(configuredConnections).length > 0
    ? Object.freeze({ ...configuredConnections })
    : holoDatabaseDefaults.connections
  const defaultConnection = config.defaultConnection ?? Object.keys(connections)[0]

  return Object.freeze({
    defaultConnection: defaultConnection!,
    connections,
  })
}

registerConfigNormalizer<HoloDatabaseConfig, NormalizedHoloDatabaseConfig>({
  name: 'database',
  normalize: normalizeDatabaseConfig,
})
