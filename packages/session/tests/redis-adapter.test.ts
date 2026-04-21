import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../src/contracts'

const redisMock = vi.hoisted(() => {
  const calls = {
    connect: 0,
    constructorArgs: [] as unknown[][],
    del: [] as string[],
    get: [] as string[],
    quit: 0,
    set: [] as Array<[string, string, 'PX', number]>,
  }

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
      }

      disconnect(): void {}
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
    }

    disconnect(): void {}
  }

  return {
    calls,
    FakeRedis,
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
    redisMock.calls.get.length = 0
    redisMock.calls.quit = 0
    redisMock.calls.set.length = 0
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
  })

  it('rejects non-zero redis db values in cluster mode and ignores invalid date payloads', () => {
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
  })
})
