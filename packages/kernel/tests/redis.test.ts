import { describe, expect, it, vi } from 'vitest'
import {
  defineRedisConfig,
  holoRedisDefaults,
  normalizeRedisConfig,
  resolveNormalizedRedisConnection,
} from '../src'

describe('@holo-js/kernel Redis contracts', () => {
  it('defines, defaults, and normalizes standalone, URL, socket, and cluster connections', () => {
    const config = defineRedisConfig({
      default: 'url',
      connections: {
        url: {
          url: 'redis://user:secret@cache.internal:6380/4',
          username: ' user ',
          password: ' secret ',
        },
        socket: {
          host: 'unix:///tmp/redis.sock',
        },
        pathSocket: {
          host: '/tmp/redis-path.sock',
        },
        noDatabase: {
          url: 'redis://cache.internal',
        },
        cluster: {
          clusters: [
            { host: 'cache-1.internal', port: '6381' },
            { url: 'redis://cache-2.internal' },
            {},
          ],
        },
      },
    })
    const normalized = normalizeRedisConfig(config)

    expect(Object.isFrozen(config)).toBe(true)
    expect(normalized.connections.url).toMatchObject({ db: 4, username: 'user', password: 'secret' })
    expect(normalized.connections.socket).toMatchObject({ socketPath: '/tmp/redis.sock' })
    expect(normalized.connections.pathSocket).toMatchObject({ socketPath: '/tmp/redis-path.sock' })
    expect(normalized.connections.cluster?.clusters).toEqual([
      { host: 'cache-1.internal', port: 6381 },
      { url: 'redis://cache-2.internal', host: '127.0.0.1', port: 6379 },
      { host: '127.0.0.1', port: 6379 },
    ])
    expect(normalizeRedisConfig()).toEqual(holoRedisDefaults)
    expect(resolveNormalizedRedisConnection(normalized, 'url', 'Redis connection')).toBe(normalized.connections.url)
  })

  it('rejects malformed targets, URLs, integers, clusters, defaults, and lookups', () => {
    expect(() => normalizeRedisConfig({ connections: { ' ': {} } })).toThrow('non-empty string')
    expect(() => normalizeRedisConfig({ connections: { cache: { url: 'http://cache.internal' } } })).toThrow('redis:// or rediss://')
    expect(() => normalizeRedisConfig({ connections: { cache: { url: 'not a url' } } })).toThrow('valid redis:// or rediss:// URL')
    expect(() => normalizeRedisConfig({ connections: { cache: { port: 'invalid' } } })).toThrow('must be an integer')
    expect(() => normalizeRedisConfig({ connections: { cache: { port: 0 } } })).toThrow('greater than or equal to 1')
    expect(() => normalizeRedisConfig({ connections: { cache: { url: 'redis://cache', socketPath: '/tmp/redis.sock' } } })).toThrow('exactly one target mode')
    expect(() => normalizeRedisConfig({ connections: { cache: { url: 'redis://cache/not-a-db' } } })).toThrow('single integer segment')
    expect(() => normalizeRedisConfig({ connections: { cache: { clusters: [{ socketPath: '/tmp/redis.sock' }] } } })).toThrow('cannot use socketPath')
    expect(() => normalizeRedisConfig({ connections: { cache: { clusters: [{ url: 'redis://cache/2' }] } } })).toThrow('cannot include a database path')
    expect(() => normalizeRedisConfig({ connections: { cache: { clusters: [{ host: 'cache' }], db: 2 } } })).toThrow('only supports database 0')
    expect(() => normalizeRedisConfig({ default: 'missing', connections: { cache: {} } })).toThrow('default redis connection')
    expect(() => resolveNormalizedRedisConnection(holoRedisDefaults, 'missing', 'Redis connection')).toThrow('is not configured')
  })

  it('falls back when a validated URL cannot be parsed for a database path', () => {
    let calls = 0
    vi.stubGlobal('URL', class UnstableUrl {
      protocol = 'redis:'
      pathname = '/4'

      constructor() {
        calls += 1
        if (calls > 1) throw 'parser failed'
      }
    })

    try {
      expect(normalizeRedisConfig({
        connections: {
          default: { url: 'redis://cache/4' },
        },
      }).connections.default?.db).toBe(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
