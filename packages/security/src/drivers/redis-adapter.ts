import { randomUUID } from 'node:crypto'
import type {
  NormalizedSecurityRateLimitRedisConfig,
} from '@holo-js/config'
import Redis from 'ioredis'
import type { SecurityRateLimitRedisDriverAdapter } from '../contracts'

export interface SecurityRedisAdapterOptions {
  readonly now?: () => Date
}

type RedisClientOptions = {
  readonly host?: string
  readonly port?: number
  readonly path?: string
  readonly password?: string
  readonly username?: string
  readonly db?: number
  readonly connectionName?: string
  readonly lazyConnect: true
  readonly maxRetriesPerRequest: number
}

type RedisClusterOptions = {
  readonly redisOptions: RedisClientOptions
}

type RedisClusterStartupNode = {
  readonly host: string
  readonly port: number
  readonly tls?: Record<string, never>
}

type RedisClientLike = {
  connect(): Promise<unknown>
  multi(): {
    zadd(key: string, score: number, member: string): ReturnType<RedisClientLike['multi']>
    zremrangebyscore(key: string, min: string | number, max: string | number): ReturnType<RedisClientLike['multi']>
    zcard(key: string): ReturnType<RedisClientLike['multi']>
    zrange(key: string, start: number, stop: number, withScores: string): ReturnType<RedisClientLike['multi']>
    exec(): Promise<readonly RedisCommandTuple[] | null>
  }
  del(...keys: string[]): Promise<number>
  scan(cursor: string, matchLabel: string, pattern: string, countLabel: string, count: number): Promise<[string, string[]]>
  pexpireat(key: string, timestampMs: number): Promise<number>
  quit(): Promise<unknown>
  disconnect(): void
}

type RedisCtor = typeof Redis & {
  Cluster: new (
    startupNodes: readonly RedisClusterStartupNode[],
    options?: RedisClusterOptions,
  ) => RedisClientLike
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

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
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
    ...(
      !isRedisConnectionTarget(config.connection)
      && !config.clusters?.length
      && !isRedisSocketConnectionTarget(config.host)
        ? {
            host: config.host,
            port: config.port,
          }
        : isRedisSocketConnectionTarget(config.host) && !config.clusters?.length
          ? { path: toRedisSocketPath(config.host) }
          : {}
    ),
    ...(config.connection !== 'default' && !isRedisConnectionTarget(config.connection) && !config.clusters?.length
      ? { connectionName: config.connection }
      : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }
}

function parseClusterNodeUrl(
  url: string,
  label: string,
): RedisClusterStartupNode {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`)
    }

    if (!parsed.hostname) {
      throw new Error('missing hostname')
    }

    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    }
  } catch (error) {
    throw new Error(`[@holo-js/security] ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveClusterStartupNodes(
  config: NormalizedSecurityRateLimitRedisConfig,
): readonly RedisClusterStartupNode[] {
  return (config.clusters ?? []).map((node, index) => {
    const label = `Security rate-limit Redis cluster node ${index + 1}`
    if (typeof node.url === 'string') {
      return parseClusterNodeUrl(node.url, `${label} url`)
    }

    if (isRedisSocketConnectionTarget(node.host)) {
      throw new Error(`[@holo-js/security] ${label} cannot use a Unix socket path in Redis cluster mode.`)
    }

    return {
      host: node.host,
      port: node.port,
    }
  })
}

function createRedisClusterOptions(
  config: NormalizedSecurityRateLimitRedisConfig,
): RedisClusterOptions {
  if (typeof config.db === 'number' && config.db !== 0) {
    throw new Error('[@holo-js/security] Redis Cluster does not support selecting a non-zero database. Remove redis.db or set it to 0.')
  }

  const startupNodes = resolveClusterStartupNodes(config)

  return {
    redisOptions: {
      password: config.password,
      username: config.username,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      ...(startupNodes.some(node => typeof node.tls !== 'undefined') ? { tls: {} } : {}),
    },
  }
}

export class RedisSecurityAdapter implements SecurityRateLimitRedisDriverAdapter {
  private readonly client: RedisClientLike
  private readonly now: () => Date
  private readonly prefix: string

  constructor(config: NormalizedSecurityRateLimitRedisConfig, options: SecurityRedisAdapterOptions = {}) {
    this.prefix = config.prefix
    this.now = options.now ?? (() => new Date())
    const clientOptions = createRedisClientOptions(config)
    const RedisConstructor = Redis as RedisCtor

    this.client = typeof config.url === 'string'
      ? new RedisConstructor(config.url, clientOptions)
      : config.clusters && config.clusters.length > 0
        ? new RedisConstructor.Cluster(resolveClusterStartupNodes(config), createRedisClusterOptions(config))
        : isRedisConnectionTarget(config.connection)
          ? new RedisConstructor(config.connection, clientOptions)
          : new RedisConstructor(clientOptions)
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
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
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
  createRedisClusterOptions,
  escapeRedisGlob,
  isRedisConnectionTarget,
  isRedisSocketConnectionTarget,
  parseClusterNodeUrl,
  resolveClusterStartupNodes,
  toRedisSocketPath,
}
