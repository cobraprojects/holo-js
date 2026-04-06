import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueueDriverFactory, QueueFailedJobStore, QueueReservedJob } from '../src'
import {
  configureQueueRuntime,
  flushFailedQueueJobs,
  forgetFailedQueueJob,
  listFailedQueueJobs,
  persistFailedQueueJob,
  queueFailedInternals,
  registerQueueJob,
  retryFailedQueueJobs,
  resetQueueRuntime,
} from '../src'

function createReservedJob(
  name: string,
  id = `${name}-id`,
): QueueReservedJob {
  return {
    reservationId: `${id}-reservation`,
    reservedAt: 1,
    envelope: {
      id,
      name,
      connection: 'redis',
      queue: 'default',
      payload: { ok: true },
      attempts: 1,
      maxAttempts: 2,
      createdAt: 100,
    },
  }
}

function createRedisDriverFactory(dispatched: ReturnType<typeof vi.fn>): QueueDriverFactory {
  return {
    driver: 'redis',
    create(connection) {
      return {
        name: connection.name,
        driver: connection.driver,
        mode: 'async' as const,
        async dispatch(job) {
          dispatched(job)
          return {
            jobId: job.id,
            synchronous: false,
          }
        },
        async clear() {
          return 0
        },
        async close() {},
        async reserve() {
          return null
        },
        async acknowledge() {},
        async release() {},
        async delete() {},
      }
    },
  }
}

afterEach(() => {
  resetQueueRuntime()
})

describe('@holo-js/queue failed job store runtime hooks', () => {
  it('returns standalone defaults when no failed job store is configured', async () => {
    await expect(persistFailedQueueJob(createReservedJob('jobs.none'), new Error('ignored'))).resolves.toBeNull()
    await expect(listFailedQueueJobs()).resolves.toEqual([])
    await expect(retryFailedQueueJobs('all')).resolves.toBe(0)
    await expect(forgetFailedQueueJob('missing')).resolves.toBe(false)
    await expect(flushFailedQueueJobs()).resolves.toBe(0)
    expect(queueFailedInternals.getFailedJobStore()).toBeUndefined()
  })

  it('persists, lists, retries, forgets, and flushes through the configured failed job store', async () => {
    const persistedRecord = {
      id: 'failed-1',
      jobId: 'jobs.retry-id',
      job: {
        id: 'jobs.retry-id',
        name: 'jobs.retry',
        connection: 'redis',
        queue: 'default',
        payload: { ok: true },
        attempts: 2,
        maxAttempts: 3,
        availableAt: 100,
        createdAt: 50,
      },
      exception: 'boom',
      failedAt: 200,
    } as const
    const dispatched = vi.fn()
    const store: QueueFailedJobStore = {
      persistFailedJob: vi.fn(async () => persistedRecord),
      listFailedJobs: vi.fn(async () => Object.freeze([persistedRecord])),
      retryFailedJobs: vi.fn(async (_identifier, retry) => {
        await retry(persistedRecord)
        return 1
      }),
      forgetFailedJob: vi.fn(async (id) => id === 'failed-1'),
      flushFailedJobs: vi.fn(async () => 3),
    }

    registerQueueJob({
      async handle() {},
    }, {
      name: 'jobs.retry',
    })

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
      driverFactories: [createRedisDriverFactory(dispatched)],
      failedJobStore: store,
    })

    await expect(persistFailedQueueJob(createReservedJob('jobs.retry', 'jobs.retry-id'), new Error('boom'))).resolves.toEqual(persistedRecord)
    await expect(listFailedQueueJobs()).resolves.toEqual([persistedRecord])
    await expect(retryFailedQueueJobs('all')).resolves.toBe(1)
    await expect(forgetFailedQueueJob('failed-1')).resolves.toBe(true)
    await expect(flushFailedQueueJobs()).resolves.toBe(3)
    expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({
      id: 'jobs.retry-id',
      attempts: 0,
      createdAt: expect.any(Number),
      availableAt: undefined,
    }))
    expect(store.retryFailedJobs).toHaveBeenCalledTimes(1)
    expect(queueFailedInternals.createRetriedEnvelope(persistedRecord)).toMatchObject({
      id: 'jobs.retry-id',
      attempts: 0,
      availableAt: undefined,
    })
  })

  it('wraps store failures and preserves existing QueueFailedStoreError instances', async () => {
    const wrapped = queueFailedInternals.wrapFailedStoreError('flush failed jobs', new Error('boom'))
    const store: QueueFailedJobStore = {
      async persistFailedJob() {
        throw new Error('persist failed')
      },
      async listFailedJobs() {
        throw new Error('list failed')
      },
      async retryFailedJobs() {
        throw wrapped
      },
      async forgetFailedJob() {
        throw new Error('forget failed')
      },
      async flushFailedJobs() {
        throw 'flush failed'
      },
    }

    configureQueueRuntime({
      failedJobStore: store,
    })

    await expect(persistFailedQueueJob(createReservedJob('jobs.error'), new Error('boom'))).rejects.toThrow('Failed job store could not persist the failed job: persist failed')
    await expect(listFailedQueueJobs()).rejects.toThrow('Failed job store could not list failed jobs: list failed')
    await expect(retryFailedQueueJobs('all')).rejects.toBe(wrapped)
    await expect(forgetFailedQueueJob('failed-1')).rejects.toThrow('Failed job store could not forget the failed job: forget failed')
    await expect(flushFailedQueueJobs()).rejects.toThrow('Failed job store could not flush failed jobs: flush failed')
    expect(queueFailedInternals.normalizeFailedStoreErrorMessage(new Error('boom'))).toBe('boom')
    expect(queueFailedInternals.normalizeFailedStoreErrorMessage('boom')).toBe('boom')
  })
})
