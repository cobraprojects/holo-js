import { describe, expect, it } from 'vitest'
import {
  defineJob,
  normalizeQueueConfig,
  queueInternals,
  holoQueueDefaults,
} from '../src'

const sharedRedisConfig = {
  default: 'default',
  connections: {
    default: {
      name: 'default',
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      username: undefined,
      db: 0,
    },
    cache: {
      name: 'cache',
      url: 'redis://cache.internal:6380/4',
      host: 'cache.internal',
      port: 6380,
      password: 'secret',
      username: 'worker',
      db: 4,
    },
    'redis-primary': {
      name: 'redis-primary',
      host: 'redis.internal',
      port: 6379,
      password: 'secret',
      username: 'worker',
      db: 0,
    },
  },
} as const

describe('@holo-js/queue config', () => {
  it('normalizes the default sync queue config', () => {
    expect(normalizeQueueConfig()).toEqual(holoQueueDefaults)
  })

  it('normalizes redis and database connections with string env-like values', () => {
    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          queue: 'emails',
          retryAfter: '120',
          blockFor: '10',
        },
        database: {
          driver: 'database',
          queue: 'reports',
          retryAfter: '45',
          sleep: '3',
          connection: 'main',
          table: 'queued_jobs',
        },
      },
      failed: {
        driver: 'database',
        connection: 'archive',
        table: 'failed_queue_jobs',
      },
    }, sharedRedisConfig)).toEqual({
      default: 'redis',
      failed: {
        driver: 'database',
        connection: 'archive',
        table: 'failed_queue_jobs',
      },
      connections: {
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'cache',
          queue: 'emails',
          retryAfter: 120,
          blockFor: 10,
          redis: {
            url: 'redis://cache.internal:6380/4',
            host: 'cache.internal',
            port: 6380,
            password: 'secret',
            username: 'worker',
            db: 4,
          },
        },
        database: {
          name: 'database',
          driver: 'database',
          queue: 'reports',
          retryAfter: 45,
          sleep: 3,
          connection: 'main',
          table: 'queued_jobs',
        },
      },
    })
  })

  it('supports disabling failed job storage explicitly', () => {
    expect(normalizeQueueConfig({
      failed: false,
    }).failed).toBe(false)
  })

  it('falls back to the first configured connection when the default is blank', () => {
    expect(normalizeQueueConfig({
      default: '   ',
      connections: {
        redis: {
          driver: 'redis',
        },
        database: {
          driver: 'database',
        },
      },
    }, sharedRedisConfig).default).toBe('redis')
  })

  it('normalizes blank queue fields and shared redis defaults', () => {
    expect(normalizeQueueConfig({
      failed: {
        driver: 'database',
        connection: '   ',
        table: '   ',
      },
      connections: {
        sync: {
          driver: 'sync',
          queue: '   ',
        },
        redis: {
          driver: 'redis',
          queue: '   ',
        },
        database: {
          driver: 'database',
          queue: '   ',
          connection: '   ',
          table: '   ',
        },
      },
    }, sharedRedisConfig)).toEqual({
      default: 'sync',
      failed: {
        driver: 'database',
        connection: 'default',
        table: 'failed_jobs',
      },
      connections: {
        sync: {
          name: 'sync',
          driver: 'sync',
          queue: 'default',
        },
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'default',
          queue: 'default',
          retryAfter: 90,
          blockFor: 5,
          redis: {
            host: '127.0.0.1',
            port: 6379,
            password: undefined,
            username: undefined,
            db: 0,
          },
        },
        database: {
          name: 'database',
          driver: 'database',
          queue: 'default',
          retryAfter: 90,
          sleep: 1,
          connection: 'default',
          table: 'jobs',
        },
      },
    })
    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    }, sharedRedisConfig)).toEqual({
      default: 'redis',
      failed: {
        driver: 'database',
        connection: 'default',
        table: 'failed_jobs',
      },
      connections: {
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'cache',
          queue: 'default',
          retryAfter: 90,
          blockFor: 5,
          redis: {
            url: 'redis://cache.internal:6380/4',
            host: 'cache.internal',
            port: 6380,
            password: 'secret',
            username: 'worker',
            db: 4,
          },
        },
      },
    })
  })

  it('trims defaults, names, and optional redis credentials when provided', () => {
    expect(normalizeQueueConfig({
      default: ' redis ',
      failed: {
        driver: 'database',
        connection: ' archive ',
        table: ' failed_queue_jobs ',
      },
      connections: {
        redis: {
          driver: 'redis',
          connection: 'redis-primary',
          queue: ' notifications ',
        },
      },
    }, sharedRedisConfig)).toEqual({
      default: 'redis',
      failed: {
        driver: 'database',
        connection: 'archive',
        table: 'failed_queue_jobs',
      },
      connections: {
        redis: {
          name: 'redis',
          driver: 'redis',
          connection: 'redis-primary',
          queue: 'notifications',
          retryAfter: 90,
          blockFor: 5,
          redis: {
            host: 'redis.internal',
            port: 6379,
            password: 'secret',
            username: 'worker',
            db: 0,
          },
        },
      },
    })
  })

  it('rejects missing default queue connections', () => {
    expect(() => normalizeQueueConfig({
      default: 'redis',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })).toThrow('default queue connection "redis" is not configured')
  })

  it('rejects unsupported drivers and invalid integer-like values', () => {
    expect(() => normalizeQueueConfig({
      connections: {
        broken: {
          driver: 'memory' as never,
        },
      },
    })).toThrow('Unsupported queue driver "memory"')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    }, sharedRedisConfig)).not.toThrow()

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          retryAfter: -1,
        },
      },
    }, sharedRedisConfig)).toThrow('queue connection "redis" retryAfter must be greater than or equal to 0.')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          blockFor: -1,
        },
      },
    }, sharedRedisConfig)).toThrow('queue connection "redis" blockFor must be greater than or equal to 0.')

    expect(() => normalizeQueueConfig({
      connections: {
        database: {
          driver: 'database',
          retryAfter: -1,
        },
      },
    })).toThrow('queue connection "database" retryAfter must be greater than or equal to 0.')

    expect(() => normalizeQueueConfig({
      connections: {
        database: {
          driver: 'database',
          sleep: -1,
        },
      },
    })).toThrow('queue connection "database" sleep must be greater than or equal to 0.')

    expect(() => queueInternals.parseInteger(1.5, 0, 'sleep')).toThrow(
      'sleep must be an integer.',
    )

    expect(() => queueInternals.parseInteger(-1, 0, 'sleep', { minimum: 0 })).toThrow(
      'sleep must be greater than or equal to 0.',
    )
  })

  it('rejects unsupported failed job store drivers and empty connection names', () => {
    expect(() => normalizeQueueConfig({
      failed: {
        driver: 'redis' as never,
      },
    })).toThrow('Unsupported failed job store driver "redis"')

    expect(() => normalizeQueueConfig({
      connections: {
        ' ': {
          driver: 'sync',
        },
      },
    })).toThrow('Queue connection name must be a non-empty string.')
  })

  it('resolves named shared Redis connections for Redis-backed queues', () => {
    expect(normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    }, sharedRedisConfig).connections.redis).toEqual({
      name: 'redis',
      driver: 'redis',
      connection: 'cache',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        url: 'redis://cache.internal:6380/4',
        host: 'cache.internal',
        port: 6380,
        password: 'secret',
        username: 'worker',
        db: 4,
      },
    })
  })

  it('rejects missing or unresolved shared Redis config for Redis-backed queues', () => {
    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    })).toThrow('references shared Redis connection "cache" but no shared Redis config was provided')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
        },
      },
    }, {
      default: 'default',
      connections: {
        default: {
          name: 'default',
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 0,
        },
      },
    })).toThrow('Queue Redis connection "cache" was not found in shared Redis config')
  })

  it('exposes parseInteger fallback behavior for undefined values', () => {
    expect(queueInternals.parseInteger(undefined, 7, 'sleep')).toBe(7)
  })

  it('freezes defined jobs', () => {
    const job = defineJob({
      async handle() {
        return 'sent'
      },
    })

    expect(Object.isFrozen(job)).toBe(true)
  })
})
