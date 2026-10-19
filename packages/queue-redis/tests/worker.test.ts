import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import {
  configureQueueRuntime,
  listFailedQueueJobs,
  registerQueueJob,
  resetQueueRegistry,
  runQueueWorker,
  type NormalizedQueueRedisConnectionConfig,
  type QueueAsyncDriver,
  type QueueJobEnvelope,
  type QueueReservedJob,
} from '@holo-js/queue'
import { startRedisService } from '../../session/tests/support/redis'
import { createQueueDbRuntimeOptions } from '../../queue-db/src'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import { redisQueueDriverFactory } from '../src'

async function openRedisQueue() {
  const service = await startRedisService()
  const port = service.ports[0]
  if (port === undefined) throw new Error('Expected a Redis port')
  const queue = `holo-${randomUUID()}`
  const harness = await createSQLiteQueueHarness({
    createFailedTable: true,
    queueConfig: {
      default: 'redis',
      failed: { driver: 'database', connection: 'default', table: 'failed_jobs' },
      connections: {
        database: { driver: 'database', connection: 'default', table: 'jobs', queue: 'default' },
        redis: { driver: 'redis', queue, retryAfter: 1, blockFor: 0, redis: { host: '127.0.0.1', port, db: 0 } },
      },
    },
  })
  onTestFinished(() => harness.cleanup())
  configureQueueRuntime({ driverFactories: [...createQueueDbRuntimeOptions().driverFactories, redisQueueDriverFactory] })
  const connection: NormalizedQueueRedisConnectionConfig = {
    name: 'redis', driver: 'redis', connection: 'default', queue, retryAfter: 1, blockFor: 0,
    redis: { host: '127.0.0.1', port, db: 0 },
  }
  const openDriver = () => {
    const driver = redisQueueDriverFactory.create(connection, { async execute() { throw new Error('Manual reservations do not execute jobs') } })
    onTestFinished(() => driver.close())
    return driver
  }
  const envelopeFor = (name: string, options: Partial<QueueJobEnvelope<{ ok: boolean }>> = {}): QueueJobEnvelope<{ ok: boolean }> => ({
    id: randomUUID(), name, connection: 'redis', queue, payload: { ok: true },
    attempts: 0, maxAttempts: 3, createdAt: Date.now(), ...options,
  })
  return { openDriver, envelopeFor, harness }
}

async function reserveEventually(driver: QueueAsyncDriver): Promise<QueueReservedJob> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const reserved = await driver.reserve({})
    if (reserved) return reserved
    await setTimeout(100)
  }

  throw new Error('Expected the abandoned reservation to be redelivered')
}

async function abandon(driver: QueueAsyncDriver, reserve: (driver: QueueAsyncDriver) => Promise<QueueReservedJob | null>) {
  const reserved = await reserve(driver)
  if (!reserved) throw new Error('Expected a reservation to abandon')
  await driver.close()
  return reserved
}

afterEach(() => {
  resetQueueRegistry()
})

describe('@holo-js/queue-redis abandoned reservations', () => {
  it('redelivers a job abandoned by a stopped worker to a replacement worker', async () => {
    const { openDriver, envelopeFor } = await openRedisQueue()
    const attempts: number[] = []
    registerQueueJob({ handle: (_payload, context) => { attempts.push(context.attempt) } }, { name: 'abandoned' })
    const crashed = openDriver()
    const envelope = envelopeFor('abandoned')
    await crashed.dispatch(envelope)
    expect((await abandon(crashed, driver => driver.reserve({}))).envelope.id).toBe(envelope.id)
    expect(await runQueueWorker({ sleep: 0, maxJobs: 1, maxTime: 10 })).toMatchObject({ processed: 1, failed: 0, stoppedBecause: 'max-jobs' })
    expect(attempts).toEqual([2])
    expect(await openDriver().reserve({})).toBeNull()
  }, 30_000)

  it('keeps the reservation of a job running longer than retryAfter', async () => {
    const { openDriver, envelopeFor } = await openRedisQueue()
    let running = true
    let started: () => void = () => {}
    const handling = new Promise<void>(resolve => { started = resolve })
    registerQueueJob({ async handle() { started(); await setTimeout(3_000) } }, { name: 'long-running' })
    await openDriver().dispatch(envelopeFor('long-running'))
    const rival = openDriver()
    const stolen: string[] = []
    const watch = handling.then(async () => {
      while (running) {
        const reserved = await rival.reserve({})
        if (reserved) stolen.push(reserved.envelope.id)
        await setTimeout(100)
      }
    })
    try {
      expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 1, released: 0, failed: 0 })
    } finally {
      running = false
      started()
      await watch
    }
    expect(stolen).toEqual([])
    expect(await rival.reserve({})).toBeNull()
  }, 30_000)

  it('abandons the reservation when failed-job persistence rejects so another worker recovers it', async () => {
    const { openDriver, envelopeFor, harness } = await openRedisQueue()
    registerQueueJob({ async handle(_payload, context) { await context.fail(new Error('terminal failure')) } }, { name: 'unpersisted' })
    const envelope = envelopeFor('unpersisted')
    await openDriver().dispatch(envelope)
    await harness.connection.getAdapter().execute("CREATE TRIGGER reject_failed_jobs BEFORE INSERT ON failed_jobs BEGIN SELECT RAISE(ABORT, 'persist unavailable'); END")
    await expect(runQueueWorker({ once: true })).rejects.toThrow('persist unavailable')
    const recovered = await reserveEventually(openDriver())
    expect(recovered.envelope).toMatchObject({ id: envelope.id, attempts: 1 })
    expect(await listFailedQueueJobs()).toEqual([])
  }, 30_000)

  it('fails a repeatedly abandoned job terminally into failed-job storage once it reaches its tries', async () => {
    const { openDriver, envelopeFor } = await openRedisQueue()
    const events: string[] = []
    registerQueueJob({
      handle: () => { events.push('handle') },
      onFailed: (_payload, error) => { events.push(error.message) },
    }, { name: 'exhausted' })
    const envelope = envelopeFor('exhausted', { maxAttempts: 2 })
    const first = openDriver()
    await first.dispatch(envelope)
    await abandon(first, driver => driver.reserve({}))
    expect((await abandon(openDriver(), reserveEventually)).envelope.attempts).toBe(1)
    expect(await runQueueWorker({ sleep: 0, maxJobs: 1, maxTime: 10 })).toMatchObject({ processed: 0, failed: 1, stoppedBecause: 'max-jobs' })
    expect(events).toEqual(['[Holo Queue] Queue job "exhausted" has been attempted too many times.'])
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: envelope.id, exception: expect.stringContaining('attempted too many times') })])
    expect(await openDriver().reserve({})).toBeNull()
  }, 30_000)
})
