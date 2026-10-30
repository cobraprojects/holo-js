import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { canTrustTestCertificates, startRedisService } from '../../session/tests/support/redis'
import { createRedisRateLimitStore } from '../src'
import { createSecurityRedisAdapter } from '../src/drivers/redis-adapter'
import { runRateLimitDriverContractSuite } from './support/driver-contract'

async function createAdapter(options: { cluster?: boolean; socket?: boolean; url?: boolean; db?: number; prefix?: string; tls?: boolean } = {}) {
  const service = await startRedisService(options)
  const port = service.ports[0]
  if (!port) throw new Error('Expected Redis port')
  const prefix = options.prefix ?? `holo:rate-limit:${randomUUID()}:`
  const adapter = createSecurityRedisAdapter({
    host: '127.0.0.1', port, db: options.db ?? 0, prefix,
    connection: options.socket ? `unix://${service.socket}` : options.url || options.tls ? `${options.tls ? 'rediss' : 'redis'}://127.0.0.1:${port}` : 'default',
    clusters: options.cluster ? service.ports.map(port => ({ host: '127.0.0.1', port, url: options.tls ? `rediss://127.0.0.1:${port}` : undefined })) : undefined,
  })
  return { adapter, service, prefix }
}

describe('Redis rate-limit behavior', () => {
  let currentAdapter: Awaited<ReturnType<typeof createAdapter>>['adapter'] | undefined

  runRateLimitDriverContractSuite({
    label: 'redis adapter',
    decaySeconds: 3,
    async createStore() {
      const { adapter } = await createAdapter()
      await adapter.connect()
      currentAdapter = adapter
      return createRedisRateLimitStore(adapter)
    },
    advanceSeconds(seconds) {
      return setTimeout(seconds * 1000)
    },
    async cleanup() {
      await currentAdapter?.close()
      currentAdapter = undefined
    },
  })

  it.each([{}, { url: true, db: 2 }, { socket: true, db: 3 }])('counts hits and clears buckets through %j', async options => {
    const { adapter } = await createAdapter(options)
    try {
      await adapter.connect()
      expect(await adapter.increment('login:127.0.0.1', { decaySeconds: 60 })).toEqual({ attempts: 1, ttlSeconds: 60 })
      expect(await adapter.increment('login:127.0.0.1', { decaySeconds: 60 })).toEqual({ attempts: 2, ttlSeconds: 60 })
      expect(await adapter.del('login:127.0.0.1')).toBe(1)
      expect(await adapter.del('login:127.0.0.1')).toBe(0)
      expect(await adapter.increment('login:127.0.0.1', { decaySeconds: 60 })).toEqual({ attempts: 1, ttlSeconds: 60 })
    } finally {
      await adapter.close()
    }
  })

  it('counts hits in the configured database when the URL names another one', async () => {
    const service = await startRedisService()
    const port = service.ports[0]
    const client = service.clients[0]
    if (!port || !client) throw new Error('Expected Redis port and client')
    const configuredDatabase = client.duplicate({ db: 2 })
    onTestFinished(() => configuredDatabase.disconnect())
    const prefix = `holo:rate-limit:${randomUUID()}:`
    const adapter = createSecurityRedisAdapter({
      url: `redis://127.0.0.1:${port}/0`, host: '127.0.0.1', port, db: 2, prefix, connection: 'default',
    })
    try {
      await adapter.connect()
      await adapter.increment('login:127.0.0.1', { decaySeconds: 60 })
      expect(await client.exists(`${prefix}login:127.0.0.1`)).toBe(0)
      expect(await configuredDatabase.exists(`${prefix}login:127.0.0.1`)).toBe(1)
    } finally {
      await adapter.close()
    }
  })

  it('counts every simultaneous attempt without overwriting hits', async () => {
    const { adapter } = await createAdapter()
    try {
      await adapter.connect()
      const hits = await Promise.all(Array.from({ length: 32 }, () => adapter.increment('login', { decaySeconds: 60 })))
      expect(hits.map(hit => hit.attempts).sort((left, right) => left - right)).toEqual(Array.from({ length: 32 }, (_, index) => index + 1))
      expect(hits.every(hit => hit.ttlSeconds === 60)).toBe(true)
    } finally {
      await adapter.close()
    }
  })

  it('keeps one counter per bucket however many hits the store records', async () => {
    const { adapter, service, prefix } = await createAdapter()
    const client = service.clients[0]
    if (!client) throw new Error('Expected Redis client')
    try {
      await adapter.connect()
      const store = createRedisRateLimitStore(adapter)
      for (let index = 0; index < 500; index += 1) {
        await store.hit('login', { maxAttempts: 1, decaySeconds: 60 })
      }

      expect(await client.type(`${prefix}login`)).toBe('string')
      expect(await client.get(`${prefix}login`)).toBe('500')
    } finally {
      await adapter.close()
    }
  })

  it.each([{ cluster: false }, { cluster: true }, { cluster: false, tls: true }, { cluster: true, tls: true }].filter(options => !options.tls || canTrustTestCertificates))('clears every matching bucket and preserves unrelated keys through %j', async options => {
    const { adapter, service } = await createAdapter(options)
    const { cluster } = options
    try {
      await adapter.connect()
      for (let index = 0; index < 30; index += 1) {
        await adapter.increment(`login:${index}`, { decaySeconds: 60 })
      }
      await adapter.increment('other:bucket', { decaySeconds: 60 })
      if (cluster) {
        expect((await Promise.all(service.clients.map(client => client.dbsize()))).every(size => size > 0)).toBe(true)
      }
      expect(await adapter.clearByPrefix('login:*')).toBe(30)
      expect(await adapter.clearByPrefix('login:')).toBe(0)
      expect((await adapter.increment('other:bucket', { decaySeconds: 60 })).attempts).toBe(2)
      expect(await adapter.clearAll()).toBe(1)
      expect(await adapter.clearAll()).toBe(0)
    } finally {
      await adapter.close()
    }
  }, 30_000)

  it('escapes glob metacharacters in configured and requested prefixes', async () => {
    const { adapter, service, prefix } = await createAdapter({ prefix: `holo:[tenant]*?:${randomUUID()}:` })
    const client = service.clients[0]
    if (!client) throw new Error('Expected Redis client')
    try {
      await adapter.connect()
      await adapter.increment('login:[user]*?', { decaySeconds: 60 })
      await adapter.increment('login:other', { decaySeconds: 60 })
      await client.set('unrelated:sentinel', 'preserved')
      await client.set(`${prefix.replace('[tenant]*?', 't')}login:[user]*?`, 'preserved')
      expect(await adapter.clearByPrefix('login:[user]*?')).toBe(1)
      expect(await adapter.clearAll()).toBe(1)
      expect(await client.get('unrelated:sentinel')).toBe('preserved')
      expect(await client.get(`${prefix.replace('[tenant]*?', 't')}login:[user]*?`)).toBe('preserved')
    } finally {
      await adapter.close()
    }
  })

  it('rejects real Redis command errors instead of reporting a successful limit check', async () => {
    const { adapter, service, prefix } = await createAdapter()
    const client = service.clients[0]
    if (!client) throw new Error('Expected Redis client')
    try {
      await adapter.connect()
      await client.hset(`${prefix}login`, 'field', 'value')
      await expect(adapter.increment('login', { decaySeconds: 60 })).rejects.toThrow(/WRONGTYPE/)
      expect(await client.hget(`${prefix}login`, 'field')).toBe('value')
      expect(await adapter.del('login')).toBe(1)
      expect((await adapter.increment('login', { decaySeconds: 60 })).attempts).toBe(1)
    } finally {
      await adapter.close()
    }
  })

  it.each([
    { db: 4, clusters: [{ host: '127.0.0.1', port: 6379 }], message: 'non-zero database' },
    { clusters: [{ host: '/tmp/redis.sock', port: 6379 }], message: 'cannot use a Unix socket path' },
    { clusters: [{ url: 'http://127.0.0.1:6379', host: '127.0.0.1', port: 6379 }], message: 'unsupported protocol' },
    { clusters: [{ url: 'redis:///', host: '127.0.0.1', port: 6379 }], message: 'missing hostname' },
  ])('rejects unsupported cluster configuration: $message', options => {
    expect(() => createSecurityRedisAdapter({ host: '127.0.0.1', port: 6379, connection: 'default', db: 0, prefix: '', ...options })).toThrow(options.message)
  })
})
