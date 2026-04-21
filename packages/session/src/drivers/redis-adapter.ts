import type {
  NormalizedSessionRedisStoreConfig,
} from '@holo-js/config'
import Redis from 'ioredis'
import type { SessionRecord } from '../contracts'
import type { SessionRedisDriverAdapter } from './redis'

export interface SessionRedisAdapterOptions {
  readonly now?: () => Date
}

type RedisStandaloneOptions = {
  readonly host?: string
  readonly port?: number
  readonly path?: string
  readonly password?: string
  readonly username?: string
  readonly db?: number
  readonly tls?: Record<string, never>
  readonly lazyConnect: true
  readonly maxRetriesPerRequest: number
}

type RedisClusterOptions = {
  readonly redisOptions: RedisStandaloneOptions
}

type RedisClusterStartupNode = {
  readonly host: string
  readonly port: number
  readonly tls?: Record<string, never>
}

type RedisClientLike = {
  connect?(): Promise<unknown>
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', durationMs: number): Promise<'OK' | null>
  del(key: string): Promise<number>
  quit(): Promise<unknown>
  disconnect(): void
}

type RedisCtor = typeof Redis & {
  Cluster: new (
    startupNodes: readonly RedisClusterStartupNode[],
    options?: RedisClusterOptions,
  ) => RedisClientLike
}

function isRedisUrlTarget(value: string): boolean {
  return value.startsWith('redis://') || value.startsWith('rediss://')
}

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://') || value.startsWith('/')
}

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
}

function createStandaloneOptions(config: NormalizedSessionRedisStoreConfig): RedisStandaloneOptions {
  return {
    ...(!isRedisSocketConnectionTarget(config.host)
      ? {
          host: config.host,
          port: config.port,
        }
      : {
          path: toRedisSocketPath(config.host),
        }),
    password: config.password,
    username: config.username,
    db: config.db,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }
}

function createClusterOptions(config: NormalizedSessionRedisStoreConfig): RedisClusterOptions {
  if (typeof config.db === 'number' && config.db !== 0) {
    throw new Error('[@holo-js/session] Redis Cluster does not support selecting a non-zero database. Remove db or set it to 0.')
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

function parseClusterNodeUrl(node: string, label: string): RedisClusterStartupNode {
  try {
    const parsed = new URL(node)
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
    throw new Error(`[@holo-js/session] ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function resolveClusterStartupNodes(
  config: NormalizedSessionRedisStoreConfig,
): readonly RedisClusterStartupNode[] {
  return (config.clusters ?? []).map((node, index) => {
    const label = `Session Redis store "${config.name}" cluster node ${index + 1}`
    if (typeof node.url === 'string') {
      return parseClusterNodeUrl(node.url, `${label} url`)
    }

    if (isRedisSocketConnectionTarget(node.host)) {
      throw new Error(`[@holo-js/session] ${label} cannot use a Unix socket path in Redis cluster mode.`)
    }

    return {
      host: node.host,
      port: node.port,
    }
  })
}

function createRedisClient(config: NormalizedSessionRedisStoreConfig): RedisClientLike {
  const RedisConstructor = Redis as RedisCtor

  if (typeof config.url === 'string' && isRedisUrlTarget(config.url)) {
    return new RedisConstructor(config.url, {
      password: config.password,
      username: config.username,
      db: config.db,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })
  }

  if (config.clusters && config.clusters.length > 0) {
    return new RedisConstructor.Cluster(
      resolveClusterStartupNodes(config),
      createClusterOptions(config),
    )
  }

  return new RedisConstructor(createStandaloneOptions(config))
}

function serializeSessionRecord(record: SessionRecord): string {
  return JSON.stringify({
    id: record.id,
    store: record.store,
    data: record.data,
    createdAt: record.createdAt.toISOString(),
    lastActivityAt: record.lastActivityAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    ...(typeof record.rememberTokenHash === 'undefined' ? {} : { rememberTokenHash: record.rememberTokenHash }),
  })
}

function deserializeSessionRecord(value: string): SessionRecord | null {
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown
      store?: unknown
      data?: unknown
      createdAt?: unknown
      lastActivityAt?: unknown
      expiresAt?: unknown
      rememberTokenHash?: unknown
    }

    if (
      typeof parsed.id !== 'string'
      || typeof parsed.store !== 'string'
      || typeof parsed.data !== 'object'
      || parsed.data === null
      || Array.isArray(parsed.data)
      || typeof parsed.createdAt !== 'string'
      || typeof parsed.lastActivityAt !== 'string'
      || typeof parsed.expiresAt !== 'string'
      || (
        typeof parsed.rememberTokenHash !== 'undefined'
        && typeof parsed.rememberTokenHash !== 'string'
      )
    ) {
      return null
    }

    const createdAtMs = Date.parse(parsed.createdAt)
    const lastActivityAtMs = Date.parse(parsed.lastActivityAt)
    const expiresAtMs = Date.parse(parsed.expiresAt)

    if (
      Number.isNaN(createdAtMs)
      || Number.isNaN(lastActivityAtMs)
      || Number.isNaN(expiresAtMs)
    ) {
      return null
    }

    return Object.freeze({
      id: parsed.id,
      store: parsed.store,
      data: Object.freeze({ ...(parsed.data as Record<string, unknown>) }),
      createdAt: new Date(createdAtMs),
      lastActivityAt: new Date(lastActivityAtMs),
      expiresAt: new Date(expiresAtMs),
      ...(typeof parsed.rememberTokenHash === 'undefined' ? {} : { rememberTokenHash: parsed.rememberTokenHash }),
    })
  } catch {
    return null
  }
}

export class RedisSessionAdapter implements SessionRedisDriverAdapter {
  private readonly client: RedisClientLike
  private readonly prefix: string
  private readonly now: () => Date

  constructor(
    config: NormalizedSessionRedisStoreConfig,
    options: SessionRedisAdapterOptions = {},
  ) {
    this.client = createRedisClient(config)
    this.prefix = config.prefix
    this.now = options.now ?? (() => new Date())
  }

  private qualifyKey(sessionId: string): string {
    return `${this.prefix}${sessionId}`
  }

  async connect(): Promise<void> {
    await this.client.connect?.()
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const encoded = await this.client.get(this.qualifyKey(sessionId))
    return encoded ? deserializeSessionRecord(encoded) : null
  }

  async set(record: SessionRecord): Promise<void> {
    const ttlMs = Math.max(1, record.expiresAt.getTime() - this.now().getTime())
    await this.client.set(this.qualifyKey(record.id), serializeSessionRecord(record), 'PX', ttlMs)
  }

  async del(sessionId: string): Promise<void> {
    await this.client.del(this.qualifyKey(sessionId))
  }

  async close(): Promise<void> {
    try {
      await this.client.quit()
    } catch {
      this.client.disconnect()
    }
  }

  async disconnect(): Promise<void> {
    this.client.disconnect()
  }
}

export function createSessionRedisAdapter(
  config: NormalizedSessionRedisStoreConfig,
  options?: SessionRedisAdapterOptions,
): RedisSessionAdapter {
  return new RedisSessionAdapter(config, options)
}

export const sessionRedisAdapterInternals = {
  createClusterOptions,
  createRedisClient,
  createStandaloneOptions,
  deserializeSessionRecord,
  isRedisSocketConnectionTarget,
  isRedisUrlTarget,
  parseClusterNodeUrl,
  resolveClusterStartupNodes,
  serializeSessionRecord,
  toRedisSocketPath,
}
