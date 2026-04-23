import { describe, expect, it } from 'vitest'
import {
  defineSecurityConfig,
  normalizeRedisConfig,
  normalizeSecurityConfig,
} from '../src'

describe('@holo-js/config security normalization', () => {
  it('defines and normalizes csrf and rate-limit config', () => {
    const config = defineSecurityConfig({
      csrf: {
        enabled: true,
        field: ' _token ',
        header: ' X-CSRF-TOKEN ',
        cookie: ' XSRF-TOKEN ',
        except: ['/webhooks/*', ' /stripe/webhook '],
      },
      rateLimit: {
        driver: 'file',
        file: {
          path: ' ./storage/framework/rate-limits ',
        },
        redis: {
          connection: ' cache ',
          prefix: ' holo:rate-limit: ',
        },
        limiters: {
          login: {
            maxAttempts: '5',
            decaySeconds: '60',
            key({ request, values }) {
              return `${request.method}:${String(values?.email ?? 'guest')}`
            },
          },
        },
      },
    })

    expect(Object.isFrozen(config)).toBe(true)
    expect(normalizeSecurityConfig(config, normalizeRedisConfig({
      default: 'cache',
      connections: {
        cache: {
          host: '127.0.0.1',
          port: 6379,
          db: 0,
        },
      },
    }))).toEqual({
      csrf: {
        enabled: true,
        field: '_token',
        header: 'X-CSRF-TOKEN',
        cookie: 'XSRF-TOKEN',
        except: ['/webhooks/*', '/stripe/webhook'],
      },
      rateLimit: {
        driver: 'file',
        memory: {
          driver: 'memory',
        },
        file: {
          path: './storage/framework/rate-limits',
        },
        redis: {
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 0,
          connection: 'cache',
          prefix: 'holo:rate-limit:',
        },
        limiters: {
          login: {
            name: 'login',
            maxAttempts: 5,
            decaySeconds: 60,
            key: config.rateLimit?.limiters?.login?.key,
          },
        },
      },
    })
  })

  it('provides defaults and rejects malformed values', () => {
    expect(normalizeSecurityConfig()).toEqual({
      csrf: {
        enabled: false,
        field: '_token',
        header: 'X-CSRF-TOKEN',
        cookie: 'XSRF-TOKEN',
        except: [],
      },
      rateLimit: {
        driver: 'memory',
        memory: {
          driver: 'memory',
        },
        file: {
          path: './storage/framework/rate-limits',
        },
        redis: {
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 0,
          connection: 'default',
          prefix: 'holo:rate-limit:',
        },
        limiters: {},
      },
    })
    expect(normalizeSecurityConfig({
      csrf: true,
    }).csrf.enabled).toBe(true)

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        driver: 'database' as never,
      },
    })).toThrow('Unsupported rate limit driver')

    expect(() => normalizeSecurityConfig({
      csrf: {
        except: [''],
      },
    })).toThrow('csrf except entry at index 0')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          '   ': {
            maxAttempts: 5,
            decaySeconds: 60,
          },
        },
      },
    })).toThrow('Rate limiter name must be a non-empty string')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            maxAttempts: 0,
            decaySeconds: 60,
          },
        },
      },
    })).toThrow('maxAttempts must be greater than or equal to 1')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            maxAttempts: 'nope',
            decaySeconds: 60,
          },
        },
      },
    })).toThrow('maxAttempts must be an integer')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            maxAttempts: '5abc',
            decaySeconds: 60,
          },
        },
      },
    })).toThrow('maxAttempts must be an integer')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            decaySeconds: 60,
          } as never,
        },
      },
    })).toThrow('maxAttempts must be greater than or equal to 1')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            maxAttempts: 5,
            decaySeconds: 60,
            key: 'ip' as never,
          },
        },
      },
    })).toThrow('key resolver must be a function')
  })

  it('normalizes redis-backed security settings and rejects missing shared redis connections', () => {
    expect(normalizeSecurityConfig({
      rateLimit: {
        driver: 'redis',
        redis: {
          connection: ' cache ',
          prefix: ' custom-prefix ',
        },
      },
    }, normalizeRedisConfig({
      default: 'cache',
      connections: {
        cache: {
          url: 'redis://cache.internal:6380/4',
        },
      },
    }))).toEqual({
      csrf: {
        enabled: false,
        field: '_token',
        header: 'X-CSRF-TOKEN',
        cookie: 'XSRF-TOKEN',
        except: [],
      },
      rateLimit: {
        driver: 'redis',
        memory: {
          driver: 'memory',
        },
        file: {
          path: './storage/framework/rate-limits',
        },
        redis: {
          url: 'redis://cache.internal:6380/4',
          host: '127.0.0.1',
          port: 6379,
          password: undefined,
          username: undefined,
          db: 4,
          connection: 'cache',
          prefix: 'custom-prefix',
        },
        limiters: {},
      },
    })

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        driver: 'redis',
        redis: {
          connection: 'missing',
        },
      },
    }, normalizeRedisConfig({
      default: 'cache',
      connections: {
        cache: {
          host: '127.0.0.1',
        },
      },
    }))).toThrow('Security rate-limit Redis connection "missing" is not configured')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        limiters: {
          login: {
            maxAttempts: '   ',
            decaySeconds: 60,
          },
        },
      },
    })).toThrow('maxAttempts must be an integer')

    expect(() => normalizeSecurityConfig({
      rateLimit: {
        driver: 'redis',
      },
    })).toThrow('but no top-level redis config is loaded')

    expect(normalizeSecurityConfig({
      rateLimit: {
        driver: 'redis',
        redis: {
          connection: 'cache',
        },
      },
    }, normalizeRedisConfig({
      default: 'cache',
      connections: {
        cache: {
          clusters: [{
            url: 'redis://cache-1.internal:6380',
          }],
        },
      },
    }))).toMatchObject({
      rateLimit: {
        redis: {
          connection: 'cache',
          clusters: [{
            url: 'redis://cache-1.internal:6380',
          }],
        },
      },
    })
  })
})
