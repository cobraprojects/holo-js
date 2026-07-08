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

  it('normalizes inline Redis connection options without shared config', () => {
    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          queue: 'critical',
          retryAfter: '60',
          blockFor: '0',
          redis: {
            host: ' redis.internal ',
            port: '6380',
            username: ' worker ',
            password: ' secret ',
            db: '2',
          },
        },
      },
    })).toEqual({
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
          connection: 'redis',
          queue: 'critical',
          retryAfter: 60,
          blockFor: 0,
          redis: {
            host: 'redis.internal',
            port: 6380,
            username: 'worker',
            password: 'secret',
            db: 2,
          },
        },
      },
    })
  })

  it('merges inline Redis options over shared Redis defaults', () => {
    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          redis: {
            host: 'queue.internal',
            port: '6381',
            db: '2',
          },
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
        host: 'queue.internal',
        port: 6381,
        password: 'secret',
        username: 'worker',
        db: 2,
      },
    })

    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          redis: {
            db: '2',
          },
        },
      },
    }, sharedRedisConfig).connections.redis).toMatchObject({
      redis: {
        url: 'redis://cache.internal:6380/4',
        db: 2,
      },
    })
  })

  it('normalizes inline Redis urls and cluster nodes', () => {
    expect(normalizeQueueConfig({
      default: 'redis',
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            url: 'redis://queue.internal:6380/3',
          },
        },
        cluster: {
          driver: 'redis',
          redis: {
            clusters: [
              { url: 'redis://cluster-a.internal:6380' },
              { host: ' cluster-b.internal ', port: '6381' },
            ],
          },
        },
      },
    }).connections).toMatchObject({
      redis: {
        redis: {
          url: 'redis://queue.internal:6380/3',
          host: '127.0.0.1',
          port: 6379,
          db: 3,
        },
      },
      cluster: {
        redis: {
          clusters: [
            { url: 'redis://cluster-a.internal:6380', host: '127.0.0.1', port: 6379 },
            { host: 'cluster-b.internal', port: 6381 },
          ],
          host: '127.0.0.1',
          port: 6379,
          db: 0,
        },
      },
    })
  })

  it('rejects invalid inline Redis options', () => {
    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            url: 'not a url',
          },
        },
      },
    })).toThrow('queue connection "redis" redis url is invalid')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            url: 'http://redis.internal',
          },
        },
      },
    })).toThrow('unsupported protocol "http:"')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            url: 'redis://redis.internal/one',
          },
        },
      },
    })).toThrow('must include at most one integer database path segment')

    expect(normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            clusters: [],
          },
        },
      },
    }).connections.redis).toMatchObject({
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            clusters: [
              { url: 'redis://cluster.internal/1' },
            ],
          },
        },
      },
    })).toThrow('url cannot include a database path in cluster mode')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            clusters: [
              { host: 'cluster.internal' },
            ],
            db: 1,
          },
        },
      },
    })).toThrow('Redis Cluster only supports database 0')
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

  it('rejects missing shared redis connections and invalid queue defaults', () => {
    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
        },
      },
    })).toThrow('requires a shared Redis config with a default connection or an explicit connection name')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'missing',
        },
      },
    }, sharedRedisConfig)).toThrow('Queue Redis connection "missing" was not found in shared Redis config')

    expect(() => normalizeQueueConfig({
      default: 'missing',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    }, sharedRedisConfig)).toThrow('default queue connection "missing" is not configured')
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

  it('normalizes plugin drivers and rejects invalid integer-like values', () => {
    const pluginQueueConfig = normalizeQueueConfig({
      connections: {
        memory: {
          driver: 'memory' as never,
          queue: 'memory-jobs',
          concurrency: 4,
        },
      },
    })
    expect(pluginQueueConfig.connections.memory).toMatchObject({
      name: 'memory',
      driver: 'memory',
      queue: 'memory-jobs',
      concurrency: 4,
    })

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

    expect(() => queueInternals.parseInteger('1.5', 0, 'sleep')).toThrow(
      'sleep must be an integer.',
    )

    expect(() => queueInternals.parseInteger('10s', 0, 'sleep')).toThrow(
      'sleep must be an integer.',
    )

    expect(() => queueInternals.parseInteger('', 0, 'sleep')).toThrow(
      'sleep must be an integer.',
    )

    expect(() => queueInternals.parseInteger(-1, 0, 'sleep', { minimum: 0 })).toThrow(
      'sleep must be greater than or equal to 0.',
    )

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          retryAfter: '1.5',
        },
      },
    }, sharedRedisConfig)).toThrow('queue connection "redis" retryAfter must be an integer.')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cache',
          blockFor: '10s',
        },
      },
    }, sharedRedisConfig)).toThrow('queue connection "redis" blockFor must be an integer.')

    expect(() => normalizeQueueConfig({
      connections: {
        database: {
          driver: 'database',
          sleep: '',
        },
      },
    })).toThrow('queue connection "database" sleep must be an integer.')
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

  it('preserves shared redis cluster definitions and reports empty shared config inventories', () => {
    expect(normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'cluster',
        },
      },
    }, {
      default: 'cluster',
      connections: {
        cluster: {
          name: 'cluster',
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 0,
          clusters: [{
            host: 'redis-cluster.internal',
            port: 6380,
          }],
        },
      },
    }).connections.redis).toEqual({
      name: 'redis',
      driver: 'redis',
      connection: 'cluster',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        clusters: [{
          host: 'redis-cluster.internal',
          port: 6380,
        }],
        host: '127.0.0.1',
        port: 6379,
        password: undefined,
        username: undefined,
        db: 0,
      },
    })

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          connection: 'missing',
        },
      },
    }, {
      default: 'default',
      connections: {},
    })).toThrow('Available connections: (none).')
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
