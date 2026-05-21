import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../src/contracts'

const redisMock = vi.hoisted(() => {
  const calls = {
    connect: 0,
    constructorArgs: [] as unknown[][],
    del: [] as string[],
    disconnect: 0,
    get: [] as string[],
    quit: 0,
    set: [] as Array<[string, string, 'PX', number]>,
  }

  let failQuit = false
  const storedValues = new Map<string, string>()

  class FakeRedis {
    static Cluster = class FakeRedisCluster {
      constructor(...args: unknown[]) {
        calls.constructorArgs.push(args)
      }

      async connect(): Promise<void> {
        calls.connect += 1
      }

      async get(key: string): Promise<string | null> {
        calls.get.push(key)
        return storedValues.get(key) ?? null
      }

      async set(key: string, value: string, mode: 'PX', durationMs: number): Promise<'OK'> {
        calls.set.push([key, value, mode, durationMs])
        storedValues.set(key, value)
        return 'OK'
      }

      async del(key: string): Promise<number> {
        calls.del.push(key)
        return storedValues.delete(key) ? 1 : 0
      }

      async quit(): Promise<void> {
        calls.quit += 1
        if (failQuit) {
          throw new Error('quit failed')
        }
      }

      disconnect(): void {
        calls.disconnect += 1
      }
    }

    constructor(...args: unknown[]) {
      calls.constructorArgs.push(args)
    }

    async connect(): Promise<void> {
      calls.connect += 1
    }

    async get(key: string): Promise<string | null> {
      calls.get.push(key)
      return storedValues.get(key) ?? null
    }

    async set(key: string, value: string, mode: 'PX', durationMs: number): Promise<'OK'> {
      calls.set.push([key, value, mode, durationMs])
      storedValues.set(key, value)
      return 'OK'
    }

    async del(key: string): Promise<number> {
      calls.del.push(key)
      return storedValues.delete(key) ? 1 : 0
    }

    async quit(): Promise<void> {
      calls.quit += 1
      if (failQuit) {
        throw new Error('quit failed')
      }
    }

    disconnect(): void {
      calls.disconnect += 1
    }
  }

  return {
    calls,
    FakeRedis,
    get failQuit() {
      return failQuit
    },
    set failQuit(value: boolean) {
      failQuit = value
    },
    storedValues,
  }
})

vi.mock('ioredis', () => ({
  default: redisMock.FakeRedis,
}))

import { createSessionRedisAdapter, sessionRedisAdapterInternals } from '../src/drivers/redis-adapter'

function createRecord(): SessionRecord {
  return Object.freeze({
    id: 'session_1',
    store: 'redis',
    data: Object.freeze({ userId: 'user_1' }),
    createdAt: new Date('2026-04-21T10:00:00.000Z'),
    lastActivityAt: new Date('2026-04-21T10:00:00.000Z'),
    expiresAt: new Date('2026-04-21T10:05:00.000Z'),
  })
}

