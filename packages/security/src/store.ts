import { resolve } from 'node:path'
import { normalizeSecurityConfig, type HoloSecurityConfig, type NormalizedHoloSecurityConfig } from './config'
import type { SecurityRateLimitStore, SecurityRateLimitStoreFactoryOptions } from './contracts'
import { createFileRateLimitStore } from './drivers/file'
import { createMemoryRateLimitStore } from './drivers/memory'
import { createRedisRateLimitStore } from './drivers/redis'

type PotentialNormalizedSecurityConfig = {
  readonly rateLimit?: {
    readonly memory?: {
      readonly driver?: unknown
    }
    readonly file?: {
      readonly path?: unknown
    }
    readonly redis?: {
      readonly host?: unknown
      readonly port?: unknown
      readonly db?: unknown
      readonly connection?: unknown
      readonly prefix?: unknown
    }
    readonly limiters?: unknown
  }
}

function isNormalizedSecurityConfig(config: HoloSecurityConfig | NormalizedHoloSecurityConfig): config is NormalizedHoloSecurityConfig {
  const candidate = config as PotentialNormalizedSecurityConfig

  return typeof candidate.rateLimit?.memory?.driver === 'string'
    && candidate.rateLimit.memory.driver === 'memory'
    && typeof candidate.rateLimit.file?.path === 'string'
    && typeof candidate.rateLimit.redis?.host === 'string'
    && typeof candidate.rateLimit.redis.port === 'number'
    && typeof candidate.rateLimit.redis.db === 'number'
    && typeof candidate.rateLimit.redis.connection === 'string'
    && typeof candidate.rateLimit.redis.prefix === 'string'
    && typeof candidate.rateLimit.limiters === 'object'
}

function normalizeStoreConfig(config: HoloSecurityConfig | NormalizedHoloSecurityConfig): NormalizedHoloSecurityConfig {
  return isNormalizedSecurityConfig(config)
    ? config
    : normalizeSecurityConfig(config)
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
