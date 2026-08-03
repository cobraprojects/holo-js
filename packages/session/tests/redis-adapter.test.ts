import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRecord } from '../src/contracts'

const redisMock = vi.hoisted(() => {
  const calls = {
    connect: 0,
    constructorArgs: [] as unknown[][],
    del: [] as string[],
    disconnect: 0,
    eval: [] as Array<readonly [string, number, ...Array<string | number>]>,
    quit: 0,
    write: [] as Array<[string, string, number]>,
  }

  let failQuit = false
  const storedHashes = new Map<string, Map<string, string>>()
  const ttlValues = new Map<string, number>()

  async function evalScript(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
    calls.eval.push([script, numberOfKeys, ...args])
    const key = args[0]
    if (typeof key !== 'string') throw new Error('missing redis key')

    if (script.includes('local previousKey = KEYS[1]')) {
      const nextKey = args[1]
      const encoded = args[2]
      const ttlMs = args[3]
      if (typeof nextKey !== 'string' || typeof encoded !== 'string' || typeof ttlMs !== 'number') {
        throw new Error('invalid atomic rotate arguments')
      }
      const previousHash = storedHashes.get(key)
      if (!previousHash?.has('record')) return 0
      if (script.includes("redis.call('HEXISTS', nextKey, 'record')") && storedHashes.get(nextKey)?.has('record')) return -1
      const nextHash = new Map(previousHash)
      nextHash.set('record', encoded)
      storedHashes.set(nextKey, nextHash)
      ttlValues.set(nextKey, ttlMs)
      storedHashes.delete(key)
      ttlValues.delete(key)
      return 1
    }

    if (script.includes("return redis.call('HGET'")) {
      return storedHashes.get(key)?.get('record') ?? null
    }

    if (script.includes('local nextRecord = ARGV[1]')) {
      const encoded = args[1]
      const ttlMs = args[2]
      if (typeof encoded !== 'string' || typeof ttlMs !== 'number') throw new Error('invalid write arguments')
      const hash = storedHashes.get(key) ?? new Map<string, string>()
      hash.set('record', encoded)
      storedHashes.set(key, hash)
      ttlValues.set(key, ttlMs)
      calls.write.push([key, encoded, ttlMs])
      return 1
    }

    const flashKey = args[1]
    if (typeof flashKey !== 'string') throw new Error('missing flash key')
    const field = `flash:${flashKey}`

    if (script.includes('local flashValue = ARGV[2]')) {
      const flashValue = args[2]
      if (typeof flashValue !== 'string') throw new Error('missing flash value')
      const hash = storedHashes.get(key)
      if (!hash?.has('record')) return 0
      hash.set(field, flashValue)
      return 1
    }

    const hash = storedHashes.get(key)
    const value = hash?.get(field)
    if (!hash?.has('record') || typeof value !== 'string') return [0]
    hash.delete(field)
    return [1, value]
  }

  class FakeRedis {
    static Cluster = class FakeRedisCluster {
      constructor(...args: unknown[]) {
        calls.constructorArgs.push(args)
      }

      async connect(): Promise<void> {
        calls.connect += 1
      }

      async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
        return evalScript(script, numberOfKeys, ...args)
      }

      async del(key: string): Promise<number> {
        calls.del.push(key)
        const deletedHash = storedHashes.delete(key)
        ttlValues.delete(key)
        return deletedHash ? 1 : 0
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

    async eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown> {
      return evalScript(script, numberOfKeys, ...args)
    }

    async del(key: string): Promise<number> {
      calls.del.push(key)
      const deletedHash = storedHashes.delete(key)
      ttlValues.delete(key)
      return deletedHash ? 1 : 0
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
    storedHashes,
    ttlValues,
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

function qualifyKey(sessionId: string, prefix = ''): string {
  return `${prefix}{holo-session}:${sessionId}`
}

describe('session redis adapter', () => {
  beforeEach(() => {
    redisMock.calls.connect = 0
    redisMock.calls.constructorArgs.length = 0
    redisMock.calls.del.length = 0
    redisMock.calls.disconnect = 0
    redisMock.calls.eval.length = 0
    redisMock.calls.quit = 0
    redisMock.calls.write.length = 0
    redisMock.failQuit = false
    redisMock.storedHashes.clear()
    redisMock.ttlValues.clear()
  })

  it('uses the system clock when no clock override is provided', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'default',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    })
    const now = new Date()
    await adapter.set(Object.freeze({
      ...createRecord(),
      expiresAt: new Date(now.getTime() + 60_000),
    }))
    expect(redisMock.calls.write[0]?.[2]).toBeGreaterThan(0)
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
    expect(redisMock.calls.write).toEqual([[
      qualifyKey('session_1', 'holo:sessions:'),
      expect.any(String),
      270000,
    ]])
    expect(redisMock.calls.del).toEqual([qualifyKey('session_1', 'holo:sessions:')])
    expect(redisMock.calls.quit).toBe(1)
  })

  it('atomically flashes and takes values without changing the session TTL', async () => {
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
    const redisKey = qualifyKey('session_1', 'holo:sessions:')

    await adapter.set(record)
    const initialTtl = redisMock.ttlValues.get(redisKey)
    await adapter.flash(record.id, 'panels.notice', { title: 'Saved', count: 1 })

    await expect(adapter.get(record.id)).resolves.toEqual(record)
    expect(redisMock.ttlValues.get(redisKey)).toBe(initialTtl)
    await expect(adapter.take(record.id, 'panels.notice')).resolves.toEqual({
      found: true,
      value: { title: 'Saved', count: 1 },
    })
    expect(redisMock.ttlValues.get(redisKey)).toBe(initialTtl)
    await expect(adapter.take(record.id, 'panels.notice')).resolves.toEqual({ found: false })
  })

  it('preserves pending flashes when an active session is rewritten', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const record = createRecord()

    await adapter.set(record)
    await adapter.flash(record.id, 'redirect', null)
    await adapter.set(Object.freeze({
      ...record,
      data: Object.freeze({ userId: 'user_1', refreshed: true }),
      expiresAt: new Date('2026-04-21T10:10:00.000Z'),
    }))

    await expect(adapter.take(record.id, 'redirect')).resolves.toEqual({ found: true, value: null })
    expect(redisMock.ttlValues.get(qualifyKey(record.id))).toBe(570000)
  })

  it('moves pending flashes when a session id is rotated', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const record = createRecord()
    const rotated = Object.freeze({ ...record, id: 'session_2' })

    await adapter.set(record)
    await adapter.flash(record.id, 'notice', 'preserved')
    const callsBeforeRotation = redisMock.calls.eval.length
    await adapter.rotate(record.id, rotated)

    await expect(adapter.get(record.id)).resolves.toBeNull()
    await expect(adapter.get(rotated.id)).resolves.toEqual(rotated)
    await expect(adapter.take(rotated.id, 'notice')).resolves.toEqual({ found: true, value: 'preserved' })
    expect(redisMock.calls.eval.slice(callsBeforeRotation, callsBeforeRotation + 1)).toEqual([
      [
        expect.stringContaining('local previousKey = KEYS[1]'),
        2,
        qualifyKey(record.id),
        qualifyKey(rotated.id),
        expect.any(String),
        270000,
      ],
    ])
  })

  it('does not replace an existing destination when the source session is missing', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const destination = Object.freeze({ ...createRecord(), id: 'session_2' })

    await adapter.set(destination)
    await expect(adapter.rotate('missing', Object.freeze({ ...destination, data: { replaced: true } }))).rejects.toThrow('Session "missing" was not found')

    await expect(adapter.get(destination.id)).resolves.toEqual(destination)
  })

  it('does not replace an existing destination when the source session exists', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const source = createRecord()
    const destination = Object.freeze({ ...source, id: 'session_2', data: Object.freeze({ userId: 'user_2' }) })

    await adapter.set(source)
    await adapter.set(destination)

    await expect(adapter.rotate(source.id, Object.freeze({ ...source, id: destination.id })))
      .rejects.toThrow('Session "session_2" already exists')
    await expect(adapter.get(source.id)).resolves.toEqual(source)
    await expect(adapter.get(destination.id)).resolves.toEqual(destination)
  })

  it('preserves exact JSON shapes in session records and panel effect payloads', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const record = Object.freeze({
      ...createRecord(),
      data: Object.freeze({ emptyItems: Object.freeze([]), filters: Object.freeze({}) }),
    })

    await adapter.set(record)
    await adapter.flash(record.id, 'panels.effects.admin', [{ actions: [], metadata: {} }])

    await expect(adapter.get(record.id)).resolves.toEqual(record)
    await expect(adapter.take(record.id, 'panels.effects.admin')).resolves.toEqual({
      found: true,
      value: [{ actions: [], metadata: {} }],
    })
    expect(redisMock.ttlValues.get(qualifyKey(record.id))).toBe(270000)
  })

  it('keeps flash keys and values in Redis arguments and allows only one atomic take', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    }, {
      now: () => new Date('2026-04-21T10:00:30.000Z'),
    })
    const record = createRecord()
    const hostileKey = "notice']; return redis.call('FLUSHALL'); --"

    await adapter.set(record)
    await adapter.flash(record.id, hostileKey, { body: "'); redis.call('FLUSHALL'); --" })
    const results = await Promise.all([
      adapter.take(record.id, hostileKey),
      adapter.take(record.id, hostileKey),
    ])

    expect(results).toContainEqual({ found: true, value: { body: "'); redis.call('FLUSHALL'); --" } })
    expect(results).toContainEqual({ found: false })
    expect(redisMock.calls.eval.at(-3)?.[0]).not.toContain(hostileKey)
  })

  it('rejects missing sessions and malformed Redis results without creating state', async () => {
    const adapter = createSessionRedisAdapter({
      name: 'cache',
      driver: 'redis',
      connection: 'default',
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      prefix: '',
    })

    await expect(adapter.flash('missing', 'notice', 'Saved')).rejects.toThrow('Session "missing" was not found')
    await expect(adapter.take('missing', 'notice')).resolves.toEqual({ found: false })
    expect(redisMock.storedHashes.has(qualifyKey('missing'))).toBe(false)
    expect(() => sessionRedisAdapterInternals.deserializeTakeResult('invalid')).toThrow('invalid atomic take result')
    expect(() => sessionRedisAdapterInternals.deserializeTakeResult([1])).toThrow('invalid atomic take value')
    expect(() => sessionRedisAdapterInternals.serializeFlashValue(undefined)).toThrow('must be JSON serializable')
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
