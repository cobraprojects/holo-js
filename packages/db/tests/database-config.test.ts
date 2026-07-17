import { describe, expect, it } from 'vitest'
import {
  defineDatabaseConfig,
  holoDatabaseDefaults,
  normalizeDatabaseConfig,
} from '../src'

describe('@holo-js/db config', () => {
  it('owns database config definition, defaults, and normalization', () => {
    const config = defineDatabaseConfig({
      defaultConnection: 'primary',
      connections: {
        primary: {
          driver: 'postgres',
          database: 'app',
        },
      },
    })

    expect(Object.isFrozen(config)).toBe(true)
    expect(normalizeDatabaseConfig(config)).toEqual({
      defaultConnection: 'primary',
      connections: config.connections,
    })
    expect(normalizeDatabaseConfig()).toEqual(holoDatabaseDefaults)
    expect(normalizeDatabaseConfig({ connections: {} }).defaultConnection).toBe('default')
  })

  it('uses the first configured connection when no default is provided', () => {
    expect(normalizeDatabaseConfig({
      connections: {
        analytics: 'DATABASE_URL',
      },
    }).defaultConnection).toBe('analytics')
  })
})
