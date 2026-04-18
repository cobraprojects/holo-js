import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
  const calls = {
    connect: 0,
    constructorArgs: [] as unknown[][],
    del: [] as string[][],
    multi: [] as Array<{
      zadd: Array<[string, number, string]>
      zremrangebyscore: Array<[string, string | number, string | number]>
      zcard: string[]
      zrange: Array<[string, number, number, string]>
    }>,
    pexpireat: [] as Array<[string, number]>,
    quit: 0,
    scan: [] as Array<[string, string, string, string, number]>,
  }

  const execResponses: Array<Array<[null, number]> | null> = []
  const scanResponses: Array<[string, string[]]> = []

  class FakeRedis {
    constructor(...args: unknown[]) {
      calls.constructorArgs.push(args)
    }

    async connect(): Promise<void> {
      calls.connect += 1
    }

    multi() {
      const chain = {
        zadd: [] as Array<[string, number, string]>,
        zremrangebyscore: [] as Array<[string, string | number, string | number]>,
        zcard: [] as string[],
        zrange: [] as Array<[string, number, number, string]>,
      }
      calls.multi.push(chain)

      return {
        zadd(key: string, score: number, member: string) {
          chain.zadd.push([key, score, member])
          return this
        },
        zremrangebyscore(key: string, min: string | number, max: string | number) {
          chain.zremrangebyscore.push([key, min, max])
          return this
        },
        zcard(key: string) {
          chain.zcard.push(key)
          return this
        },
        zrange(key: string, start: number, stop: number, withScores: string) {
          chain.zrange.push([key, start, stop, withScores])
          return this
        },
        async exec() {
          if (execResponses.length > 0) {
            return execResponses.shift() ?? null
          }

          return [
            [null, 1],
            [null, 0],
            [null, 2],
            [null, ['17665', '1776517199500']],
            [null, 1],
          ]
        },
      }
    }

    async del(...keys: string[]): Promise<number> {
      calls.del.push(keys)
      return keys.length
    }

    async scan(
      cursor: string,
      matchLabel: string,
      pattern: string,
      countLabel: string,
      count: number,
    ): Promise<[string, string[]]> {
      calls.scan.push([cursor, matchLabel, pattern, countLabel, count])
      if (scanResponses.length > 0) {
        return scanResponses.shift() as [string, string[]]
      }

      return ['0', []]
    }

    async pexpireat(key: string, timestampMs: number): Promise<number> {
      calls.pexpireat.push([key, timestampMs])
      return 1
    }

    async quit(): Promise<void> {
      calls.quit += 1
    }
  }

  return {
    calls,
    execResponses,
    FakeRedis,
    scanResponses,
  }
})

vi.mock('ioredis', () => ({
  default: redisMock.FakeRedis,
}))

import { createSecurityRedisAdapter, securityRedisAdapterInternals } from '../src/drivers/redis-adapter'

