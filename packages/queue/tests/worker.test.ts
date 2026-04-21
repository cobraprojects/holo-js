import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  QueueDriverFactory,
  QueueJobEnvelope,
  QueueJsonValue,
  QueueReserveInput,
  QueueReservedJob,
  RegisterableQueueJobDefinition,
} from '../src'
import {
  clearQueueConnection,
  configureQueueRuntime,
  queueRuntimeInternals,
  queueWorkerInternals,
  QueueWorkerTimeoutError,
  QueueWorkerUnsupportedDriverError,
  registerQueueJob,
  resetQueueRuntime,
  runQueueWorker,
} from '../src'

const sharedRedisConfig = {
  default: 'default',
  connections: {
    default: {
      name: 'default',
      host: '127.0.0.1',
      port: 6379,
      password: undefined,
      username: undefined,
      db: 0,
    },
  },
} as const

type FakeAsyncDriverState = {
  reserveQueue: Array<QueueReservedJob<QueueJsonValue> | null>
  reserveInputs: Array<{ readonly queueNames: readonly string[], readonly workerId: string }>
  acknowledged: QueueReservedJob<QueueJsonValue>[]
  released: Array<{ job: QueueReservedJob<QueueJsonValue>, delaySeconds?: number }>
  deleted: QueueReservedJob<QueueJsonValue>[]
  clearCalls: Array<readonly string[] | undefined>
}

function createReservedJob(
  name: string,
  options: {
    id?: string
    attempts?: number
    connection?: string
    queue?: string
    payload?: QueueJsonValue
    maxAttempts?: number
  } = {},
): QueueReservedJob<QueueJsonValue> {
  const envelope: QueueJobEnvelope<QueueJsonValue> = {
    id: options.id ?? `${name}-id`,
    name,
    connection: options.connection ?? 'redis',
    queue: options.queue ?? 'default',
    payload: options.payload ?? { ok: true },
    attempts: options.attempts ?? 0,
    maxAttempts: options.maxAttempts ?? 3,
    createdAt: 100,
  }

  return {
    reservationId: `${envelope.id}-reservation`,
    envelope,
    reservedAt: 200,
  }
}

function createFakeAsyncDriverFactory(
  driverName: 'redis' | 'database',
  state: FakeAsyncDriverState,
): QueueDriverFactory {
  return {
    driver: driverName,
    create(connection, _context) {
      return {
        name: connection.name,
        driver: connection.driver,
        mode: 'async' as const,
        async dispatch(job) {
          return {
            jobId: job.id,
            synchronous: false,
          }
        },
        async clear(input) {
          state.clearCalls.push(input?.queueNames)
          return 7
        },
        async close() {},
        async reserve<TPayload extends QueueJsonValue = QueueJsonValue>(input: QueueReserveInput) {
          state.reserveInputs.push({
            queueNames: input.queueNames,
            workerId: input.workerId,
          })
          return (state.reserveQueue.shift() ?? null) as QueueReservedJob<TPayload> | null
        },
        async acknowledge(job) {
          state.acknowledged.push(job as QueueReservedJob<QueueJsonValue>)
        },
        async release(job, options) {
          state.released.push({
            job: job as QueueReservedJob<QueueJsonValue>,
            ...(typeof options?.delaySeconds === 'number' ? { delaySeconds: options.delaySeconds } : {}),
          })
        },
        async delete(job) {
          state.deleted.push(job as QueueReservedJob<QueueJsonValue>)
        },
      }
    },
  }
}

afterEach(() => {
  resetQueueRuntime()
  vi.useRealTimers()
})

function registerNamedJob<TPayload extends QueueJsonValue, TResult>(
  name: string,
  definition: RegisterableQueueJobDefinition<TPayload, TResult>,
) {
  return registerQueueJob(definition, { name })
}