describe('session redis adapter', () => {
  beforeEach(() => {
    redisMock.calls.connect = 0
    redisMock.calls.constructorArgs.length = 0
    redisMock.calls.del.length = 0
    redisMock.calls.disconnect = 0
    redisMock.calls.get.length = 0
    redisMock.calls.quit = 0
    redisMock.calls.set.length = 0
    redisMock.failQuit = false
    redisMock.storedValues.clear()
  })

  it('serializes round trips and applies the configured prefix', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const record = createRecord()

    await adapter.connect()
    await adapter.set(record)
    await expect(adapter.get(record.id)).resolves.toEqual(record)
    await adapter.del(record.id)
    await expect(adapter.get(record.id)).resolves.toBeNull()
    await adapter.close()

    expect(redisMock.calls.constructorArgs).toEqual([[
      {
        host: '127.0.0.1',
        port: 6379,
        password: undefined,
        username: undefined,
        db: 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
    expect(redisMock.calls.set).toEqual([[
      'holo:sessions:session_1',
      expect.any(String),
      'PX',
      270000,
    ]])
    expect(redisMock.calls.get).toEqual([
      'holo:sessions:session_1',
      'holo:sessions:session_1',
    ])
    expect(redisMock.calls.del).toEqual(['holo:sessions:session_1'])
    expect(redisMock.calls.quit).toBe(1)
  })

  it('normalizes redis targets and handles adapter shutdown fallbacks', async () => {
    expect(sessionRedisAdapterInternals.isRedisUrlTarget('rediss://cache.internal:6380')).toBe(true)
    expect(sessionRedisAdapterInternals.isRedisUrlTarget('http://cache.internal:6380')).toBe(false)
    expect(sessionRedisAdapterInternals.isRedisSocketConnectionTarget('unix:///tmp/redis.sock')).toBe(true)
    expect(sessionRedisAdapterInternals.isRedisSocketConnectionTarget('/tmp/redis.sock')).toBe(true)
    expect(sessionRedisAdapterInternals.isRedisSocketConnectionTarget('127.0.0.1')).toBe(false)
    expect(sessionRedisAdapterInternals.toRedisSocketPath('unix:///tmp/redis.sock')).toBe('/tmp/redis.sock')
    expect(sessionRedisAdapterInternals.toRedisSocketPath('/tmp/redis.sock')).toBe('/tmp/redis.sock')
    expect(sessionRedisAdapterInternals.createStandaloneOptions({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: 'unix:///tmp/redis.sock',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
    })).toMatchObject({
      path: '/tmp/redis.sock',
    })

    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      url: 'redis://cache.internal:6380',
      db: 0,
      prefix: 'holo:sessions:',
    })
    redisMock.failQuit = true

    await adapter.close()
    await adapter.disconnect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      'redis://cache.internal:6380',
      {
        password: undefined,
        username: undefined,
        db: 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
    expect(redisMock.calls.disconnect).toBe(2)
  })

  it('propagates TLS options for rediss cluster nodes', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    })

    await adapter.connect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      [{
        host: 'cache.internal',
        port: 6380,
        tls: {},
      }],
      {
        redisOptions: {
          password: undefined,
          username: undefined,
          lazyConnect: true,
          maxRetriesPerRequest: 3,
          tls: {},
        },
      },
    ]])
  })

  it('marks rediss startup nodes and cluster options with tls metadata', () => {
    expect(sessionRedisAdapterInternals.resolveClusterStartupNodes({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    })).toEqual([{
      host: 'cache.internal',
      port: 6380,
      tls: {},
    }])

    expect(sessionRedisAdapterInternals.createClusterOptions({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        url: 'rediss://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    })).toEqual({
      redisOptions: {
        password: undefined,
        username: undefined,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        tls: {},
      },
    })
    expect(sessionRedisAdapterInternals.createClusterOptions({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        url: 'redis://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    })).toEqual({
      redisOptions: {
        password: undefined,
        username: undefined,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    })

    expect(sessionRedisAdapterInternals.resolveClusterStartupNodes({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        host: 'cache-a.internal',
        port: 6380,
      }],
    })).toEqual([{
      host: 'cache-a.internal',
      port: 6380,
    }])
    expect(sessionRedisAdapterInternals.resolveClusterStartupNodes({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
    })).toEqual([])
    expect(sessionRedisAdapterInternals.parseClusterNodeUrl(
      'redis://cache-b.internal',
      'Session Redis cluster node url',
    )).toEqual({
      host: 'cache-b.internal',
      port: 6379,
    })
  })

  it('rejects non-zero redis db values in cluster mode and ignores invalid date payloads', () => {
    const rememberedRecord = Object.freeze({
      ...createRecord(),
      rememberTokenHash: 'remember-token-hash',
    })
    expect(sessionRedisAdapterInternals.deserializeSessionRecord(
      sessionRedisAdapterInternals.serializeSessionRecord(rememberedRecord),
    )).toEqual(rememberedRecord)

    expect(() => sessionRedisAdapterInternals.createClusterOptions({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 4,
      prefix: 'holo:sessions:',
      clusters: [{
        url: 'redis://cache.internal:6380',
        host: 'cache.internal',
        port: 6380,
      }],
    })).toThrow('Redis Cluster does not support selecting a non-zero database')

    expect(sessionRedisAdapterInternals.deserializeSessionRecord(JSON.stringify({
      id: 'session_1',
      store: 'redis',
      data: { userId: 'user_1' },
      createdAt: 'not-a-date',
      lastActivityAt: '2026-04-21T10:00:00.000Z',
      expiresAt: '2026-04-21T10:05:00.000Z',
    }))).toBeNull()
    expect(sessionRedisAdapterInternals.deserializeSessionRecord(JSON.stringify({
      store: 'redis',
      data: { userId: 'user_1' },
      createdAt: '2026-04-21T10:00:00.000Z',
      lastActivityAt: '2026-04-21T10:00:00.000Z',
      expiresAt: '2026-04-21T10:05:00.000Z',
    }))).toBeNull()
    expect(sessionRedisAdapterInternals.deserializeSessionRecord(JSON.stringify({
      id: 'session_1',
      store: 'redis',
      data: [],
      createdAt: '2026-04-21T10:00:00.000Z',
      lastActivityAt: '2026-04-21T10:00:00.000Z',
      expiresAt: '2026-04-21T10:05:00.000Z',
    }))).toBeNull()
    expect(sessionRedisAdapterInternals.deserializeSessionRecord(JSON.stringify({
      id: 'session_1',
      store: 'redis',
      data: { userId: 'user_1' },
      createdAt: '2026-04-21T10:00:00.000Z',
      lastActivityAt: '2026-04-21T10:00:00.000Z',
      expiresAt: '2026-04-21T10:05:00.000Z',
      rememberTokenHash: 42,
    }))).toBeNull()
    expect(sessionRedisAdapterInternals.deserializeSessionRecord('{')).toBeNull()
    expect(() => sessionRedisAdapterInternals.resolveClusterStartupNodes({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: 'holo:sessions:',
      clusters: [{
        host: '/tmp/redis.sock',
        port: 6380,
      }],
    })).toThrow('cannot use a Unix socket path')
    expect(() => sessionRedisAdapterInternals.parseClusterNodeUrl(
      'http://cache.internal:6380',
      'Session Redis cluster node url',
    )).toThrow('unsupported protocol')
    expect(() => sessionRedisAdapterInternals.parseClusterNodeUrl(
      'redis:///',
      'Session Redis cluster node url',
    )).toThrow('missing hostname')
  })
})
