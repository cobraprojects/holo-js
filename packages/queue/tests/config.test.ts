import { describe, expect, it } from 'vitest'
import {
  defineJob,
  normalizeQueueConfig,
  queueInternals,
  holoQueueDefaults,
} from '../src'

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
          queue: 'emails',
          retryAfter: '120',
          blockFor: '10',
          redis: {
            host: 'redis.internal',
            port: '6380',
            db: '2',
          },
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
    })).toEqual({
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
          queue: 'emails',
          retryAfter: 120,
          blockFor: 10,
          redis: {
            host: 'redis.internal',
            port: 6380,
            password: undefined,
            username: undefined,
            db: 2,
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
    }).default).toBe('redis')
  })

  it('normalizes blank queue fields and optional credentials to defaults', () => {
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
          redis: {
            host: '   ',
            password: '   ',
            username: '   ',
          },
        },
        database: {
          driver: 'database',
          queue: '   ',
          connection: '   ',
          table: '   ',
        },
      },
    })).toEqual({
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
          queue: ' notifications ',
          redis: {
            host: ' redis.internal ',
            password: ' secret ',
            username: ' worker ',
          },
        },
      },
    })).toEqual({
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
          redis: {
            port: 'abc',
          },
        },
      },
    })).toThrow('queue connection "redis" redis.port must be an integer')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          retryAfter: -1,
        },
      },
    })).toThrow('queue connection "redis" retryAfter must be greater than or equal to 0.')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          blockFor: -1,
        },
      },
    })).toThrow('queue connection "redis" blockFor must be greater than or equal to 0.')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            port: 0,
          },
        },
      },
    })).toThrow('queue connection "redis" redis.port must be greater than or equal to 1.')

    expect(() => normalizeQueueConfig({
      connections: {
        redis: {
          driver: 'redis',
          redis: {
            db: -1,
          },
        },
      },
    })).toThrow('queue connection "redis" redis.db must be greater than or equal to 0.')

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
