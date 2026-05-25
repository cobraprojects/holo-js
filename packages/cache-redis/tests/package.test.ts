import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
  class MockRedisClient {
    readonly get = vi.fn<(key: string) => Promise<string | null>>(async () => null)
    readonly set = vi.fn<(key: string, value: string, ...arguments_: readonly (string | number)[]) => Promise<'OK' | null>>(async () => 'OK')
    readonly del = vi.fn<(...keys: string[]) => Promise<number>>(async () => 0)
    readonly scan = vi.fn<(
      cursor: string,
      matchLabel: string,
      pattern: string,
      countLabel: string,
      count: number,
    ) => Promise<[string, string[]]>>(async () => ['0', []])
    readonly incrby = vi.fn<(key: string, amount: number) => Promise<number>>(async () => 0)
    readonly decrby = vi.fn<(key: string, amount: number) => Promise<number>>(async () => 0)
    readonly eval = vi.fn<(script: string, numberOfKeys: number, ...arguments_: readonly string[]) => Promise<number>>(async () => 0)
    readonly disconnect = vi.fn<() => void>()
    nodes?: ReturnType<typeof vi.fn<(role: 'master') => readonly MockRedisClient[]>>
  }

  const constructorArgs: unknown[][] = []
  const standaloneClients: MockRedisClient[] = []
  const clusterClients: MockRedisClient[] = []
  let clusterNodes: readonly MockRedisClient[] = []
  let exposeClusterNodes = true

  class FakeRedis extends MockRedisClient {
    static Cluster = class FakeRedisCluster extends MockRedisClient {
      readonly isCluster = true

      constructor(...args: unknown[]) {
        super()
        constructorArgs.push(args)
        clusterClients.push(this)
        if (exposeClusterNodes) {
          this.nodes = vi.fn<(role: 'master') => readonly MockRedisClient[]>(() => clusterNodes)
        }
      }
    }

    constructor(...args: unknown[]) {
      super()
      constructorArgs.push(args)
      standaloneClients.push(this)
    }
  }

  return {
    FakeRedis,
    clusterClients,
    constructorArgs,
    createClient() {
      return new MockRedisClient()
    },
    disableClusterNodes() {
      exposeClusterNodes = false
    },
    reset() {
      constructorArgs.length = 0
      standaloneClients.length = 0
      clusterClients.length = 0
      clusterNodes = []
      exposeClusterNodes = true
    },
    setClusterNodes(nodes: readonly MockRedisClient[]) {
      clusterNodes = nodes
    },
    standaloneClients,
  }
})

vi.mock('ioredis', () => ({
  default: redisMock.FakeRedis,
}))

import { CacheInvalidNumericMutationError } from '@holo-js/cache'
import { createRedisCacheDriver, redisCacheDriverInternals } from '../src/index'

const cacheDriverDisposeSymbol = Symbol.for('holo.cache.driver.dispose')

type RedisLockClient = Parameters<typeof redisCacheDriverInternals.createRedisLock>[0]

function lastStandaloneClient(): (typeof redisMock.standaloneClients)[number] {
  const client = redisMock.standaloneClients.at(-1)
  if (!client) {
    throw new Error('Expected a standalone Redis client to be created.')
  }

  return client
}

function lastClusterClient(): (typeof redisMock.clusterClients)[number] {
  const client = redisMock.clusterClients.at(-1)
  if (!client) {
    throw new Error('Expected a Redis cluster client to be created.')
  }

  return client
}

function createLockClient(): RedisLockClient {
  return {
    async get() {
      return null
    },
    async set() {
      return 'OK'
    },
    async del() {
      return 0
    },
    async scan() {
      return ['0', []]
    },
    async incrby() {
      return 0
    },
    async decrby() {
      return 0
    },
    async eval() {
      return 0
    },
  }
}

