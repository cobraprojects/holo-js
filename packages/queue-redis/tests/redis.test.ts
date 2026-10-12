import { Queue } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it, onTestFinished } from 'vitest'
import { startRedisService } from '../../session/tests/support/redis'
import { redisQueueDriverFactory, type QueueJobEnvelope } from '../src'

async function openQueue(options: { cluster?: boolean; tls?: boolean; socket?: boolean; host?: boolean } = {}) {
  const service = await startRedisService(options)
  const port = service.ports[0]
  if (port === undefined) throw new Error('Expected a Redis port')
  const queue = `holo-${randomUUID()}`
  const url = `${options.tls ? 'rediss' : 'redis'}://127.0.0.1:${service.ports[0]}`
  const driver = redisQueueDriverFactory.create({
    name: 'redis',
    driver: 'redis',
    connection: 'default',
    queue,
    retryAfter: 30,
    blockFor: 0,
    redis: options.cluster
      ? { host: '127.0.0.1', port, db: 0, clusters: service.ports.map(port => ({ host: '127.0.0.1', port, url: `${options.tls ? 'rediss' : 'redis'}://127.0.0.1:${port}` })) }
      : options.socket ? { host: service.socket, port, db: 0 } : options.host ? { host: '127.0.0.1', port, db: 0 } : { host: '127.0.0.1', port, url, db: 0 },
  }, { async execute() { throw new Error('Manual reservations do not execute jobs') } })
  onTestFinished(() => driver.close())
  const job = (payload = { message: 'hello' }): QueueJobEnvelope<typeof payload> => ({
    id: randomUUID(), name: 'deliver', connection: 'redis', queue, payload,
    attempts: 0, maxAttempts: 3, createdAt: Date.now(),
  })
  return { driver, service, queue, job }
}

describe('@holo-js/queue-redis native Redis behavior', () => {
  it.each([
    ['URL', {}],
    ['TCP configuration', { host: true }],
    ['Unix socket', { socket: true }],
    ['TLS', { tls: true }],
    ['cluster', { cluster: true }],
    ['TLS cluster', { cluster: true, tls: true }],
  ] as const)('dispatches and settles jobs over %s', async (_transport, options) => {
    const { driver, job } = await openQueue(options)
    const envelope = job()
    expect(await driver.dispatch(envelope)).toEqual({ jobId: envelope.id, synchronous: false })
    const reserved = await driver.reserve({ timeout: 0 })
    expect(reserved?.envelope).toMatchObject(envelope)
    expect(reserved).not.toBeNull()
    if (!reserved) throw new Error('Expected a reservation')
    await driver.acknowledge(reserved)
    expect(await driver.reserve({ timeout: 0 })).toBeNull()
    await expect(driver.acknowledge(reserved)).rejects.toThrow('not active')
  }, 30_000)

  it('reserves concurrent jobs exactly once and clears queued and delayed jobs', async () => {
    const { driver, job } = await openQueue()
    const jobs = [job(), job()]
    await Promise.all(jobs.map(envelope => driver.dispatch(envelope)))
    const reservations = await Promise.all([driver.reserve({}), driver.reserve({})])
    expect(reservations.map(item => item?.envelope.id).sort()).toEqual(jobs.map(item => item.id).sort())
    await Promise.all(reservations.map(async item => {
      if (!item) throw new Error('Expected a reservation')
      await driver.acknowledge(item)
    }))
    await driver.dispatch(job())
    await driver.dispatch({ ...job(), availableAt: Date.now() + 60_000 })
    expect(await driver.clear()).toBe(2)
    expect(await driver.clear()).toBe(0)
    expect(await driver.reserve({})).toBeNull()
  })

  it('delays jobs, releases them for retry, and removes deleted jobs', async () => {
    const { driver, job } = await openQueue()
    const envelope = { ...job(), availableAt: Date.now() + 300 }
    await driver.dispatch(envelope)
    expect(await driver.reserve({})).toBeNull()
    await setTimeout(350)
    const first = await driver.reserve({})
    if (!first) throw new Error('Expected a delayed reservation')
    await driver.release(first, { delaySeconds: 0.3 })
    expect(await driver.reserve({})).toBeNull()
    await setTimeout(350)
    const retry = await driver.reserve({})
    expect(retry?.envelope.id).toBe(envelope.id)
    expect(retry?.envelope.attempts).toBe(1)
    if (!retry) throw new Error('Expected a retry reservation')
    await driver.delete(retry)
    expect(await driver.reserve({})).toBeNull()
  })

  it.each(['acknowledge', 'release', 'delete'] as const)('keeps %s failures retryable after a lost native lock', async (action) => {
    const { driver, service, queue, job } = await openQueue()
    const envelope = job()
    await driver.dispatch(envelope)
    const reserved = await driver.reserve({})
    if (!reserved) throw new Error('Expected a reservation')
    const client = service.clients[0]
    if (!client) throw new Error('Expected a Redis connection')
    const lock = `bull:${queue}:${envelope.id}:lock`
    const token = await client.get(lock)
    expect(token).toBe(reserved.reservationId)
    if (!token) throw new Error('Expected a native job lock')
    await client.del(lock)
    await expect(driver[action](reserved)).rejects.toThrow(/lock/i)
    await client.set(lock, token, 'PX', 30_000)
    await driver[action](reserved)
    if (action === 'release') {
      const retry = await driver.reserve({})
      expect(retry?.envelope.id).toBe(envelope.id)
      if (!retry) throw new Error('Expected released job')
      await driver.acknowledge(retry)
    }
    expect(await driver.reserve({})).toBeNull()
  })

  it('honors reservation timeouts and closes blocking reservations', async () => {
    const { driver } = await openQueue()
    const start = Date.now()
    expect(await driver.reserve({ timeout: 0.2 })).toBeNull()
    expect(Date.now() - start).toBeGreaterThanOrEqual(150)
    const pending = driver.reserve({ timeout: 10 })
    await setTimeout(100)
    await driver.close()
    expect(await pending).toBeNull()
    await expect(driver.reserve({ timeout: -1 })).rejects.toThrow('non-negative')
  }, 15_000)

  it('rejects malformed jobs stored by a native BullMQ producer', async () => {
    const { driver, service, queue } = await openQueue()
    const port = service.ports[0]
    if (port === undefined) throw new Error('Expected a Redis port')
    const producer = new Queue(queue, { connection: { host: '127.0.0.1', port } })
    onTestFinished(() => producer.close())
    await producer.add('malformed', { payload: 'missing envelope metadata' })
    await expect(driver.reserve({})).rejects.toThrow('malformed payload')
  })

  it('rejects nonzero Redis cluster databases before opening a connection', () => {
    expect(() => redisQueueDriverFactory.create({
      name: 'redis', driver: 'redis', connection: 'default', queue: 'jobs', retryAfter: 30, blockFor: 0,
      redis: { host: '127.0.0.1', port: 6379, db: 1, clusters: [{ host: '127.0.0.1', port: 6379 }] },
    }, { async execute() { throw new Error('Manual reservations do not execute jobs') } })).toThrow('only supports database 0')
  })

})
