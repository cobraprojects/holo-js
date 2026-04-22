import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  CacheInvalidNumericMutationError,
  type CacheDriverContract,
  type CacheDriverGetResult,
  type CacheDriverPutInput,
  type CacheLockContract,
} from '@holo-js/cache'

export type RedisCacheDriverOptions = {
  readonly name: string
  readonly connectionName: string
  readonly prefix: string
  readonly redis:
    & {
      readonly username?: string
      readonly password?: string
      readonly db: number
    }
    & (
      | {
          readonly url?: string
          readonly clusters?: readonly {
            readonly url?: string
            readonly socketPath?: string
            readonly host: string
            readonly port: number
          }[]
          readonly socketPath?: string
          readonly host: string
          readonly port: number
        }
      | {
          readonly url: string
          readonly clusters?: readonly {
            readonly url?: string
            readonly socketPath?: string
            readonly host: string
            readonly port: number
          }[]
          readonly socketPath?: string
          readonly host?: string
          readonly port?: number
        }
      | {
          readonly clusters: readonly {
            readonly url?: string
            readonly socketPath?: string
            readonly host: string
            readonly port: number
          }[]
          readonly url?: string
          readonly socketPath?: string
          readonly host?: string
          readonly port?: number
        }
    )
  readonly now?: () => number
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly ownerFactory?: () => string
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
  readonly tls?: Record<string, never>
}

type RedisClusterStartupNode = {
  readonly host: string
  readonly port: number
  readonly tls?: Record<string, never>
}

type RedisClusterOptions = {
  readonly redisOptions: RedisClientOptions
}

type RedisClientLike = {
  readonly isCluster?: boolean
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...arguments_: readonly (string | number)[]): Promise<'OK' | null>
  del(...keys: string[]): Promise<number>
  scan(cursor: string, matchLabel: string, pattern: string, countLabel: string, count: number): Promise<[string, string[]]>
  incrby(key: string, amount: number): Promise<number>
  decrby(key: string, amount: number): Promise<number>
  eval(script: string, numberOfKeys: number, ...arguments_: readonly string[]): Promise<number>
  nodes?(role: 'master'): readonly RedisClientLike[]
}

type RedisCtor = typeof Redis & {
  Cluster: new (
    startupNodes: readonly RedisClusterStartupNode[],
    options?: RedisClusterOptions,
  ) => RedisClientLike
}

const REDIS_SCAN_COUNT = 100
const RELEASE_LOCK_SCRIPT = [
  'if redis.call("get", KEYS[1]) == ARGV[1] then',
  '  return redis.call("del", KEYS[1])',
  'end',
  'return 0',
].join('\n')

/* v8 ignore start -- lock timeout tests cover the behavior, but fake-timer attribution does not reliably mark this helper as covered. */
function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}
/* v8 ignore stop */

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://') || value.startsWith('/')
}

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
}

function escapeRedisGlob(value: string): string {
  return value.replace(/[\\*?[\]]/g, match => `\\${match}`)
}

function isRedisUrl(value: string): boolean {
  return value.startsWith('redis://') || value.startsWith('rediss://')
}