describe('@holo-js/queue worker runtime', () => {
  it('processes async jobs, emits hooks, and clears named queues', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.process', {
          queue: 'critical',
          payload: { ok: true },
        }),
        null,
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onJobProcessed = vi.fn()
    const onIdle = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
            queue: 'default',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.process', {
      async handle(payload, context) {
        expect(payload).toEqual({ ok: true })
        expect(context.connection).toBe('redis')
        expect(context.queue).toBe('critical')
        expect(context.attempt).toBe(1)
        expect(context.maxAttempts).toBe(3)
      },
    })

    await expect(clearQueueConnection('redis', {
      queueNames: ['critical'],
    })).resolves.toBe(7)

    await expect(runQueueWorker({
      connection: 'redis',
      stopWhenEmpty: true,
      onIdle,
      onJobProcessed,
    })).resolves.toEqual({
      processed: 1,
      released: 0,
      failed: 0,
      stoppedBecause: 'empty',
    })

    expect(state.clearCalls).toEqual([['critical']])
    expect(state.acknowledged).toHaveLength(1)
    expect(state.released).toEqual([])
    expect(state.deleted).toEqual([])
    expect(onJobProcessed).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'jobs.process',
      queue: 'critical',
    }))
    expect(onIdle).toHaveBeenCalledTimes(1)
  })

  it('releases jobs for explicit release requests and retryable failures', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.release', {
          id: 'release-job',
          payload: { manual: true },
        }),
        createReservedJob('jobs.retry', {
          id: 'retry-job',
          attempts: 0,
          payload: { manual: false },
          maxAttempts: 4,
        }),
        createReservedJob('jobs.retry-no-backoff', {
          id: 'retry-no-backoff-job',
          attempts: 0,
          payload: { manual: 'no-backoff' },
          maxAttempts: 3,
        }),
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onJobReleased = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.release', {
      async handle(_payload, context) {
        await context.release(9)
      },
    })
    registerNamedJob('jobs.retry', {
      backoff: [5, 10, 15],
      async handle() {
        throw new Error('retry me')
      },
    })
    registerNamedJob('jobs.retry-no-backoff', {
      async handle() {
        throw new Error('retry me without backoff')
      },
    })
    registerNamedJob('jobs.release-then-throw', {
      async handle(_payload, context) {
        await context.release(4)
        throw new Error('released anyway')
      },
    })
    registerNamedJob('jobs.release-string', {
      async handle(_payload, context) {
        await context.release()
        throw 'string failure'
      },
    })
    registerNamedJob('jobs.release-no-delay', {
      async handle(_payload, context) {
        await context.release()
      },
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobReleased,
    })).resolves.toEqual({
      processed: 0,
      released: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobReleased,
    })).resolves.toEqual({
      processed: 0,
      released: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobReleased,
    })).resolves.toEqual({
      processed: 0,
      released: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    expect(state.released).toEqual([
      { job: expect.objectContaining({ envelope: expect.objectContaining({ id: 'release-job' }) }), delaySeconds: 9 },
      { job: expect.objectContaining({ envelope: expect.objectContaining({ id: 'retry-job' }) }), delaySeconds: 5 },
      { job: expect.objectContaining({ envelope: expect.objectContaining({ id: 'retry-no-backoff-job' }) }) },
    ])
    expect(onJobReleased).toHaveBeenNthCalledWith(1, expect.objectContaining({
      jobName: 'jobs.release',
      delaySeconds: 9,
    }))
    expect(onJobReleased).toHaveBeenNthCalledWith(2, expect.objectContaining({
      jobName: 'jobs.retry',
      delaySeconds: 5,
      error: expect.any(Error),
    }))
    expect(onJobReleased).toHaveBeenNthCalledWith(3, expect.objectContaining({
      jobName: 'jobs.retry-no-backoff',
      error: expect.any(Error),
    }))

    const directDriver = queueWorkerInternals.requireAsyncDriver(
      createFakeAsyncDriverFactory('redis', state).create({
        name: 'redis',
        driver: 'redis',
        connection: 'default',
        queue: 'default',
        retryAfter: 90,
        blockFor: 5,
        redis: {
          host: '127.0.0.1',
          port: 6379,
          db: 0,
        },
      }, queueRuntimeInternals.createQueueDriverFactoryContext()),
      'redis',
    )
    const releaseThenThrow = await queueWorkerInternals.processReservedJob(
      directDriver,
      createReservedJob('jobs.release-then-throw'),
      {
        onJobReleased,
      },
    )
    expect(releaseThenThrow).toEqual({
      kind: 'released',
      delaySeconds: 4,
      error: expect.any(Error),
    })
    expect(await queueWorkerInternals.processReservedJob(
      directDriver,
      createReservedJob('jobs.release-string'),
      {
        onJobReleased,
      },
    )).toEqual({
      kind: 'released',
      error: new Error('string failure'),
    })
    expect(await queueWorkerInternals.processReservedJob(
      directDriver,
      createReservedJob('jobs.release-no-delay'),
      {
        onJobReleased,
      },
    )).toEqual({
      kind: 'released',
    })
  })

  it('does not run completion hooks for jobs that request release', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.release-with-completion', {
          id: 'release-with-completion-job',
        }),
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onCompleted = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.release-with-completion', {
      onCompleted,
      async handle(_payload, context) {
        await context.release(3)
        return 'released'
      },
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
    })).resolves.toEqual({
      processed: 0,
      released: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    expect(state.released).toEqual([
      {
        job: expect.objectContaining({
          envelope: expect.objectContaining({ id: 'release-with-completion-job' }),
        }),
        delaySeconds: 3,
      },
    ])
    expect(state.acknowledged).toEqual([])
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('fails jobs permanently when attempts are exhausted or fail() is requested', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.fail-now', {
          id: 'fail-now',
        }),
        createReservedJob('jobs.exhausted', {
          id: 'exhausted',
          attempts: 1,
          maxAttempts: 2,
        }),
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onJobFailed = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.fail-now', {
      async handle(_payload, context) {
        await context.fail(new Error('manual failure'))
      },
    })
    registerNamedJob('jobs.exhausted', {
      async handle() {
        throw new Error('out of attempts')
      },
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed,
    })).resolves.toMatchObject({
      failed: 1,
      stoppedBecause: 'once',
    })
    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed,
    })).resolves.toMatchObject({
      failed: 1,
      stoppedBecause: 'once',
    })

    expect(state.deleted).toHaveLength(2)
    expect(onJobFailed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      jobName: 'jobs.fail-now',
      error: expect.any(Error),
    }))
    expect(onJobFailed).toHaveBeenNthCalledWith(2, expect.objectContaining({
      jobName: 'jobs.exhausted',
      attempt: 2,
      maxAttempts: 2,
    }))
  })

  it('runs terminal job failure hooks and successful completion hooks in workers', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.complete-hook', {
          id: 'complete-hook',
          payload: { ok: true },
        }),
        createReservedJob('jobs.fail-hook', {
          id: 'fail-hook',
          attempts: 1,
          maxAttempts: 2,
          payload: { ok: false },
        }),
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onCompleted = vi.fn()
    const onFailed = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.complete-hook', {
      async handle() {
        return 'done'
      },
      async onCompleted(payload, result, context) {
        onCompleted({ payload, result, attempt: context.attempt, connection: context.connection })
        throw new Error('completion hook failed')
      },
    })

    registerNamedJob('jobs.fail-hook', {
      async handle() {
        throw new Error('worker failed')
      },
      async onFailed(payload, error, context) {
        onFailed({ payload, error: error.message, attempt: context.attempt, maxAttempts: context.maxAttempts })
        throw new Error('failure hook failed')
      },
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
    })).resolves.toMatchObject({
      processed: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
    })).resolves.toMatchObject({
      processed: 0,
      failed: 1,
      stoppedBecause: 'once',
    })

    expect(onCompleted).toHaveBeenCalledWith({
      payload: { ok: true },
      result: 'done',
      attempt: 1,
      connection: 'redis',
    })
    expect(onFailed).toHaveBeenCalledWith({
      payload: { ok: false },
      error: 'worker failed',
      attempt: 2,
      maxAttempts: 2,
    })
    expect(warn).toHaveBeenCalledWith('[Holo Queue] onCompleted hook failed for job "jobs.complete-hook": completion hook failed')
    expect(warn).toHaveBeenCalledWith('[Holo Queue] onFailed hook failed for job "jobs.fail-hook": failure hook failed')
  })

  it('supports sleep, stop signals, max jobs, max time, and timeout overrides', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [null, null, createReservedJob('jobs.timeout', {
        id: 'timeout-job',
        payload: { ok: true },
      })],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const sleepFn = vi.fn(async (_milliseconds: number) => {})
    const onIdle = vi.fn()
    let stopRequested = false

    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            sleep: 3,
          },
        },
      },
      driverFactories: [
        createFakeAsyncDriverFactory('database', state),
      ],
    })

    registerNamedJob('jobs.timeout', {
      timeout: 5,
      async handle() {
        await new Promise(() => {})
      },
    })

    stopRequested = true
    await expect(runQueueWorker({
      connection: 'database',
      shouldStop: () => stopRequested,
    })).resolves.toEqual({
      processed: 0,
      released: 0,
      failed: 0,
      stoppedBecause: 'signal',
    })

    stopRequested = false
    await expect(runQueueWorker({
      connection: 'database',
      stopWhenEmpty: true,
      sleepFn,
      onIdle,
    })).resolves.toEqual({
      processed: 0,
      released: 0,
      failed: 0,
      stoppedBecause: 'empty',
    })

    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()

    state.reserveQueue = [null]
    let stopAfterSleep = false
    await expect(runQueueWorker({
      connection: 'database',
      sleepFn: async (milliseconds) => {
        sleepFn(milliseconds)
        stopAfterSleep = true
      },
      shouldStop: () => stopAfterSleep,
      onIdle,
    })).resolves.toEqual({
      processed: 0,
      released: 0,
      failed: 0,
      stoppedBecause: 'signal',
    })
    expect(sleepFn).toHaveBeenCalledWith(3_000)

    state.reserveQueue = [null]
    await expect(runQueueWorker({
      connection: 'database',
      once: true,
    })).resolves.toEqual({
      processed: 0,
      released: 0,
      failed: 0,
      stoppedBecause: 'once',
    })

    state.reserveQueue = [createReservedJob('jobs.timeout-max-jobs', { id: 'timeout-max-jobs' })]
    registerNamedJob('jobs.timeout-max-jobs', {
      async handle() {},
    })
    await expect(runQueueWorker({
      connection: 'database',
      maxJobs: 1,
      workerId: ' custom-worker ',
      sleepFn,
      shouldStop: () => false,
      stopWhenEmpty: false,
      once: false,
    })).resolves.toEqual({
      processed: 1,
      released: 0,
      failed: 0,
      stoppedBecause: 'max-jobs',
    })
    expect(state.reserveInputs.at(-1)).toEqual({
      queueNames: ['default'],
      workerId: 'custom-worker',
    })

    state.reserveQueue = [createReservedJob('jobs.timeout')]
    await expect(runQueueWorker({
      connection: 'database',
      once: true,
      timeout: 0,
      onJobFailed: vi.fn(),
    })).resolves.toMatchObject({
      failed: 1,
      stoppedBecause: 'once',
    })
    expect(state.released).toEqual([])
    expect(state.deleted.at(-1)?.envelope.id).toBe('jobs.timeout-id')

    vi.useFakeTimers()
    let resolveTimedOutJob!: () => void
    const onCompleted = vi.fn()
    state.reserveQueue = [createReservedJob('jobs.timeout-late-complete', { id: 'jobs.timeout-late-complete-id' })]
    registerNamedJob('jobs.timeout-late-complete', {
      async handle() {
        await new Promise<void>((resolve) => {
          resolveTimedOutJob = resolve
        })
      },
      async onCompleted() {
        onCompleted()
      },
    })

    const timedOutWorker = runQueueWorker({
      connection: 'database',
      once: true,
      timeout: 0,
    })
    await vi.advanceTimersByTimeAsync(1)
    await expect(timedOutWorker).resolves.toMatchObject({
      failed: 1,
      stoppedBecause: 'once',
    })
    expect(state.deleted.at(-1)?.envelope.id).toBe('jobs.timeout-late-complete-id')
    expect(onCompleted).not.toHaveBeenCalled()

    resolveTimedOutJob()
    await Promise.resolve()
    await Promise.resolve()
    expect(onCompleted).not.toHaveBeenCalled()
    vi.useRealTimers()

    expect(() => queueWorkerInternals.normalizeQueueNames(['  '], 'default')).toThrow('Queue worker queue names must be non-empty strings.')
    expect(queueWorkerInternals.normalizeQueueNames(undefined, undefined)).toEqual(['default'])
    expect(queueWorkerInternals.normalizeQueueNames([' default ', 'emails', 'default'], 'fallback')).toEqual(['default', 'emails'])
    expect(() => queueWorkerInternals.normalizeNonNegativeInteger(-1, 'Worker sleep')).toThrow('Worker sleep must be a non-negative integer.')
    expect(queueWorkerInternals.normalizeNonNegativeInteger(2, 'Worker sleep')).toBe(2)
    expect(() => queueWorkerInternals.normalizePositiveInteger(0, 'Worker maxJobs')).toThrow('Worker maxJobs must be a positive integer.')
    expect(queueWorkerInternals.resolveRetryDelaySeconds({ async handle() {} }, 1)).toBeUndefined()
    expect(queueWorkerInternals.resolveRetryDelaySeconds({ backoff: 7, async handle() {} }, 2)).toBe(7)
    expect(queueWorkerInternals.resolveRetryDelaySeconds({ backoff: [2, 4], async handle() {} }, 5)).toBe(4)
    expect(queueWorkerInternals.resolveWorkerStopReason({ maxJobs: 1 }, {
      processed: 1,
      startedAt: Date.now(),
    })).toBe('max-jobs')
    expect(queueWorkerInternals.resolveWorkerStopReason({ maxTime: 1 }, {
      processed: 0,
      startedAt: Date.now() - 1_500,
    })).toBe('max-time')
    await expect(queueWorkerInternals.runWithTimeout(Promise.resolve('ok'), 'jobs.ok', undefined)).resolves.toBe('ok')
    await expect(queueWorkerInternals.runWithTimeout(Promise.resolve('ok'), 'jobs.ok', 1)).resolves.toBe('ok')
    await expect(queueWorkerInternals.runWithTimeout(new Promise(resolve => setTimeout(() => resolve('ok'), 20)), 'jobs.ok', 0)).rejects.toBeInstanceOf(QueueWorkerTimeoutError)
  })

  it('rejects sync drivers and missing registered definitions clearly', async () => {
    configureQueueRuntime({
      config: {
        default: 'sync',
        connections: {
          sync: {
            driver: 'sync',
          },
        },
      },
    })

    await expect(runQueueWorker()).rejects.toBeInstanceOf(QueueWorkerUnsupportedDriverError)
    expect(() => queueWorkerInternals.requireRegisteredDefinition('missing.job')).toThrow('Queue job "missing.job" is not registered.')
    expect(() => queueWorkerInternals.requireAsyncDriver({
      name: 'sync',
      driver: 'sync',
      mode: 'sync',
      dispatch: async () => ({ jobId: 'job', synchronous: true }),
      clear: async () => 0,
      close: async () => {},
    }, 'sync')).toThrow('requires an async-capable driver')
    await expect(queueWorkerInternals.sleep(0)).resolves.toBeUndefined()
  })

  it('treats context.fail() as terminal even when the job catches the thrown error', async () => {
    const state: FakeAsyncDriverState = {
      reserveQueue: [
        createReservedJob('jobs.fail-caught', {
          id: 'fail-caught',
        }),
      ],
      reserveInputs: [],
      acknowledged: [],
      released: [],
      deleted: [],
      clearCalls: [],
    }
    const onJobFailed = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        failed: false,
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createFakeAsyncDriverFactory('redis', state),
      ],
    })

    registerNamedJob('jobs.fail-caught', {
      async handle(_payload, context) {
        try {
          await context.fail(new Error('manual failure'))
        } catch {
          return undefined
        }
      },
    })

    await expect(runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed,
    })).resolves.toMatchObject({
      processed: 0,
      released: 0,
      failed: 1,
      stoppedBecause: 'once',
    })

    expect(state.acknowledged).toEqual([])
    expect(state.deleted).toHaveLength(1)
    expect(state.deleted[0]?.envelope.id).toBe('fail-caught')
    expect(onJobFailed).toHaveBeenCalledWith(expect.objectContaining({
      jobName: 'jobs.fail-caught',
      error: expect.objectContaining({
        message: 'manual failure',
      }),
    }))
  })
})
