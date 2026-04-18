import { randomUUID } from 'node:crypto'
import type { NormalizedSecurityRateLimitRedisConfig } from '@holo-js/config'
import Redis from 'ioredis'
import type { SecurityRateLimitRedisDriverAdapter } from '../contracts'

export interface SecurityRedisAdapterOptions {
  readonly now?: () => Date
}

type RedisClientOptions = {
  readonly host?: string
  readonly port?: number
  readonly password?: string
  readonly username?: string
  readonly db?: number
  readonly connectionName?: string
  readonly lazyConnect: true
  readonly maxRetriesPerRequest: number
}

const REDIS_SCAN_COUNT = 100

function isRedisConnectionTarget(value: string): boolean {
  return value.startsWith('redis://')
    || value.startsWith('rediss://')
    || value.startsWith('unix://')
    || value.startsWith('/')
}

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://')
    || value.startsWith('/')
}

function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, match => `\\${match}`)
}

type RedisCommandTuple = readonly [unknown, unknown]

function createRedisClientOptions(
  config: NormalizedSecurityRateLimitRedisConfig,
): RedisClientOptions {
  return {
    password: config.password,
    username: config.username,
    db: config.db,
    ...(!isRedisConnectionTarget(config.connection)
      ? {
          host: config.host,
          port: config.port,
        }
      : {}),
    ...(config.connection !== 'default' && !isRedisConnectionTarget(config.connection)
      ? { connectionName: config.connection }
      : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }
}

export class RedisSecurityAdapter implements SecurityRateLimitRedisDriverAdapter {
  private readonly client: Redis
  private readonly now: () => Date
  private readonly prefix: string

  constructor(config: NormalizedSecurityRateLimitRedisConfig, options: SecurityRedisAdapterOptions = {}) {
    this.prefix = config.prefix
    this.now = options.now ?? (() => new Date())
    const clientOptions = createRedisClientOptions(config)
    this.client = isRedisConnectionTarget(config.connection)
      ? new Redis(config.connection, clientOptions)
      : new Redis(clientOptions)
  }

  private qualifyKey(key: string): string {
    return `${this.prefix}${key}`
  }

  private qualifyPattern(pattern: string): string {
    return `${escapeRedisGlob(this.prefix)}${pattern}`
  }

  private normalizeScanResponse(
    result: unknown,
  ): { readonly cursor: string, readonly keys: readonly string[] } {
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('[@holo-js/security] Redis returned an invalid scan response while clearing rate-limit buckets.')
    }

    const [cursor, keys] = result
    if (typeof cursor !== 'string' || !Array.isArray(keys) || keys.some(key => typeof key !== 'string')) {
      throw new Error('[@holo-js/security] Redis returned an invalid scan response while clearing rate-limit buckets.')
    }

    return {
      cursor,
      keys,
    }
  }

  private async clearMatchingKeys(pattern: string): Promise<number> {
    let cursor = '0'
    let cleared = 0

    do {
      const page = this.normalizeScanResponse(await this.client.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        REDIS_SCAN_COUNT,
      ))
      cursor = page.cursor

      if (page.keys.length > 0) {
        cleared += await this.client.del(...page.keys)
      }
    } while (cursor !== '0')

    return cleared
  }

  private parseOldestScore(result: unknown): number {
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error('[@holo-js/security] Redis transaction failed to return the oldest rate-limit hit.')
    }

    const value = result[1]
    const score = typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN

    if (!Number.isFinite(score)) {
      throw new Error('[@holo-js/security] Redis transaction returned an invalid oldest-hit score.')
    }

    return score
  }

  private getCommandValue(result: readonly RedisCommandTuple[], index: number, operation: string): unknown {
    const entry = result[index]
    if (!entry) {
      throw new Error(`[@holo-js/security] Redis transaction failed to return the ${operation}.`)
    }

    const [error, value] = entry
    if (error instanceof Error) {
      throw error
    }

    if (error) {
      throw new Error(`[@holo-js/security] Redis transaction failed for ${operation}: ${String(error)}`)
    }

    return value
  }

  async connect(): Promise<void> {
    await this.client.connect()
  }

  async increment(
    key: string,
    options: { readonly decaySeconds: number },
  ): Promise<{ readonly attempts: number, readonly ttlSeconds: number }> {
    const now = this.now().getTime()
    const ttlMs = options.decaySeconds * 1000
    const qualifiedKey = this.qualifyKey(key)
    const member = `${now}:${randomUUID()}`

    const result = await this.client.multi()
      .zadd(qualifiedKey, now, member)
      .zremrangebyscore(qualifiedKey, '-inf', now - ttlMs)
      .zcard(qualifiedKey)
      .zrange(qualifiedKey, 0, 0, 'WITHSCORES')
      .exec()

    if (!result) {
      throw new Error('[@holo-js/security] Redis transaction failed for increment.')
    }

    const attemptsValue = this.getCommandValue(result as readonly RedisCommandTuple[], 2, 'attempt count')
    if (typeof attemptsValue !== 'number') {
      throw new Error('[@holo-js/security] Redis transaction returned an invalid attempt count.')
    }
    const attempts = attemptsValue
    const oldestScore = this.parseOldestScore(this.getCommandValue(result as readonly RedisCommandTuple[], 3, 'oldest rate-limit hit'))
    await this.client.pexpireat(qualifiedKey, now + ttlMs)
    const ttlSeconds = Math.max(0, Math.ceil(((oldestScore + ttlMs) - now) / 1000))

    return { attempts, ttlSeconds }
  }

  async del(key: string): Promise<number> {
    return this.client.del(this.qualifyKey(key))
  }

  async clearByPrefix(prefix: string): Promise<number> {
    const basePrefix = prefix.endsWith('*')
      ? prefix.slice(0, -1)
      : prefix
    const pattern = this.qualifyPattern(`${escapeRedisGlob(basePrefix)}*`)
    return await this.clearMatchingKeys(pattern)
  }

  async clearAll(): Promise<number> {
    return await this.clearMatchingKeys(this.qualifyPattern('*'))
  }

  async close(): Promise<void> {
    await this.client.quit()
  }
}

export function createSecurityRedisAdapter(
  config: NormalizedSecurityRateLimitRedisConfig,
  options?: SecurityRedisAdapterOptions,
): RedisSecurityAdapter {
  return new RedisSecurityAdapter(config, options)
}

export const securityRedisAdapterInternals = {
  REDIS_SCAN_COUNT,
  RedisSecurityAdapter,
  createRedisClientOptions,
  isRedisConnectionTarget,
  isRedisSocketConnectionTarget,
}
