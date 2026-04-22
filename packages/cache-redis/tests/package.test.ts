import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
  const state = new Map<string, { value: string, expiresAt?: number }>()
  const lockOwners = new Map<string, string>()
  const calls = {
    constructorArgs: [] as unknown[][],
    del: [] as string[][],
    eval: [] as Array<[string, number, ...string[]]>,
    get: [] as string[],
    incrby: [] as Array<[string, number]>,
    scan: [] as Array<[string, string, string, string, number]>,
    set: [] as Array<[string, string, ...(string | number)[]]>,
  }

  function resolveExpiresAt(arguments_: readonly (string | number)[], now: number): number | undefined {
    const pxAtIndex = arguments_.findIndex(argument_ => argument_ === 'PXAT')
    if (pxAtIndex >= 0) {
      const expiresAt = arguments_[pxAtIndex + 1]
      return typeof expiresAt === 'number' ? expiresAt : undefined
    }

    const pxIndex = arguments_.findIndex(argument_ => argument_ === 'PX')
    if (pxIndex >= 0) {
      const ttlMilliseconds = arguments_[pxIndex + 1]
      return typeof ttlMilliseconds === 'number' ? now + ttlMilliseconds : undefined
    }

    return undefined
  }

  function hasNx(arguments_: readonly (string | number)[]): boolean {
    return arguments_.includes('NX')
  }

  function isExpired(key: string, now: number): boolean {
    const entry = state.get(key)
    if (!entry || typeof entry.expiresAt === 'undefined' || entry.expiresAt > now) {
      return false
    }

    state.delete(key)
    return true
  }

  class FakeRedis {
    static Cluster = class FakeRedisCluster {
      constructor(...args: unknown[]) {
        calls.constructorArgs.push(args)
      }

      async get(key: string): Promise<string | null> {
        return new FakeRedis().get(key)
      }

      async set(key: string, value: string, ...arguments_: readonly (string | number)[]): Promise<'OK' | null> {
        return new FakeRedis().set(key, value, ...arguments_)
      }

      async del(...keys: string[]): Promise<number> {
        return new FakeRedis().del(...keys)
      }

      async scan(
        cursor: string,
        matchLabel: string,
        pattern: string,
        countLabel: string,
        count: number,
      ): Promise<[string, string[]]> {
        return new FakeRedis().scan(cursor, matchLabel, pattern, countLabel, count)
      }

      async incrby(key: string, amount: number): Promise<number> {
        return new FakeRedis().incrby(key, amount)
      }

      async decrby(key: string, amount: number): Promise<number> {
        return new FakeRedis().decrby(key, amount)
      }

      async eval(script: string, numberOfKeys: number, ...arguments_: readonly string[]): Promise<number> {
        return new FakeRedis().eval(script, numberOfKeys, ...arguments_)
      }
    }

    constructor(...args: unknown[]) {
      calls.constructorArgs.push(args)
    }

    async get(key: string): Promise<string | null> {
      calls.get.push(key)
      if (isExpired(key, Date.now())) {
        return null
      }

      return state.get(key)?.value ?? null
    }

    async set(key: string, value: string, ...arguments_: readonly (string | number)[]): Promise<'OK' | null> {
      calls.set.push([key, value, ...arguments_])
      if (isExpired(key, Date.now())) {
        state.delete(key)
      }

      if (hasNx(arguments_) && state.has(key)) {
        return null
      }

      state.set(key, {
        value,
        expiresAt: resolveExpiresAt(arguments_, Date.now()),
      })
      if (key.includes(':lock:')) {
        lockOwners.set(key, value)
      }

      return 'OK'
    }

    async del(...keys: string[]): Promise<number> {
      calls.del.push(keys)
      let deleted = 0
      for (const key of keys) {
        if (state.delete(key)) {
          deleted += 1
          lockOwners.delete(key)
        }
      }

      return deleted
    }

    async scan(
      cursor: string,
      matchLabel: string,
      pattern: string,
      countLabel: string,
      count: number,
    ): Promise<[string, string[]]> {
      calls.scan.push([cursor, matchLabel, pattern, countLabel, count])
      const regex = new RegExp(`^${pattern.replace(/\\\*/g, '\\*').replace(/\*/g, '.*')}$`)
      const keys = [...state.keys()].filter(key => regex.test(key))
      return ['0', keys]
    }

    async incrby(key: string, amount: number): Promise<number> {
      calls.incrby.push([key, amount])
      const current = await this.get(key)
      const currentNumber = current === null ? 0 : Number(current)
      if (!Number.isInteger(currentNumber)) {
        throw new Error('ERR value is not an integer or out of range')
      }

      const nextValue = currentNumber + amount
      state.set(key, {
        value: String(nextValue),
        expiresAt: state.get(key)?.expiresAt,
      })
      return nextValue
    }

    async decrby(key: string, amount: number): Promise<number> {
      return this.incrby(key, -amount)
    }

    async eval(script: string, numberOfKeys: number, ...arguments_: readonly string[]): Promise<number> {
      calls.eval.push([script, numberOfKeys, ...arguments_])
      const [key, owner] = arguments_
      if (typeof key !== 'string' || typeof owner !== 'string') {
        return 0
      }

      if (lockOwners.get(key) !== owner) {
        return 0
      }

      lockOwners.delete(key)
      return state.delete(key) ? 1 : 0
    }
  }

  return {
    calls,
    FakeRedis,
    lockOwners,
    reset() {
      state.clear()
      lockOwners.clear()
      calls.constructorArgs.length = 0
      calls.del.length = 0
      calls.eval.length = 0
      calls.get.length = 0
      calls.incrby.length = 0
      calls.scan.length = 0
      calls.set.length = 0
    },
    state,
  }
})

