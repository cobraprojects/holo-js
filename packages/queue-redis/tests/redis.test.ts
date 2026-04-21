import { describe, expect, it, vi } from 'vitest'

vi.mock('bullmq', () => ({
  Queue: class {},
  Worker: class {},
}))

vi.mock('ioredis', () => {
  class FakeRedis {
    static constructorArgs: unknown[][] = []

    constructor(...args: unknown[]) {
      FakeRedis.constructorArgs.push(args)
    }

    static Cluster = class FakeRedisCluster {
      constructor(
        public readonly startupNodes: readonly unknown[],
        public readonly options?: unknown,
      ) {}
    }
  }

  return {
    default: FakeRedis,
  }
})

describe('@holo-js/queue-redis', () => {
  it('exports the redis driver factory and helpers', async () => {
    const {
      RedisQueueDriverError,
      redisQueueDriverFactory,
      redisQueueDriverInternals,
    } = await import('../src')

    expect(redisQueueDriverFactory.driver).toBe('redis')
    expect(redisQueueDriverInternals.resolveBullConnectionOptions({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
    })
    expect(redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: 3,
      attemptsMade: 1,
    } as never)).toBe(2)
    expect(
      redisQueueDriverInternals.wrapRedisError('redis', 'reserve job', new Error('boom')),
    ).toBeInstanceOf(RedisQueueDriverError)
  })

  it('propagates TLS options for rediss cluster nodes', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')

    const connection = redisQueueDriverInternals.resolveBullConnection({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        clusters: [
          {
            url: 'rediss://cache.internal:6380',
            host: 'cache.internal',
            port: 6380,
          },
        ],
      },
    }) as {
      readonly startupNodes: readonly unknown[]
      readonly options?: {
        readonly redisOptions?: {
          readonly tls?: Record<string, never>
        }
      }
    }

    expect(connection.startupNodes).toEqual([
      {
        host: 'cache.internal',
        port: 6380,
      },
    ])
    expect(connection.options).toEqual({
      redisOptions: {
        username: undefined,
        password: undefined,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        tls: {},
      },
    })
  })

  it('rejects non-zero redis db values in cluster mode', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')

    expect(() => redisQueueDriverInternals.resolveBullConnection({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 4,
        clusters: [
          {
            url: 'redis://cache.internal:6380',
            host: 'cache.internal',
            port: 6380,
          },
        ],
      },
    })).toThrow('cannot select redis.db=4 in cluster mode')
  })

  it('creates a managed ioredis client for url-based connections', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')
    const RedisModule = (await import('ioredis')).default as unknown as {
      constructorArgs: unknown[][]
    }

    redisQueueDriverInternals.resolveBullConnection({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        url: 'rediss://cache.internal:6380/4',
        host: '127.0.0.1',
        port: 6379,
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    })

    expect(RedisModule.constructorArgs.at(-1)).toEqual([
      'rediss://cache.internal:6380/4',
      {
        username: 'worker',
        password: 'secret',
        db: 4,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        tls: {},
      },
    ])
  })
})
