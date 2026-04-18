import { resolve } from 'node:path'
import type { HoloSecurityConfig, NormalizedHoloSecurityConfig } from '@holo-js/config'
import { normalizeSecurityConfig } from '@holo-js/config'
import type { SecurityRateLimitStore, SecurityRateLimitStoreFactoryOptions } from './contracts'
import { createFileRateLimitStore } from './drivers/file'
import { createMemoryRateLimitStore } from './drivers/memory'
import { createRedisRateLimitStore } from './drivers/redis'

function normalizeStoreConfig(config: HoloSecurityConfig | NormalizedHoloSecurityConfig): NormalizedHoloSecurityConfig {
  return normalizeSecurityConfig(config)
}

export function createRateLimitStoreFromConfig(
  config: HoloSecurityConfig | NormalizedHoloSecurityConfig,
  options: SecurityRateLimitStoreFactoryOptions = {},
): SecurityRateLimitStore {
  const normalized = normalizeStoreConfig(config)

  switch (normalized.rateLimit.driver) {
    case 'memory':
      return createMemoryRateLimitStore()
    case 'file': {
      const root = options.projectRoot
        ? resolve(options.projectRoot, normalized.rateLimit.file.path)
        : normalized.rateLimit.file.path

      return createFileRateLimitStore(root)
    }
    case 'redis':
      if (!options.redisAdapter) {
        throw new Error('[@holo-js/security] Redis-backed rate limits require a redis adapter.')
      }

      return createRedisRateLimitStore(options.redisAdapter)
    default:
      throw new Error(`[@holo-js/security] Unsupported rate limit driver "${normalized.rateLimit.driver}".`)
  }
}

export const securityStoreInternals = {
  normalizeStoreConfig,
}