describe('security redis adapter', () => {
  beforeEach(() => {
    redisMock.calls.connect = 0
    redisMock.calls.constructorArgs.length = 0
    redisMock.calls.del.length = 0
    redisMock.calls.multi.length = 0
    redisMock.calls.pexpireat.length = 0
    redisMock.calls.quit = 0
    redisMock.calls.scan.length = 0
    redisMock.execResponses.length = 0
    redisMock.scanResponses.length = 0
  })

  it('applies the configured prefix to redis keys and limiter clear scans', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()
    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).resolves.toEqual({
      attempts: 2,
      ttlSeconds: expect.any(Number),
    })
    await expect(adapter.del('limiter:login|user%3A1')).resolves.toBe(1)

    redisMock.scanResponses.push(['0', ['holo:rate-limit:limiter:login|foo']])
    await expect(adapter.clearByPrefix('limiter:login|')).resolves.toBe(1)
    await adapter.close()

    expect(redisMock.calls.connect).toBe(1)
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
    expect(redisMock.calls.multi).toEqual([{
      zadd: [expect.arrayContaining(['holo:rate-limit:limiter:login|user%3A1', expect.any(Number), expect.any(String)])],
      zremrangebyscore: [expect.arrayContaining(['holo:rate-limit:limiter:login|user%3A1', '-inf', expect.any(Number)])],
      zcard: ['holo:rate-limit:limiter:login|user%3A1'],
      zrange: [['holo:rate-limit:limiter:login|user%3A1', 0, 0, 'WITHSCORES']],
    }])
    expect(redisMock.calls.pexpireat).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1', expect.any(Number)],
    ])
    expect(redisMock.calls.del).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1'],
      ['holo:rate-limit:limiter:login|foo'],
    ])
    expect(redisMock.calls.scan).toEqual([
      ['0', 'MATCH', 'holo:rate-limit:limiter:login|*', 'COUNT', 100],
    ])
    expect(redisMock.calls.quit).toBe(1)
  })

  it('uses a configured redis connection URL instead of the default host tuple', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'redis://cache.internal:6380/4',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      'redis://cache.internal:6380/4',
      {
        password: undefined,
        username: undefined,
        db: 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
  })

  it('preserves the configured redis db when the connection is a URL', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 4,
      connection: 'redis://cache.internal:6380',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      'redis://cache.internal:6380',
      {
        password: undefined,
        username: undefined,
        db: 4,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
  })

  it('preserves the configured redis db for socket-style connections', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 4,
      connection: 'unix:///tmp/redis.sock',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      'unix:///tmp/redis.sock',
      {
        password: undefined,
        username: undefined,
        db: 4,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
  })

  it('forwards non-default connection names to ioredis for observability', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'cache',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()

    expect(redisMock.calls.constructorArgs).toEqual([[
      {
        host: '127.0.0.1',
        port: 6379,
        password: undefined,
        username: undefined,
        db: 0,
        connectionName: 'cache',
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    ]])
  })

  it('detects redis connection targets and only adds connection names for named profiles', () => {
    expect(securityRedisAdapterInternals.isRedisConnectionTarget('redis://cache.internal:6380/4')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisConnectionTarget('rediss://cache.internal:6380/4')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisConnectionTarget('unix:///tmp/redis.sock')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisConnectionTarget('/tmp/redis.sock')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisConnectionTarget('cache')).toBe(false)
    expect(securityRedisAdapterInternals.isRedisSocketConnectionTarget('redis://cache.internal:6380/4')).toBe(false)
    expect(securityRedisAdapterInternals.isRedisSocketConnectionTarget('rediss://cache.internal:6380/4')).toBe(false)
    expect(securityRedisAdapterInternals.isRedisSocketConnectionTarget('unix:///tmp/redis.sock')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisSocketConnectionTarget('/tmp/redis.sock')).toBe(true)
    expect(securityRedisAdapterInternals.isRedisSocketConnectionTarget('cache')).toBe(false)

    expect(securityRedisAdapterInternals.createRedisClientOptions({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      username: undefined,
      db: 0,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })

    expect(securityRedisAdapterInternals.createRedisClientOptions({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'cache',
      prefix: 'holo:rate-limit:',
    })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      username: undefined,
      db: 0,
      connectionName: 'cache',
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })

    expect(securityRedisAdapterInternals.createRedisClientOptions({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'rediss://cache.internal:6380/4',
      prefix: 'holo:rate-limit:',
    })).toEqual({
      password: undefined,
      username: undefined,
      db: 0,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })

    expect(securityRedisAdapterInternals.createRedisClientOptions({
      host: '127.0.0.1',
      port: 6379,
      db: 4,
      connection: 'unix:///tmp/redis.sock',
      prefix: 'holo:rate-limit:',
    })).toEqual({
      password: undefined,
      username: undefined,
      db: 4,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })
  })

  it('counts repeated hits within the same window instead of overwriting a single sorted-set member', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    await adapter.connect()
    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).resolves.toEqual({
      attempts: 2,
      ttlSeconds: expect.any(Number),
    })

    const zaddCalls = redisMock.calls.multi[0]?.zadd ?? []
    expect(zaddCalls).toHaveLength(1)
    expect(zaddCalls[0]?.[0]).toBe('holo:rate-limit:limiter:login|user%3A1')
    expect(zaddCalls[0]?.[2]).not.toMatch(/^\d+$/)
    expect(redisMock.calls.multi[0]?.zcard).toEqual(['holo:rate-limit:limiter:login|user%3A1'])
    expect(redisMock.calls.multi[0]?.zrange).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1', 0, 0, 'WITHSCORES'],
    ])
  })

  it('keeps redis bucket expiry anchored to the first hit time instead of the wall-clock boundary', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    }, {
      now: () => new Date('2026-04-18T12:59:59.500Z'),
    })

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, ['17665', '1776517199500']],
      [null, 1],
    ] as never)

    await adapter.connect()
    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 3600,
    })).resolves.toEqual({
      attempts: 2,
      ttlSeconds: 3600,
    })

    expect(redisMock.calls.pexpireat).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1', 1776520799500],
    ])
    expect(redisMock.calls.multi[0]?.zrange).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1', 0, 0, 'WITHSCORES'],
    ])
  })

  it('does not extend redis bucket expiry when a later hit lands in the same window', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    }, {
      now: () => new Date('2026-04-18T12:59:59.500Z'),
    })

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, ['17665', '1776517199500']],
    ] as never)

    await adapter.connect()
    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 3600,
    })).resolves.toEqual({
      attempts: 2,
      ttlSeconds: 3600,
    })

    expect(redisMock.calls.pexpireat).toEqual([
      ['holo:rate-limit:limiter:login|user%3A1', 1776520799500],
    ])
  })

  it('clears all prefixed rate-limit buckets and returns zero when no matching keys exist', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    redisMock.scanResponses.push([
      '13',
      [
        'holo:rate-limit:bucket:1',
      ],
    ])
    redisMock.scanResponses.push([
      '0',
      [
        'holo:rate-limit:bucket:2',
      ],
    ])
    redisMock.scanResponses.push([
      '0',
      [],
    ])

    await expect(adapter.clearAll()).resolves.toBe(2)
    await expect(adapter.clearAll()).resolves.toBe(0)

    expect(redisMock.calls.scan).toEqual([
      ['0', 'MATCH', 'holo:rate-limit:*', 'COUNT', 100],
      ['13', 'MATCH', 'holo:rate-limit:*', 'COUNT', 100],
      ['0', 'MATCH', 'holo:rate-limit:*', 'COUNT', 100],
    ])
    expect(redisMock.calls.del).toEqual([
      ['holo:rate-limit:bucket:1'],
      ['holo:rate-limit:bucket:2'],
    ])
  })

  it('fails closed when redis transactions fail and returns zero for empty prefix clears', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    redisMock.execResponses.push(null)
    redisMock.scanResponses.push(['0', []])

    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).rejects.toThrow('Redis transaction failed for increment')
    await expect(adapter.clearByPrefix('limiter:login|')).resolves.toBe(0)
    redisMock.scanResponses.push(['0', []])
    await expect(adapter.clearByPrefix('limiter:login|*')).resolves.toBe(0)
    expect(redisMock.calls.scan).toEqual([
      ['0', 'MATCH', 'holo:rate-limit:limiter:login|*', 'COUNT', 100],
      ['0', 'MATCH', 'holo:rate-limit:limiter:login|*', 'COUNT', 100],
    ])
  })

  it('escapes redis glob metacharacters before clearing by prefix', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    redisMock.scanResponses.push(['0', []])

    await expect(adapter.clearByPrefix('limiter:logi?n[1]*')).resolves.toBe(0)

    expect(redisMock.calls.scan).toEqual([
      ['0', 'MATCH', 'holo:rate-limit:limiter:logi\\?n\\[1\\]*', 'COUNT', 100],
    ])
  })

  it('rejects malformed scan replies from redis while clearing buckets', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    redisMock.scanResponses.push(['0', []] as never)
    redisMock.scanResponses.push(null as never)
    redisMock.scanResponses.push(['0', 'invalid'] as never)

    await expect(adapter.clearByPrefix('limiter:login|')).resolves.toBe(0)
    await expect(adapter.clearAll()).rejects.toThrow('invalid scan response')
    await expect(adapter.clearAll()).rejects.toThrow('invalid scan response')
  })

  it('rejects malformed oldest-hit replies from redis transactions', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    })

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, []],
    ] as never)

    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).rejects.toThrow('oldest rate-limit hit')

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, ['17665', 'not-a-number']],
    ] as never)

    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).rejects.toThrow('invalid oldest-hit score')

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, ['17665', { invalid: true }]],
    ] as never)

    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 60,
    })).rejects.toThrow('invalid oldest-hit score')
  })

  it('accepts numeric oldest-hit scores returned by redis transactions', async () => {
    const adapter = createSecurityRedisAdapter({
      host: '127.0.0.1',
      port: 6379,
      db: 0,
      connection: 'default',
      prefix: 'holo:rate-limit:',
    }, {
      now: () => new Date('2026-04-18T12:59:59.500Z'),
    })

    redisMock.execResponses.push([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, ['17665', 1776517199500]],
    ] as never)

    await expect(adapter.increment('limiter:login|user%3A1', {
      decaySeconds: 3600,
    })).resolves.toEqual({
      attempts: 2,
      ttlSeconds: 3600,
    })
  })
})
