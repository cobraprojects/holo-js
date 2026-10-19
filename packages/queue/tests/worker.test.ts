import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import {
  clearQueueConnection,
  configureQueueRuntime,
  dispatch,
  listFailedQueueJobs,
  registerQueueJob,
  resetQueueRegistry,
  runQueueWorker,
  type QueueJobEnvelope,
  type QueueWorkerJobEvent,
} from '../src'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'

async function openWorker(options: { retryAfter?: number } = {}) {
  const harness = await createSQLiteQueueHarness({
    createFailedTable: true,
    ...(typeof options.retryAfter === 'number'
      ? { queueConfig: {
          default: 'database',
          failed: { driver: 'database', connection: 'default', table: 'failed_jobs' },
          connections: { database: { driver: 'database', connection: 'default', table: 'jobs', queue: 'default', retryAfter: options.retryAfter } },
        } }
      : {}),
  })
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

  it('uses the timeout override, leaves the reservation for recovery, and ignores late completion', async () => {
    const harness = await openWorker()
    let complete = 0
    let release: () => void = () => {}
    const pending = new Promise<void>(resolve => { release = resolve })
    registerQueueJob({ timeout: 5, handle: () => pending, onCompleted: () => { complete += 1 } }, { name: 'timeout' })
    await harness.enqueue('timeout')
    await expect(runQueueWorker({ once: true, timeout: 0 })).rejects.toThrow('exceeded timeout of 0 seconds')
    expect(await listFailedQueueJobs()).toEqual([])
    expect(await harness.readJobRows()).toEqual([expect.objectContaining({ reservation_id: expect.any(String) })])
    release()
    await setTimeout(20)
    expect(complete).toBe(0)
  })

  it('fails an unregistered job terminally and keeps working', async () => {
    const harness = await openWorker()
    const failures: QueueWorkerJobEvent[] = []
    let handled = 0
    registerQueueJob({ handle: () => { handled += 1 } }, { name: 'registered' })
    const missing = await harness.enqueue('missing', { createdAt: Date.now() - 1_000 })
    await harness.enqueue('registered')
    expect(await runQueueWorker({ stopWhenEmpty: true, onJobFailed: (event) => { failures.push(event) } }))
      .toEqual({ processed: 1, released: 0, failed: 1, stoppedBecause: 'empty' })
    expect(handled).toBe(1)
    expect(failures).toEqual([expect.objectContaining({ jobId: missing.id, jobName: 'missing', error: expect.objectContaining({ message: expect.stringContaining('is not registered') }) })])
    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: missing.id, exception: expect.stringContaining('is not registered') })])
  })

  it('redelivers an abandoned reservation after it expires and counts the abandoned attempt', async () => {
    const harness = await openWorker({ retryAfter: 1 })
    const attempts: number[] = []
    registerQueueJob({ handle: (_payload, context) => { attempts.push(context.attempt) } }, { name: 'abandoned' })
    await harness.enqueue('abandoned')
    expect(await harness.driver.reserve({ queueNames: ['default'], workerId: 'crashed-worker' })).not.toBeNull()
    expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 0, stoppedBecause: 'once' })
    await setTimeout(1_050)
    expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 1 })
    expect(attempts).toEqual([2])
    expect(await harness.readJobRows()).toEqual([])
  })

  it.each([
    ['job tries', {}],
    ['worker tries', { tries: 1 }],
  ] as const)('fails an abandoned reservation terminally once it reaches its %s', async (_label, workerOptions) => {
    const harness = await openWorker({ retryAfter: 1 })
    const events: string[] = []
    registerQueueJob({
      handle: () => { events.push('handle') },
      onFailed: (_payload, error) => { events.push(`failed:${error.message}`) },
    }, { name: 'exhausted' })
    const job = await harness.enqueue('exhausted', { maxAttempts: 'tries' in workerOptions ? 3 : 1 })
    expect(await harness.driver.reserve({ queueNames: ['default'], workerId: 'crashed-worker' })).not.toBeNull()
    await setTimeout(1_050)
    expect(await runQueueWorker({ ...workerOptions, once: true, onJobFailed: event => { events.push(`worker-failed:${event.attempt}/${event.maxAttempts}`) } }))
      .toMatchObject({ processed: 0, released: 0, failed: 1 })
    expect(events).toEqual([
      'failed:[Holo Queue] Queue job "exhausted" has been attempted too many times.',
      'worker-failed:2/1',
    ])
    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: job.id, exception: expect.stringContaining('attempted too many times') })])
  })

  it.each([{ queueNames: [' '] }, { sleep: -1 }, { sleep: 2_147_484 }, { maxJobs: 0 }, { maxTime: 0 }])('rejects invalid worker options %j before reserving a real job', async options => {
    const harness = await openWorker()
    await harness.enqueue('unreserved')
    await expect(runQueueWorker(options)).rejects.toThrow()
    expect((await harness.readJobRows())[0]?.reservation_id).toBeNull()
  })

  it('exits the worker on a job timeout and leaves the reservation to recovery, which runs the next attempt', async () => {
    const harness = await openWorker({ retryAfter: 2 })
    const attempts: number[] = []
    registerQueueJob({
      timeout: 1,
      handle(_payload, context) {
        attempts.push(context.attempt)
        if (context.attempt === 1) return new Promise<void>(() => {})
      },
    }, { name: 'hung' })
    const job = await harness.enqueue('hung', { maxAttempts: 2 })
    await expect(runQueueWorker({ once: true })).rejects.toThrow('[Holo Queue] Queue job "hung" exceeded timeout of 1 seconds.')
    expect(await harness.readJobRows()).toEqual([expect.objectContaining({ id: job.id, reservation_id: expect.any(String) })])
    expect(await listFailedQueueJobs()).toEqual([])
    await setTimeout(2_050)
    expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 1, failed: 0 })
    expect(attempts).toEqual([1, 2])
    expect(await harness.readJobRows()).toEqual([])
  })

  it('fails a timed-out job terminally once its attempts are used up by recovery', async () => {
    const harness = await openWorker({ retryAfter: 2 })
    registerQueueJob({
      timeout: 1,
      handle: () => new Promise<void>(() => {}),
    }, { name: 'hung-once' })
    const job = await harness.enqueue('hung-once', { maxAttempts: 1 })
    await expect(runQueueWorker({ once: true })).rejects.toThrow('exceeded timeout of 1 seconds')
    await setTimeout(2_050)
    expect(await runQueueWorker({ once: true })).toMatchObject({ processed: 0, failed: 1 })
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: job.id, exception: expect.stringContaining('attempted too many times') })])
  })

  it('fails a timed-out job immediately when failOnTimeout is set, then exits the worker', async () => {
    const harness = await openWorker({ retryAfter: 2 })
    const events: string[] = []
    registerQueueJob({
      timeout: 1,
      failOnTimeout: true,
      handle: () => new Promise<void>(() => {}),
      onFailed: (_payload, error) => { events.push(`failed:${error.message}`) },
    }, { name: 'fail-on-timeout' })
    const job = await harness.enqueue('fail-on-timeout', { maxAttempts: 3 })
    await expect(runQueueWorker({
      once: true,
      onJobFailed: event => { events.push(`worker-failed:${event.attempt}/${event.maxAttempts}`) },
    })).rejects.toThrow('exceeded timeout of 1 seconds')
    expect(events).toEqual([
      'failed:[Holo Queue] Queue job "fail-on-timeout" exceeded timeout of 1 seconds.',
      'worker-failed:1/3',
    ])
    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: job.id })])
  })

  it('rejects a worker timeout that is not below the connection retryAfter before reserving', async () => {
    const harness = await openWorker({ retryAfter: 2 })
    await harness.enqueue('unreserved')
    await expect(runQueueWorker({ once: true, timeout: 2 }))
      .rejects.toThrow('[Holo Queue] Queue worker timeout of 2 seconds must be less than connection "database" retryAfter of 2 seconds.')
    expect((await harness.readJobRows())[0]?.reservation_id).toBeNull()
  })

  it('rejects dispatching a job whose timeout is not below the connection retryAfter', async () => {
    const harness = await openWorker({ retryAfter: 2 })
    registerQueueJob({ timeout: 2, handle() {} }, { name: 'too-slow' })
    await expect(dispatch('too-slow', {}).dispatch())
      .rejects.toThrow('[Holo Queue] Queue job "too-slow" timeout of 2 seconds must be less than connection "database" retryAfter of 2 seconds.')
    expect(await harness.readJobRows()).toEqual([])
  })

  it('retries with the worker backoff only for a failed job that sets none of its own', async () => {
    await openWorker()
    const delays: Record<string, number | undefined> = {}
    registerQueueJob({ tries: 2, handle: () => { throw new Error('transient') } }, { name: 'worker-backoff' })
    registerQueueJob({ tries: 2, backoff: 5, handle: () => { throw new Error('transient') } }, { name: 'job-backoff' })
    await dispatch('worker-backoff', {}).dispatch()
    await dispatch('job-backoff', {}).dispatch()
    expect(await runQueueWorker({
      stopWhenEmpty: true,
      backoff: 7,
      onJobReleased: event => { delays[event.jobName] = event.delaySeconds },
    })).toMatchObject({ released: 2, failed: 0 })
    expect(delays).toEqual({ 'worker-backoff': 7, 'job-backoff': 5 })
  })

  it('applies dispatch tries to the queued attempt limit', async () => {
    const harness = await openWorker()
    registerQueueJob({ handle() {} }, { name: 'dispatch-tries' })
    await dispatch('dispatch-tries', {}, { tries: 4 }).dispatch()
    expect((await harness.readJobRows())[0]?.max_attempts).toBe(4)
  })

  it('rejects the actual synchronous driver', async () => {
    const harness = await openWorker()
    configureQueueRuntime({ config: { default: 'sync', failed: false, connections: { sync: { driver: 'sync' } } } })
    await expect(runQueueWorker({ once: true })).rejects.toThrow('requires an async-capable driver')
    expect(await harness.readJobRows()).toEqual([])
  })
})
