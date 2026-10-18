import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import {
  clearQueueConnection,
  configureQueueRuntime,
  listFailedQueueJobs,
  registerQueueJob,
  resetQueueRegistry,
  runQueueWorker,
  type QueueJobEnvelope,
  type QueueWorkerJobEvent,
} from '../src'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'

async function openWorker() {
  const harness = await createSQLiteQueueHarness({ createFailedTable: true })
  onTestFinished(() => harness.cleanup())
  const enqueue = async (name: string, options: Partial<QueueJobEnvelope<{ ok: boolean }>> = {}) => {
    const envelope: QueueJobEnvelope<{ ok: boolean }> = {
      id: randomUUID(), name, connection: 'database', queue: 'default', payload: { ok: true },
      attempts: 0, maxAttempts: 3, createdAt: Date.now(), ...options,
    }
    await harness.driver.dispatch(envelope)
    return envelope
  }
  return { ...harness, enqueue }
}

afterEach(() => {
  resetQueueRegistry()
  errorReportingInternals.configure(undefined)
})

describe('@holo-js/queue native worker behavior', () => {
  it.each(['acknowledge', 'release', 'persist', 'delete'] as const)('stops on a native %s failure without running finalization observers', async operation => {
    const harness = await openWorker()
    const events: string[] = []
    const name = `failure-${operation}`
    registerQueueJob({
      async handle(_payload, context) {
        if (operation === 'release') await context.release(4)
        if (operation === 'persist' || operation === 'delete') {
          try { await context.fail(new Error('terminal failure')) } catch { return }
        }
      },
      async onCompleted() { events.push('completed') },
      async onFailed() { events.push('failed') },
    }, { name })
    await harness.enqueue(name)
    const trigger = operation === 'persist'
      ? "BEFORE INSERT ON failed_jobs"
      : operation === 'release'
        ? 'BEFORE UPDATE ON jobs WHEN OLD.reservation_id IS NOT NULL AND NEW.reservation_id IS NULL'
        : 'BEFORE DELETE ON jobs'
    await harness.connection.getAdapter().execute(`CREATE TRIGGER reject_finalization ${trigger} BEGIN SELECT RAISE(ABORT, '${operation} unavailable'); END`)
    await expect(runQueueWorker({ once: true,
      async onJobProcessed() { events.push('processed') },
      async onJobReleased() { events.push('released') },
      async onJobFailed() { events.push('worker-failed') },
    })).rejects.toThrow(`${operation} unavailable`)
    const rows = await harness.readJobRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.reservation_id).toBeTypeOf('string')
    expect(await listFailedQueueJobs()).toHaveLength(operation === 'delete' ? 1 : 0)
    expect(events).toEqual(operation === 'acknowledge' ? ['completed'] : [])
  })

  it('processes real jobs in selected queues and delivers hooks in order', async () => {
    const harness = await openWorker()
    const events: string[] = []
    const observed: QueueWorkerJobEvent[] = []
    registerQueueJob({
      async handle(payload, context) {
        expect(payload).toEqual({ ok: true })
        expect(context).toMatchObject({ connection: 'database', queue: 'critical', attempt: 1, maxAttempts: 3 })
        events.push('handle')
      },
      async onCompleted() {
        expect(await harness.readJobRows()).toHaveLength(2)
        events.push('completed')
      },
    }, { name: 'process' })
    await harness.enqueue('process', { queue: 'critical' })
    await harness.enqueue('process', { queue: 'mail' })
    const result = await runQueueWorker({ queueNames: [' critical ', 'critical'], workerId: 'native-worker', stopWhenEmpty: true,
      onJobProcessed: event => { observed.push(event); events.push('processed') },
      onIdle: () => { events.push('idle') },
    })
    expect(result).toEqual({ processed: 1, released: 0, failed: 0, stoppedBecause: 'empty' })
    expect(events).toEqual(['handle', 'completed', 'processed', 'idle'])
    expect(observed).toEqual([expect.objectContaining({ jobName: 'process', queue: 'critical', attempt: 1 })])
    expect((await harness.readJobRows()).map(row => row.queue)).toEqual(['mail'])
    expect(await clearQueueConnection('database', { queueNames: ['critical'] })).toBe(0)
    expect(await clearQueueConnection('database', { queueNames: ['mail'] })).toBe(1)
    expect(await harness.readJobRows()).toEqual([])
  })

  it.each(['release', 'throw'] as const)('retries a native job after %s without running completion hooks prematurely', async action => {
    const harness = await openWorker()
    const attempts: number[] = []
    const events: string[] = []
    registerQueueJob({
      backoff: [1, 2],
      async handle(_payload, context) {
        attempts.push(context.attempt)
        if (context.attempt !== 1) return
        if (action === 'release') await context.release(1)
        else throw new Error('retry me')
      },
      onCompleted: () => { events.push('completed') },
    }, { name: 'retry' })
    await harness.enqueue('retry')
    expect(await runQueueWorker({ once: true, onJobReleased: () => { events.push('released') } })).toMatchObject({ released: 1, failed: 0 })
    expect(events).toEqual(['released'])
    expect(await harness.driver.reserve({})).toBeNull()
    expect((await harness.readJobRows())[0]?.attempts).toBe(1)
    await setTimeout(1_050)
    expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 1 })
    expect(attempts).toEqual([1, 2])
    expect(events).toEqual(['released', 'completed'])
    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([])
  })

  it.each(['exhausted', 'explicit', 'caught'] as const)('persists a terminal %s failure and removes its native reservation', async failure => {
    const harness = await openWorker()
    const events: string[] = []
    registerQueueJob({
      async handle(_payload, context) {
        const error = new Error('terminal failure')
        if (failure === 'caught') { try { await context.fail(error) } catch { return } }
        if (failure === 'explicit') await context.fail(error)
        throw error
      },
      onCompleted: () => { events.push('completed') },
      onFailed: (_payload, error) => { expect(error.message).toBe('terminal failure'); events.push('failed') },
    }, { name: 'terminal' })
    const job = await harness.enqueue('terminal', { attempts: failure === 'exhausted' ? 2 : 0 })
    expect(await runQueueWorker({ once: true, onJobFailed: () => { events.push('worker-failed') } })).toMatchObject({ failed: 1, released: 0 })
    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: job.id, exception: expect.stringContaining('terminal failure') })])
    expect(events).toEqual(['failed', 'worker-failed'])
  })

  it.each([
    ['processed', 'worker.onJobProcessed'],
    ['released', 'worker.onJobReleased'],
    ['failed', 'worker.onJobFailed'],
  ] as const)('keeps the native %s result settled and reports its throwing observer', async (outcome, operation) => {
    const reports: HoloErrorReportContext[] = []
    errorReportingInternals.configure({ report: (_error, context) => { reports.push(context) } })
    const harness = await openWorker()
    let handles = 0
    registerQueueJob({ async handle(_payload, context) {
      handles += 1
      if (outcome === 'released') await context.release(5)
      if (outcome === 'failed') await context.fail(new Error('terminal failure'))
    } }, { name: 'observer' })
    await harness.enqueue('observer')
    const failObserver = () => { throw new Error('observer failure') }
    expect(await runQueueWorker({ once: true, onJobProcessed: failObserver, onJobReleased: failObserver, onJobFailed: failObserver })).toMatchObject({ [outcome]: 1 })
    expect(handles).toBe(1)
    expect(await harness.readJobRows()).toHaveLength(outcome === 'released' ? 1 : 0)
    expect(await listFailedQueueJobs()).toHaveLength(outcome === 'failed' ? 1 : 0)
    expect(reports).toEqual([{ capability: 'queue', operation }])
  })

  it('stops at max jobs and leaves the next real job queued', async () => {
    const harness = await openWorker()
    let handled = 0
    registerQueueJob({ handle: () => { handled += 1 } }, { name: 'bounded' })
    await harness.enqueue('bounded')
    await harness.enqueue('bounded')
    expect(await runQueueWorker({ maxJobs: 1 })).toMatchObject({ processed: 1, stoppedBecause: 'max-jobs' })
    expect(handled).toBe(1)
    expect(await harness.readJobRows()).toHaveLength(1)
  })

  it.each([0, 1])('polls a real database with sleep %s until a producer dispatches a job', async sleep => {
    const harness = await openWorker()
    registerQueueJob({ handle: () => 'ok' }, { name: 'delayed-producer' })
    const producer = setTimeout(50).then(() => harness.enqueue('delayed-producer'))
    expect(await runQueueWorker({ sleep, maxJobs: 1 })).toMatchObject({ processed: 1, stoppedBecause: 'max-jobs' })
    await producer
    expect(await harness.readJobRows()).toEqual([])
  })

  it('honors a real elapsed max-time and a requested stop signal', async () => {
    await openWorker()
    expect(await runQueueWorker({ shouldStop: () => true })).toMatchObject({ processed: 0, stoppedBecause: 'signal' })
    const started = Date.now()
    expect(await runQueueWorker({ maxTime: 1, sleep: 1 })).toMatchObject({ processed: 0, stoppedBecause: 'max-time' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(await runQueueWorker({ once: true })).toMatchObject({ stoppedBecause: 'once' })
  })

  it('uses the timeout override, persists the timeout, and ignores late completion', async () => {
    const harness = await openWorker()
    let complete = 0
    let release: () => void = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    registerQueueJob({ timeout: 5, handle: () => pending, onCompleted: () => { complete += 1 } }, { name: 'timeout' })
    await harness.enqueue('timeout')
    expect(await runQueueWorker({ once: true, timeout: 0 })).toMatchObject({ failed: 1 })
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ exception: expect.stringContaining('exceeded timeout') })])
    expect(await harness.readJobRows()).toEqual([])
    release()
    await setTimeout(20)
    expect(complete).toBe(0)
  })

  it('rejects an unregistered job while keeping its native reservation recoverable', async () => {
    const harness = await openWorker()
    await harness.enqueue('missing')
    await expect(runQueueWorker({ once: true })).rejects.toThrow('is not registered')
    expect(await harness.readJobRows()).toHaveLength(1)
    expect(await listFailedQueueJobs()).toEqual([])
  })

  it.each([{ queueNames: [' '] }, { sleep: -1 }, { maxJobs: 0 }, { maxTime: 0 }])('rejects invalid worker options %j before reserving a real job', async options => {
    const harness = await openWorker()
    await harness.enqueue('unreserved')
    await expect(runQueueWorker(options)).rejects.toThrow()
    expect((await harness.readJobRows())[0]?.reservation_id).toBeNull()
  })

  it('rejects the actual synchronous driver', async () => {
    const harness = await openWorker()
    configureQueueRuntime({ config: { default: 'sync', failed: false, connections: { sync: { driver: 'sync' } } } })
    await expect(runQueueWorker({ once: true })).rejects.toThrow('requires an async-capable driver')
    expect(await harness.readJobRows()).toEqual([])
  })
})
