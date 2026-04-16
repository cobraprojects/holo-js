import { describe, expect, it } from 'vitest'
import {
  defineBroadcastConfig,
  normalizeBroadcastConfig,
} from '../src'

describe('@holo-js/config broadcast normalization', () => {
  it('defines and normalizes laravel-style broadcast connections', () => {
    const config = defineBroadcastConfig({
      default: 'reverb',
      connections: {
        reverb: {
          driver: 'holo',
          key: ' app-key ',
          secret: ' app-secret ',
          appId: ' app-id ',
          options: {
            host: ' ws.example.com ',
            port: '443',
            scheme: 'https',
          },
        },
        pusher: {
          driver: 'pusher',
          key: 'pusher-key',
          secret: 'pusher-secret',
          appId: 'pusher-app',
          options: {
            host: 'api-mt1.pusher.com',
            port: 6001,
            scheme: 'http',
            useTLS: false,
            cluster: 'mt1',
          },
        },
        log: {
          driver: 'log',
        },
        null: {
          driver: 'null',
        },
      },
      worker: {
        host: ' 0.0.0.0 ',
        port: '8080',
        publicHost: ' ws.example.com ',
        publicPort: '443',
        publicScheme: 'https',
        scaling: {
          driver: 'redis',
          connection: 'broadcast',
        },
      },
    })

    expect(config.default).toBe('reverb')
    expect(Object.isFrozen(config)).toBe(true)
    expect(normalizeBroadcastConfig(config)).toEqual({
      default: 'reverb',
      connections: {
        reverb: {
          name: 'reverb',
          driver: 'holo',
          key: 'app-key',
          secret: 'app-secret',
          appId: 'app-id',
          options: {
            host: 'ws.example.com',
            port: 443,
            scheme: 'https',
            useTLS: true,
            cluster: undefined,
          },
          clientOptions: {},
        },
        pusher: {
          name: 'pusher',
          driver: 'pusher',
          key: 'pusher-key',
          secret: 'pusher-secret',
          appId: 'pusher-app',
          options: {
            host: 'api-mt1.pusher.com',
            port: 6001,
            scheme: 'http',
            useTLS: false,
            cluster: 'mt1',
          },
          clientOptions: {},
        },
        log: {
          name: 'log',
          driver: 'log',
          clientOptions: {},
        },
        null: {
          name: 'null',
          driver: 'null',
          clientOptions: {},
        },
      },
      worker: {
        host: '0.0.0.0',
        port: 8080,
        path: '/app',
        publicHost: 'ws.example.com',
        publicPort: 443,
        publicScheme: 'https',
        healthPath: '/health',
        statsPath: '/stats',
        scaling: {
          driver: 'redis',
          connection: 'broadcast',
        },
      },
    })
  })

  it('derives the pusher host from cluster when host is omitted', () => {
    expect(normalizeBroadcastConfig({
      default: 'pusher',
      connections: {
        pusher: {
          driver: 'pusher',
          key: 'pusher-key',
          secret: 'pusher-secret',
          appId: 'pusher-app',
          options: {
            cluster: 'eu',
          },
        },
      },
    })).toEqual({
      default: 'pusher',
      connections: {
        pusher: {
          name: 'pusher',
          driver: 'pusher',
          key: 'pusher-key',
          secret: 'pusher-secret',
          appId: 'pusher-app',
          options: {
            host: 'api-eu.pusher.com',
            port: 443,
            scheme: 'https',
            useTLS: true,
            cluster: 'eu',
          },
          clientOptions: {},
        },
      },
      worker: {
        host: '0.0.0.0',
        port: 8080,
        path: '/app',
        publicHost: undefined,
        publicPort: undefined,
        publicScheme: 'https',
        healthPath: '/health',
        statsPath: '/stats',
        scaling: false,
      },
    })
  })

  it('rejects malformed broadcast connections and worker config', () => {
    expect(normalizeBroadcastConfig()).toEqual({
      default: 'null',
      connections: {
        log: {
          name: 'log',
          driver: 'log',
          clientOptions: {},
        },
        null: {
          name: 'null',
          driver: 'null',
          clientOptions: {},
        },
      },
      worker: {
        host: '0.0.0.0',
        port: 8080,
        path: '/app',
        publicHost: undefined,
        publicPort: undefined,
        publicScheme: 'https',
        healthPath: '/health',
        statsPath: '/stats',
        scaling: false,
      },
    })

    expect(() => normalizeBroadcastConfig({
      default: 'missing',
    })).toThrow('default broadcast connection "missing" is not configured')

    expect(() => normalizeBroadcastConfig({
      connections: {
        '   ': {
          driver: 'null',
        },
      },
      default: 'null',
    })).toThrow('must be a non-empty string')

    expect(() => normalizeBroadcastConfig({
      connections: {
        ably: {
          driver: 'ably',
          key: 'ably-key',
        },
      },
      default: 'ably',
    })).toThrow('Broadcast driver "ably" is not supported yet')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: '   ' as never,
        },
      },
      default: 'broken',
    })).toThrow('must be a non-empty string')

    expect(normalizeBroadcastConfig({
      connections: {
        'tenant-a': {
          name: 'tenant-b',
          driver: 'null',
        },
      },
      default: 'tenant-a',
    })).toMatchObject({
      connections: {
        'tenant-a': {
          name: 'tenant-a',
        },
      },
    })

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'holo',
        },
      },
      default: 'broken',
    })).toThrow('must define a key')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'holo',
          key: 'key',
        },
      },
      default: 'broken',
    })).toThrow('must define a secret')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'holo',
          key: 'key',
          secret: 'secret',
        },
      },
      default: 'broken',
    })).toThrow('must define an appId')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'ably',
        },
      },
      default: 'broken',
    })).toThrow('Broadcast driver "ably" is not supported yet')

    expect(() => normalizeBroadcastConfig({
      worker: {
        port: 'zero',
      },
    })).toThrow('Broadcast worker port must be a positive number')

    expect(() => normalizeBroadcastConfig({
      worker: {
        publicScheme: 'ws' as never,
      },
    })).toThrow('must be "http" or "https"')

    expect(() => normalizeBroadcastConfig({
      worker: {
        scaling: {
          driver: 'memory' as never,
        },
      },
    })).toThrow('scaling driver must be "redis"')

    expect(normalizeBroadcastConfig({
      worker: {
        scaling: false,
      },
    }).worker.scaling).toBe(false)

    expect(normalizeBroadcastConfig({
      default: 'pusher',
      connections: {
        pusher: {
          driver: 'pusher',
          key: 'key',
          secret: 'secret',
          appId: 'app',
          options: {
            port: 443,
            scheme: 'https',
          },
        },
      },
      worker: {
        scaling: {
          driver: 'redis',
        },
      },
    })).toEqual({
      default: 'pusher',
      connections: {
        pusher: {
          name: 'pusher',
          driver: 'pusher',
          key: 'key',
          secret: 'secret',
          appId: 'app',
          options: {
            host: 'api-mt1.pusher.com',
            port: 443,
            scheme: 'https',
            useTLS: true,
            cluster: undefined,
          },
          clientOptions: {},
        },
      },
      worker: {
        host: '0.0.0.0',
        port: 8080,
        path: '/app',
        publicHost: undefined,
        publicPort: undefined,
        publicScheme: 'https',
        healthPath: '/health',
        statsPath: '/stats',
        scaling: {
          driver: 'redis',
          connection: 'default',
        },
      },
    })

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: undefined as never,
        },
      },
      default: 'broken',
    })).toThrow('Broadcast connections must define a name and driver')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'pusher',
        },
      },
      default: 'broken',
    })).toThrow('must define a key')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'pusher',
          key: 'key',
        },
      },
      default: 'broken',
    })).toThrow('must define a secret')

    expect(() => normalizeBroadcastConfig({
      connections: {
        broken: {
          driver: 'pusher',
          key: 'key',
          secret: 'secret',
        },
      },
      default: 'broken',
    })).toThrow('must define an appId')

    expect(normalizeBroadcastConfig({
      connections: {
        resend: {
          driver: 'custom',
          clientOptions: {
            timeout: 5_000,
          },
          region: 'us-east-1',
          endpoint: 'https://broadcast.example.test',
        },
      },
      default: 'resend',
    })).toEqual({
      default: 'resend',
      connections: {
        resend: {
          name: 'resend',
          driver: 'custom',
          clientOptions: {
            timeout: 5_000,
          },
          region: 'us-east-1',
          endpoint: 'https://broadcast.example.test',
        },
      },
      worker: {
        host: '0.0.0.0',
        port: 8080,
        path: '/app',
        publicHost: undefined,
        publicPort: undefined,
        publicScheme: 'https',
        healthPath: '/health',
        statsPath: '/stats',
        scaling: false,
      },
    })
  })

  it('defaults http endpoints to port 80 when no port is configured', () => {
    expect(normalizeBroadcastConfig({
      default: 'pusher',
      connections: {
        pusher: {
          driver: 'pusher',
          key: 'pusher-key',
          secret: 'pusher-secret',
          appId: 'pusher-app',
          options: {
            scheme: 'http',
          },
        },
      },
      worker: {
        publicScheme: 'http',
      },
    })).toMatchObject({
      connections: {
        pusher: {
          options: {
            port: 80,
            scheme: 'http',
            useTLS: false,
          },
        },
      },
      worker: {
        publicPort: 80,
        publicScheme: 'http',
      },
    })
  })
})