vi.mock('ioredis', () => ({
  default: redisMock.FakeRedis,
}))

import { CacheInvalidNumericMutationError } from '@holo-js/cache'
import { createRedisCacheDriver, redisCacheDriverInternals } from '../src/index'

describe('@holo-js/cache-redis', () => {
  beforeEach(() => {
    redisMock.reset()
    vi.useRealTimers()
  })

  it('reads, writes, adds, forgets, and flushes within the configured prefix scope', async () => {
    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })

    expect(await driver.put({
      key: 'holo:cache:alpha',
      payload: '"one"',
      expiresAt: Date.now() + 60_000,
    })).toBe(true)
    expect(await driver.get('holo:cache:alpha')).toEqual({
      hit: true,
      payload: '"one"',
    })
    expect(await driver.add({
      key: 'holo:cache:alpha',
      payload: '"two"',
      expiresAt: Date.now() + 61_000,
    })).toBe(false)
    expect(await driver.add({
      key: 'holo:cache:beta',
      payload: '"two"',
      expiresAt: Date.now() + 61_000,
    })).toBe(true)
    expect(await driver.forget('holo:cache:beta')).toBe(true)
    expect(await driver.forget('holo:cache:beta')).toBe(false)

    await driver.put({
      key: 'other:gamma',
      payload: '"outside"',
    })
    await driver.flush()

    expect(await driver.get('holo:cache:alpha')).toEqual({ hit: false })
    expect(await driver.get('other:gamma')).toEqual({
      hit: true,
      payload: '"outside"',
    })
    expect(redisMock.calls.scan).toEqual([
      ['0', 'MATCH', 'holo:cache:*', 'COUNT', 100],
    ])
  })

  it('supports expiration and immediate-expiry writes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'))

    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })

    await driver.put({
      key: 'holo:cache:ttl',
      payload: '"ok"',
      expiresAt: Date.now() + 1_000,
    })
    expect(await driver.get('holo:cache:ttl')).toEqual({
      hit: true,
      payload: '"ok"',
    })

    vi.advanceTimersByTime(1_001)
    expect(await driver.get('holo:cache:ttl')).toEqual({ hit: false })

    await driver.put({
      key: 'holo:cache:expired',
      payload: '"gone"',
      expiresAt: Date.now() - 1,
    })
    expect(await driver.get('holo:cache:expired')).toEqual({ hit: false })

    expect(await driver.add({
      key: 'holo:cache:stale-add',
      payload: '"gone"',
      expiresAt: Date.now() - 1,
    })).toBe(true)
    expect(await driver.get('holo:cache:stale-add')).toEqual({ hit: false })
  })

  it('supports numeric mutation and rejects non-numeric values', async () => {
    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })

    expect(await driver.increment('holo:cache:counter', 2)).toBe(2)
    expect(await driver.decrement('holo:cache:counter', 1)).toBe(1)

    await driver.put({
      key: 'holo:cache:label',
      payload: '"text"',
    })
    await expect(driver.increment('holo:cache:label', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
    await expect(driver.decrement('holo:cache:label', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
  })

  it('implements redis-backed locks with owner-safe release and blocking', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-22T00:00:00.000Z'))

    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
      sleep: async (milliseconds) => {
        vi.advanceTimersByTime(milliseconds)
      },
      ownerFactory: (() => {
        let counter = 0
        return () => `owner-${++counter}`
      })(),
    })

    const firstLock = driver.lock('holo:cache:lock:report', 1)
    const secondLock = driver.lock('holo:cache:lock:report', 1)

    expect(await firstLock.get()).toBe(true)
    expect(await secondLock.get()).toBe(false)
    expect(await secondLock.release()).toBe(false)
    expect(await firstLock.release()).toBe(true)
    expect(await secondLock.get(async () => 'after-release')).toBe('after-release')

    const blockingLock = driver.lock('holo:cache:lock:wait', 0.02)
    expect(await blockingLock.get()).toBe(true)

    const waited = driver.lock('holo:cache:lock:wait', 0.02).block(0.05, async () => 'after-wait')
    await expect(waited).resolves.toBe('after-wait')

    const heldLock = driver.lock('holo:cache:lock:timeout', 1)
    expect(await heldLock.get()).toBe(true)
    await expect(driver.lock('holo:cache:lock:timeout', 1).block(0)).resolves.toBe(false)
  })

  it('prefers url, then clusters, then host/socket when creating redis clients', async () => {
    createRedisCacheDriver({
      name: 'by-url',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        url: 'redis://cache.internal:6380/2',
        host: '127.0.0.1',
        port: 6379,
        db: 2,
      },
    })

    createRedisCacheDriver({
      name: 'by-cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        clusters: [
          { url: 'rediss://cache-a.internal:6380', host: 'cache-a.internal', port: 6380 },
          { host: 'cache-b.internal', port: 6381 },
        ],
      },
    })

    createRedisCacheDriver({
      name: 'by-socket',
      connectionName: 'socket',
      prefix: 'holo:cache:',
      redis: {
        socketPath: '/tmp/redis.sock',
        host: '/tmp/redis.sock',
        port: 6379,
        db: 0,
      },
    })

    expect(redisMock.calls.constructorArgs).toEqual([
      [
        'redis://cache.internal:6380/2',
        {
          password: undefined,
          username: undefined,
          db: 2,
          lazyConnect: true,
          maxRetriesPerRequest: 3,
        },
      ],
      [
        [
          { host: 'cache-a.internal', port: 6380, tls: {} },
          { host: 'cache-b.internal', port: 6381 },
        ],
        {
          redisOptions: {
            password: undefined,
            username: undefined,
            lazyConnect: true,
            maxRetriesPerRequest: 3,
            tls: {},
          },
        },
      ],
      [
        {
          password: undefined,
          username: undefined,
          db: 0,
          path: '/tmp/redis.sock',
          connectionName: 'socket',
          lazyConnect: true,
          maxRetriesPerRequest: 3,
        },
      ],
    ])

    const hostDriver = createRedisCacheDriver({
      name: 'by-host',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })
    expect(await hostDriver.add({
      key: 'holo:cache:forever-add',
      payload: '"ok"',
    })).toBe(true)
  })

  it('exposes deterministic redis internals for escaping and cluster validation', () => {
    expect(redisCacheDriverInternals.escapeRedisGlob('cache:[*]?')).toBe('cache:\\[\\*\\]\\?')
    expect(redisCacheDriverInternals.toRedisSocketPath('unix:///tmp/redis.sock')).toBe('/tmp/redis.sock')
    expect(redisCacheDriverInternals.toRedisSocketPath('/tmp/redis.sock')).toBe('/tmp/redis.sock')
    expect(() => redisCacheDriverInternals.parseClusterNodeUrl('http://bad', 'node')).toThrow('unsupported protocol')
    expect(redisCacheDriverInternals.parseClusterNodeUrl('redis://cache.internal', 'node')).toEqual({
      host: 'cache.internal',
      port: 6379,
    })
    expect(() => redisCacheDriverInternals.parseClusterNodeUrl('redis://:6379', 'node')).toThrow('node is invalid')
    expect(redisCacheDriverInternals.resolveClusterStartupNodes({
      name: 'cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })).toEqual([])
    expect(() => redisCacheDriverInternals.resolveClusterStartupNodes({
      name: 'cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        clusters: [
          { socketPath: '/tmp/redis.sock', host: '/tmp/redis.sock', port: 6379 },
        ],
      },
    })).toThrow('cannot use a Unix socket path')
    expect(redisCacheDriverInternals.createRedisClusterOptions({
      name: 'cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
        clusters: [
          { host: 'cache.internal', port: 6379 },
        ],
      },
    })).toEqual({
      redisOptions: {
        password: undefined,
        username: undefined,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
      },
    })
    expect(() => redisCacheDriverInternals.createRedisClusterOptions({
      name: 'cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 1,
        clusters: [
          { host: 'cache.internal', port: 6379 },
        ],
      },
    })).toThrow('non-zero database')
    expect(redisCacheDriverInternals.createRedisClientOptions({
      name: 'socket',
      connectionName: 'unix:///tmp/redis.sock',
      prefix: 'holo:cache:',
      redis: {
        host: '/tmp/redis.sock',
        port: 6379,
        db: 0,
      },
    })).toMatchObject({
      path: '/tmp/redis.sock',
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    })
  })

  it('uses the default sleep implementation when no custom sleeper is provided', async () => {
    vi.useFakeTimers()

    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })

    const heldLock = driver.lock('holo:cache:lock:default-sleep', 1)
    expect(await heldLock.get()).toBe(true)

    const blocked = driver.lock('holo:cache:lock:default-sleep', 1).block(0.01)
    vi.advanceTimersByTime(11)
    await expect(blocked).resolves.toBe(false)
  })
})
