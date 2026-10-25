import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest'
import { canTrustTestCertificates, startRedisService } from './support/redis'
import type { SessionRecord, SessionStoreTakeResult } from '../src/contracts'
import { createSessionRedisAdapter } from '../src/drivers/redis-adapter'

type StoreOptions = { cluster?: boolean; socket?: boolean; url?: boolean; tls?: boolean }
type RedisService = Awaited<ReturnType<typeof startRedisService>>

async function createStore(options: StoreOptions = {}, running?: RedisService) {
  const service = running ?? await startRedisService(options)
  const port = service.ports[0]
  if (!port) throw new Error('Expected Redis service port')
  const prefix = `holo:session:${randomUUID()}:`
  const adapter = createSessionRedisAdapter({
    name: 'redis',
    driver: 'redis',
    connection: 'default',
    host: options.socket ? `unix://${service.socket}` : '127.0.0.1',
    port,
    url: (options.url || options.tls) && !options.cluster ? `${options.tls ? 'rediss' : 'redis'}://127.0.0.1:${port}` : undefined,
    db: 0,
    prefix,
    clusters: options.cluster ? service.ports.map(port => ({ host: '127.0.0.1', port, url: options.tls ? `rediss://127.0.0.1:${port}` : undefined })) : undefined,
  })
  onTestFinished(() => adapter.disconnect())
  await adapter.connect()
  const now = new Date()
  const record: SessionRecord = {
    id: randomUUID(),
    store: 'redis',
    data: { emptyItems: [], filters: {}, userId: 42 },
    createdAt: now,
    lastActivityAt: now,
    expiresAt: new Date(now.getTime() + 60_000),
  }
  return { adapter, record, service, prefix }
}

async function rotatesWithFlashData({ adapter, record }: Awaited<ReturnType<typeof createStore>>): Promise<void> {
  const rotated = { ...record, id: randomUUID() }
  await adapter.set(record)
  await adapter.flash(record.id, 'notice', 'preserved')
  await adapter.rotate(record.id, rotated)
  await expect(adapter.get(record.id)).resolves.toBeNull()
  await expect(adapter.get(rotated.id)).resolves.toEqual(rotated)
  await expect(adapter.take(rotated.id, 'notice')).resolves.toEqual({ found: true, value: 'preserved' })
  await adapter.rotate(rotated.id, { ...rotated, data: { refreshed: true } })
  await expect(adapter.get(rotated.id)).resolves.toMatchObject({ data: { refreshed: true } })
}