describe('@holo-js/cache-redis', () => {
  beforeEach(() => {
    redisMock.reset()
    vi.useRealTimers()
  })

  it('maps cache operations to the configured redis prefix scope', async () => {
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
    const client = lastStandaloneClient()

    client.get.mockResolvedValueOnce('"one"')
    client.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OK')
    client.del
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    client.scan.mockResolvedValueOnce(['0', ['holo:cache:alpha']])

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

    expect(client.set.mock.calls).toEqual([
      ['holo:cache:alpha', '"one"', 'PXAT', expect.any(Number)],
      ['holo:cache:alpha', '"two"', 'PXAT', expect.any(Number), 'NX'],
      ['holo:cache:beta', '"two"', 'PXAT', expect.any(Number), 'NX'],
      ['other:gamma', '"outside"'],
    ])
    expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'holo:cache:*', 'COUNT', 100)
    expect(client.del).toHaveBeenLastCalledWith('holo:cache:alpha')
  })

  it('disconnects its redis client through the runtime lifecycle hook', () => {
    const driver = createRedisCacheDriver({
      name: 'redis',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }) as ReturnType<typeof createRedisCacheDriver> & Record<symbol, () => void>
    const client = lastStandaloneClient()

    const dispose = driver[cacheDriverDisposeSymbol]
    if (!dispose) {
      throw new Error('Expected redis cache driver to expose its runtime lifecycle hook.')
    }

    dispose()

    expect(client.disconnect).toHaveBeenCalledOnce()
  })

  it('passes expiration options to redis and deletes immediate-expiry writes', async () => {
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
    const client = lastStandaloneClient()

    client.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK')

    await driver.put({
      key: 'holo:cache:ttl',
      payload: '"ok"',
      expiresAt: Date.now() + 1_000,
    })
    await driver.put({
      key: 'holo:cache:expired',
      payload: '"gone"',
      expiresAt: Date.now() - 1,
    })
    expect(await driver.add({
      key: 'holo:cache:live-add',
      payload: '"expired-replacement"',
      expiresAt: Date.now() - 1,
    })).toBe(false)
    expect(await driver.add({
      key: 'holo:cache:stale-add',
      payload: '"gone"',
      expiresAt: Date.now() - 1,
    })).toBe(true)

    expect(client.set.mock.calls).toEqual([
      ['holo:cache:ttl', '"ok"', 'PXAT', Date.now() + 1_000],
      ['holo:cache:live-add', '"expired-replacement"', 'PXAT', Date.now() - 1, 'NX'],
      ['holo:cache:stale-add', '"gone"', 'PXAT', Date.now() - 1, 'NX'],
    ])
    expect(client.del).toHaveBeenCalledWith('holo:cache:expired')
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
    const client = lastStandaloneClient()

    client.incrby
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(new Error('ERR value is not an integer or out of range'))
    client.decrby
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('WRONGTYPE Operation against a key holding the wrong kind of value'))

    expect(await driver.increment('holo:cache:counter', 2)).toBe(2)
    expect(await driver.decrement('holo:cache:counter', 1)).toBe(1)

    await expect(driver.increment('holo:cache:label', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
    await expect(driver.decrement('holo:cache:label', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
  })

  it('implements redis-backed locks with owner-safe release', async () => {
    const client = createLockClient()
    const set = vi.spyOn(client, 'set')
    const evaluate = vi.spyOn(client, 'eval')
    let counter = 0

    set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK')
    evaluate
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)

    const firstLock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:report',
      1,
      () => `owner-${++counter}`,
      async () => {},
      Date.now,
    )
    const secondLock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:report',
      1,
      () => `owner-${++counter}`,
      async () => {},
      Date.now,
    )

    expect(await firstLock.get()).toBe(true)
    expect(await secondLock.get()).toBe(false)
    expect(await secondLock.release()).toBe(false)
    expect(await firstLock.release()).toBe(true)
    expect(await secondLock.get(async () => 'after-release')).toBe('after-release')
    expect(evaluate).toHaveBeenCalledTimes(3)
  })

  it('uses injected sleep and clocks for blocking lock deadlines', async () => {
    let currentTime = 0
    const client = createLockClient()
    const set = vi.spyOn(client, 'set')
    const sleepCalls: number[] = []

    set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)

    const heldLock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:wait',
      0.02,
      () => 'owner-1',
      async (milliseconds) => {
        sleepCalls.push(milliseconds)
        currentTime += milliseconds
      },
      () => currentTime,
    )
    expect(await heldLock.get()).toBe(true)

    const waitedLock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:wait',
      0.02,
      () => 'owner-2',
      async (milliseconds) => {
        sleepCalls.push(milliseconds)
        currentTime += milliseconds
      },
      () => currentTime,
    )
    await expect(waitedLock.block(0.05, async () => 'after-wait')).resolves.toBe('after-wait')

    const clockLock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:clock',
      1,
      () => 'owner-3',
      async (milliseconds) => {
        sleepCalls.push(milliseconds)
        currentTime += milliseconds
      },
      () => currentTime,
    )
    expect(await clockLock.get()).toBe(true)
    await expect(redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:clock',
      1,
      () => 'owner-4',
      async (milliseconds) => {
        sleepCalls.push(milliseconds)
        currentTime += milliseconds
      },
      () => currentTime,
    ).block(0.02)).resolves.toBe(false)

    expect(sleepCalls).toEqual([10, 10, 10])
  })

  it('does not retry blocking lock acquisition after the wait deadline', async () => {
    let currentTime = 0
    let setCalls = 0
    const sleepCalls: number[] = []
    const client: RedisLockClient = {
      async get() {
        return null
      },
      async set() {
        setCalls += 1
        return setCalls === 1 ? null : 'OK'
      },
      async del() {
        return 0
      },
      async scan() {
        return ['0', []]
      },
      async incrby() {
        return 0
      },
      async decrby() {
        return 0
      },
      async eval() {
        return 0
      },
    }
    const callback = vi.fn()
    const lock = redisCacheDriverInternals.createRedisLock(
      client,
      'holo:cache:lock:deadline',
      1,
      () => 'owner-1',
      async (milliseconds) => {
        sleepCalls.push(milliseconds)
        currentTime += milliseconds
      },
      () => currentTime,
    )

    await expect(lock.block(0.005, callback)).resolves.toBe(false)
    expect(callback).not.toHaveBeenCalled()
    expect(setCalls).toBe(1)
    expect(sleepCalls).toEqual([5])
  })

  it('flushes every cluster master when using a redis cluster client', async () => {
    const firstNode = redisMock.createClient()
    const secondNode = redisMock.createClient()
    redisMock.setClusterNodes([firstNode, secondNode])
    firstNode.scan.mockResolvedValueOnce(['0', ['holo:cache:alpha']])
    secondNode.scan.mockResolvedValueOnce(['0', ['holo:cache:beta']])
    firstNode.del.mockResolvedValueOnce(1)
    secondNode.del.mockResolvedValueOnce(1)

    const driver = createRedisCacheDriver({
      name: 'redis-cluster',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        db: 0,
        clusters: [
          { host: 'cache-a.internal', port: 6379 },
        ],
      },
    })
    const clusterClient = lastClusterClient()

    await driver.flush()

    expect(clusterClient.nodes).toHaveBeenCalledWith('master')
    expect(firstNode.scan).toHaveBeenCalledWith('0', 'MATCH', 'holo:cache:*', 'COUNT', 100)
    expect(secondNode.scan).toHaveBeenCalledWith('0', 'MATCH', 'holo:cache:*', 'COUNT', 100)
    expect(firstNode.del).toHaveBeenCalledWith('holo:cache:alpha')
    expect(secondNode.del).toHaveBeenCalledWith('holo:cache:beta')
  })

  it('handles cluster clients that do not expose master node iteration', async () => {
    redisMock.disableClusterNodes()
    const driver = createRedisCacheDriver({
      name: 'redis-cluster',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        db: 0,
        clusters: [
          { host: 'cache-a.internal', port: 6379 },
        ],
      },
    })
    const clusterClient = lastClusterClient()

    await expect(driver.flush()).resolves.toBeUndefined()
    expect(clusterClient.nodes).toBeUndefined()
  })

  it('prefers url, then clusters, then host/socket when creating redis clients', async () => {
    createRedisCacheDriver({
      name: 'by-url',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        url: 'redis://cache.internal:6380/2',
        db: 2,
      },
    })

    createRedisCacheDriver({
      name: 'by-cluster',
      connectionName: 'cluster',
      prefix: 'holo:cache:',
      redis: {
        db: 0,
        clusters: [
          { url: 'rediss://cache-a.internal:6380' },
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
        db: 0,
      },
    })

    expect(redisMock.constructorArgs).toEqual([
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
    lastStandaloneClient().set.mockResolvedValueOnce('OK')
    expect(await hostDriver.add({
      key: 'holo:cache:forever-add',
      payload: '"ok"',
    })).toBe(true)
  })

  it('rejects ambiguous standalone and cluster redis targets', () => {
    expect(() => createRedisCacheDriver({
      name: 'ambiguous',
      connectionName: 'cache',
      prefix: 'holo:cache:',
      redis: {
        url: 'redis://cache.internal:6379/0',
        db: 0,
        clusters: [{ host: 'cache-a.internal', port: 6379 }],
      } as never,
    })).toThrow('either redis.url or redis.clusters')
  })

  it('rejects cluster node urls with credentials or db paths', () => {
    expect(() => redisCacheDriverInternals.parseClusterNodeUrl('redis://user:pass@cache.internal:6379', 'node')).toThrow(
      'must not include credentials or a Redis database/path',
    )
    expect(() => redisCacheDriverInternals.parseClusterNodeUrl('redis://cache.internal:6379/2', 'node')).toThrow(
      'must not include credentials or a Redis database/path',
    )
  })

  it('only wraps redis numeric type errors for increment and decrement', async () => {
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
    const client = lastStandaloneClient()

    client.incrby
      .mockRejectedValueOnce(new Error('WRONGTYPE boom'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
    client.decrby.mockRejectedValueOnce(new Error('ETIMEDOUT'))

    await expect(driver.increment('holo:cache:wrongtype', 1)).rejects.toThrow(CacheInvalidNumericMutationError)
    await expect(driver.increment('holo:cache:timeout', 1)).rejects.toThrow('ETIMEDOUT')
    await expect(driver.decrement('holo:cache:timeout', 1)).rejects.toThrow('ETIMEDOUT')
    expect(redisCacheDriverInternals.isRedisNumericMutationError(new Error('WRONGTYPE boom'))).toBe(true)
    expect(redisCacheDriverInternals.isRedisNumericMutationError(new Error('ETIMEDOUT'))).toBe(false)
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
        db: 0,
        clusters: [
          { socketPath: '/tmp/redis.sock', host: '/tmp/redis.sock', port: 6379 } as never,
        ],
      } as never,
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
      } as never,
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
    const client = lastStandaloneClient()

    client.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValueOnce(null)

    const heldLock = driver.lock('holo:cache:lock:default-sleep', 1)
    expect(await heldLock.get()).toBe(true)

    const blocked = driver.lock('holo:cache:lock:default-sleep', 1).block(0.01)
    vi.advanceTimersByTime(11)
    await expect(blocked).resolves.toBe(false)
  })
})