function createRedisClientOptions(
  options: RedisCacheDriverOptions,
): RedisClientOptions {
  return {
    password: options.redis.password,
    username: options.redis.username,
    db: options.redis.db,
    ...(typeof options.redis.url === 'undefined'
      && !options.redis.clusters?.length
      && typeof options.redis.socketPath === 'string'
      ? { path: options.redis.socketPath }
      : typeof options.redis.url === 'undefined'
          && !options.redis.clusters?.length
          && typeof options.redis.host === 'string'
          && isRedisSocketConnectionTarget(options.redis.host)
        ? { path: toRedisSocketPath(options.redis.host) }
        : typeof options.redis.url === 'undefined' && !options.redis.clusters?.length
          ? {
              host: options.redis.host,
              port: options.redis.port,
            }
          : {}),
    ...(typeof options.redis.url === 'undefined' && !options.redis.clusters?.length && !isRedisUrl(options.connectionName)
      ? { connectionName: options.connectionName }
      : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  }
}

function parseClusterNodeUrl(url: string, label: string): RedisClusterStartupNode {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
      throw new Error(`unsupported protocol "${parsed.protocol}"`)
    }

    /* v8 ignore next 3 -- Node URL parsing rejects most empty-host Redis URLs before this branch becomes observable. */
    if (!parsed.hostname) {
      throw new Error('missing hostname')
    }

    return {
      host: parsed.hostname,
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
      ...(parsed.protocol === 'rediss:' ? { tls: {} } : {}),
    }
  /* v8 ignore start -- URL parsing failures surface as Error instances in supported Node runtimes. */
  } catch (error) {
    throw new Error(
      `[@holo-js/cache-redis] ${label} is invalid: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  /* v8 ignore stop */
}

function resolveClusterStartupNodes(
  options: RedisCacheDriverOptions,
): readonly RedisClusterStartupNode[] {
  return (options.redis.clusters ?? []).map((node, index) => {
    const label = `Cache Redis cluster node ${index + 1}`
    if (typeof node.url === 'string') {
      return parseClusterNodeUrl(node.url, `${label} url`)
    }

    if (typeof node.socketPath === 'string' || isRedisSocketConnectionTarget(node.host)) {
      throw new Error(`[@holo-js/cache-redis] ${label} cannot use a Unix socket path in Redis cluster mode.`)
    }

    return {
      host: node.host,
      port: node.port,
    }
  })
}

function createRedisClusterOptions(
  options: RedisCacheDriverOptions,
): RedisClusterOptions {
  if (options.redis.db !== 0) {
    throw new Error('[@holo-js/cache-redis] Redis Cluster does not support selecting a non-zero database. Remove redis.db or set it to 0.')
  }

  const startupNodes = resolveClusterStartupNodes(options)
  return {
    redisOptions: {
      password: options.redis.password,
      username: options.redis.username,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      ...(startupNodes.some(node => typeof node.tls !== 'undefined') ? { tls: {} } : {}),
    },
  }
}

function createRedisClient(options: RedisCacheDriverOptions): RedisClientLike {
  const RedisConstructor = Redis as RedisCtor
  const clientOptions = createRedisClientOptions(options)

  if (typeof options.redis.url === 'string') {
    return new RedisConstructor(options.redis.url, clientOptions)
  }

  if (options.redis.clusters && options.redis.clusters.length > 0) {
    return new RedisConstructor.Cluster(
      resolveClusterStartupNodes(options),
      createRedisClusterOptions(options),
    )
  }

  return new RedisConstructor(clientOptions)
}

function toLockTtlMilliseconds(seconds: number): number {
  return Math.max(1, Math.round(seconds * 1000))
}

function createRedisLock(
  client: RedisClientLike,
  name: string,
  seconds: number,
  ownerFactory: () => string,
  sleep: (milliseconds: number) => Promise<void>,
  now: () => number,
): CacheLockContract {
  const owner = ownerFactory()

  async function tryAcquire(): Promise<boolean> {
    return (await client.set(name, owner, 'PX', toLockTtlMilliseconds(seconds), 'NX')) === 'OK'
  }

  async function withCallback<TValue>(
    callback: (() => TValue | Promise<TValue>) | undefined,
  ): Promise<boolean | TValue> {
    if (!callback) {
      return true
    }

    try {
      return await callback()
    } finally {
      await lock.release()
    }
  }

  const lock: CacheLockContract = {
    name,
    async get<TValue>(callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      if (!(await tryAcquire())) {
        return false
      }

      return withCallback(callback)
    },
    async release(): Promise<boolean> {
      return (await client.eval(RELEASE_LOCK_SCRIPT, 1, name, owner)) === 1
    },
    async block<TValue>(waitSeconds: number, callback?: () => TValue | Promise<TValue>): Promise<boolean | TValue> {
      const deadline = now() + Math.max(0, Math.round(waitSeconds * 1000))
      while (true) {
        if (await tryAcquire()) {
          return withCallback(callback)
        }

        if (now() >= deadline) {
          return false
        }

        await sleep(10)
      }
    },
  }

  return lock
}

export function createRedisCacheDriver(options: RedisCacheDriverOptions): CacheDriverContract {
  const client = createRedisClient(options)
  const sleep = options.sleep ?? defaultSleep
  const ownerFactory = options.ownerFactory ?? randomUUID
  const now = options.now ?? Date.now
  const flushPattern = `${escapeRedisGlob(options.prefix)}*`

  async function flushClient(target: RedisClientLike): Promise<void> {
    let cursor = '0'

    do {
      const [nextCursor, keys] = await target.scan(cursor, 'MATCH', flushPattern, 'COUNT', REDIS_SCAN_COUNT)
      cursor = nextCursor
      if (keys.length > 0) {
        await target.del(...keys)
      }
    } while (cursor !== '0')
  }

  return {
    name: options.name,
    driver: 'redis',
    async get(key: string): Promise<CacheDriverGetResult> {
      const payload = await client.get(key)
      if (payload === null) {
        return Object.freeze({ hit: false })
      }

      return Object.freeze({
        hit: true,
        payload,
      })
    },
    async put(input: CacheDriverPutInput): Promise<boolean> {
      if (typeof input.expiresAt === 'number' && input.expiresAt <= now()) {
        await client.del(input.key)
        return true
      }

      if (typeof input.expiresAt === 'number') {
        await client.set(input.key, input.payload, 'PXAT', input.expiresAt)
        return true
      }

      await client.set(input.key, input.payload)
      return true
    },
    async add(input: CacheDriverPutInput): Promise<boolean> {
      if (typeof input.expiresAt === 'number' && input.expiresAt <= now()) {
        await client.del(input.key)
        return true
      }

      if (typeof input.expiresAt === 'number') {
        return (await client.set(input.key, input.payload, 'PXAT', input.expiresAt, 'NX')) === 'OK'
      }

      return (await client.set(input.key, input.payload, 'NX')) === 'OK'
    },
    async forget(key: string): Promise<boolean> {
      return (await client.del(key)) > 0
    },
    async flush(): Promise<void> {
      if (client.isCluster) {
        for (const node of client.nodes?.('master') ?? []) {
          await flushClient(node)
        }
        return
      }

      await flushClient(client)
    },
    async increment(key: string, amount: number): Promise<number> {
      try {
        return await client.incrby(key, amount)
      } catch (error) {
        throw new CacheInvalidNumericMutationError(
          `[@holo-js/cache] Cache key "${key}" does not contain a numeric value.`,
          { cause: error },
        )
      }
    },
    async decrement(key: string, amount: number): Promise<number> {
      try {
        return await client.decrby(key, amount)
      } catch (error) {
        throw new CacheInvalidNumericMutationError(
          `[@holo-js/cache] Cache key "${key}" does not contain a numeric value.`,
          { cause: error },
        )
      }
    },
    lock(name: string, seconds: number): CacheLockContract {
      return createRedisLock(client, name, seconds, ownerFactory, sleep, now)
    },
  }
}

export const redisCacheDriverInternals = {
  createRedisClient,
  createRedisClientOptions,
  createRedisClusterOptions,
  createRedisLock,
  escapeRedisGlob,
  isRedisSocketConnectionTarget,
  parseClusterNodeUrl,
  resolveClusterStartupNodes,
  toLockTtlMilliseconds,
  toRedisSocketPath,
}