describe('session Redis behavior', () => {
  it.each([{ url: true }, { socket: true }, {}])('round trips exact JSON and deletes sessions using %j', async options => {
    const { adapter, record } = await createStore(options)
    await adapter.set(record)
    await expect(adapter.get(record.id)).resolves.toEqual(record)
    await adapter.flash(record.id, 'panels.effects.admin', [{ actions: [], metadata: {} }])
    await expect(adapter.take(record.id, 'panels.effects.admin')).resolves.toEqual({ found: true, value: [{ actions: [], metadata: {} }] })
    await adapter.del(record.id)
    await expect(adapter.get(record.id)).resolves.toBeNull()
    await adapter.close()
  })

  it('expires sessions on the real Redis clock without flash extending their lifetime', async () => {
    const { adapter, record, service, prefix } = await createStore()
    const client = service.clients[0]
    if (!client) throw new Error('Expected Redis client')
    const key = `${prefix}holo:session:${record.id}`
    await adapter.set(record)
    const lifetimeMs = await client.pttl(key)
    await adapter.flash(record.id, 'notice', 'Saved')
    await adapter.flash(record.id, 'pending', 'Unread')
    const remainingMs = await client.pttl(key)
    expect(remainingMs).toBeGreaterThan(0)
    expect(remainingMs).toBeLessThanOrEqual(lifetimeMs)
    await expect(adapter.take(record.id, 'notice')).resolves.toEqual({ found: true, value: 'Saved' })

    await adapter.set({ ...record, expiresAt: new Date(Date.now() - 1_000) })
    const expiringMs = await client.pttl(key)
    expect(expiringMs).not.toBe(-1)
    expect(expiringMs).toBeLessThanOrEqual(1)
    let present = await client.exists(key)
    while (present === 1) present = await client.exists(key)
    await expect(adapter.get(record.id)).resolves.toBeNull()
    await expect(adapter.take(record.id, 'pending')).resolves.toEqual({ found: false })
  })

  it('preserves pending flashes when the session is rewritten and atomically consumes each value once', async () => {
    const { adapter, record } = await createStore()
    await adapter.set(record)
    await adapter.flash(record.id, 'redirect', null)
    await adapter.set({ ...record, data: { userId: 42, refreshed: true } })
    const results = await Promise.all(Array.from({ length: 16 }, () => adapter.take(record.id, 'redirect')))
    expect(results.filter(result => result.found)).toEqual([{ found: true, value: null }])
    expect(results.filter(result => !result.found)).toHaveLength(15)
    await expect(adapter.get(record.id)).resolves.toMatchObject({ data: { refreshed: true } })
  })

  it.each([{ cluster: false }, { cluster: false, tls: true }].filter(options => !options.tls || canTrustTestCertificates))('moves a session and its private flash data to a new id and invalidates the old id through %j', async options => {
    await rotatesWithFlashData(await createStore(options))
  })

  it('consumes a flash value exactly once when it is taken while its session rotates', async () => {
    const { adapter, record } = await createStore()
    for (let round = 0; round < 25; round += 1) {
      const source = { ...record, id: randomUUID() }
      const destination = { ...record, id: randomUUID() }
      await adapter.set(source)
      await adapter.flash(source.id, 'once', round)
      const takenFromSource: SessionStoreTakeResult[] = []
      let rotating = true
      await Promise.all([
        adapter.rotate(source.id, destination).finally(() => { rotating = false }),
        ...Array.from({ length: 4 }, async () => {
          while (rotating) takenFromSource.push(await adapter.take(source.id, 'once'))
        }),
      ])
      const takenFromDestination = await adapter.take(destination.id, 'once')
      expect([...takenFromSource, takenFromDestination].filter(result => result.found)).toHaveLength(1)
      await expect(adapter.get(source.id)).resolves.toBeNull()
      await adapter.del(destination.id)
    }
  })

  it('completes rotation under continuous concurrent writes, removing the old id and keeping the data on the new id', async () => {
    const { adapter, record } = await createStore()
    const source = { ...record, id: randomUUID() }
    const destination = { ...record, id: randomUUID(), data: { userId: 42, rotated: true } }
    await adapter.set(source)
    let writing = true
    const writers = Array.from({ length: 4 }, async () => {
      for (let round = 0; writing; round += 1) {
        await adapter.flash(source.id, 'noise', round).catch(() => undefined)
      }
    })
    try {
      await adapter.rotate(source.id, destination)
    } finally {
      writing = false
      await Promise.all(writers)
    }
    await expect(adapter.get(source.id)).resolves.toBeNull()
    await expect(adapter.get(destination.id)).resolves.toEqual(destination)
  })

  it('creates no new session when rotating from a missing session', async () => {
    const { adapter, record } = await createStore()
    await expect(adapter.rotate('missing', record)).rejects.toThrow('was not found')
    await expect(adapter.get(record.id)).resolves.toBeNull()
  })

  it('keeps both sessions and their flashes intact when rotation would overwrite a destination', async () => {
    const { adapter, record } = await createStore()
    const destination = { ...record, id: randomUUID(), data: { userId: 99 } }
    await adapter.set(record)
    await adapter.set(destination)
    await adapter.flash(record.id, 'notice', 'source')
    await adapter.flash(destination.id, 'notice', 'destination')
    await expect(adapter.rotate('missing', destination)).rejects.toThrow('was not found')
    await expect(adapter.rotate(record.id, destination)).rejects.toThrow('already exists')
    await expect(adapter.get(record.id)).resolves.toEqual(record)
    await expect(adapter.get(destination.id)).resolves.toEqual(destination)
    await expect(adapter.take(record.id, 'notice')).resolves.toEqual({ found: true, value: 'source' })
    await expect(adapter.take(destination.id, 'notice')).resolves.toEqual({ found: true, value: 'destination' })
  })

  it('treats hostile flash keys and values as data and isolates configured prefixes', async () => {
    const { adapter, record, service } = await createStore()
    const port = service.ports[0]
    if (!port) throw new Error('Expected Redis service port')
    const other = createSessionRedisAdapter({ name: 'redis', driver: 'redis', connection: 'default', host: '127.0.0.1', port, db: 0, prefix: 'other:' })
    onTestFinished(() => other.disconnect())
    const hostileKey = "notice']; return redis.call('FLUSHALL'); --"
    const value = { body: "'); redis.call('FLUSHALL'); --" }
    await adapter.set(record)
    await other.set({ ...record, data: { userId: 99 } })
    await adapter.flash(record.id, hostileKey, value)
    await expect(adapter.take(record.id, hostileKey)).resolves.toEqual({ found: true, value })
    await expect(adapter.get(record.id)).resolves.toEqual(record)
    await expect(other.get(record.id)).resolves.toMatchObject({ data: { userId: 99 } })
  })

  it('fails closed for missing and corrupted persisted sessions', async () => {
    const { adapter, record, service, prefix } = await createStore()
    await expect(adapter.flash('missing', 'notice', 'Saved')).rejects.toThrow('was not found')
    await expect(adapter.take('missing', 'notice')).resolves.toEqual({ found: false })
    await expect(adapter.get('missing')).resolves.toBeNull()
    const client = service.clients[0]
    if (!client) throw new Error('Expected Redis client')
    for (const payload of ['{', JSON.stringify({ ...record, createdAt: 'not-a-date' }), JSON.stringify({ ...record, data: [] }), JSON.stringify({ ...record, expiresAt: 42 })]) {
      await client.hset(`${prefix}holo:session:${record.id}`, 'record', payload)
      await expect(adapter.get(record.id)).resolves.toBeNull()
    }
    await adapter.set(record)
    await expect(adapter.flash(record.id, 'notice', undefined)).rejects.toThrow('must be JSON serializable')
    await expect(adapter.get(record.id)).resolves.toEqual(record)
  })

  it.each([
    { db: 4, clusters: [{ host: '127.0.0.1', port: 6379 }], message: 'non-zero database' },
    { clusters: [{ host: '/tmp/redis.sock', port: 6379 }], message: 'cannot use a Unix socket path' },
    { clusters: [{ url: 'http://127.0.0.1:6379', host: '127.0.0.1', port: 6379 }], message: 'unsupported protocol' },
    { clusters: [{ url: 'redis:///', host: '127.0.0.1', port: 6379 }], message: 'missing hostname' },
  ])('rejects unsupported cluster configuration: $message', options => {
    expect(() => createSessionRedisAdapter({ name: 'redis', driver: 'redis', connection: 'default', host: '127.0.0.1', port: 6379, db: 0, prefix: '', ...options })).toThrow(options.message)
  })
})

describe('session Redis cluster behavior', () => {
  const variants = [{ cluster: true }, { cluster: true, tls: true }].filter(options => !options.tls || canTrustTestCertificates)
  const clusters = new Map<StoreOptions, RedisService>()
  const stops: Array<() => Promise<void>> = []

  beforeAll(async () => {
    await Promise.all(variants.map(async options => {
      clusters.set(options, await startRedisService(options, stop => { stops.push(stop) }))
    }))
  }, 30_000)

  afterAll(async () => {
    for (const stop of stops.reverse()) await stop()
  })

  it.each(variants)('moves a session and its private flash data to a new id and invalidates the old id through %j', async options => {
    const cluster = clusters.get(options)
    if (!cluster) throw new Error(`Expected a running Redis cluster for ${JSON.stringify(options)}`)
    await rotatesWithFlashData(await createStore(options, cluster))
  })
})
