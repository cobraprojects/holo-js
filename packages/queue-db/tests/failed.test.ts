import { afterEach, describe, expect, it } from 'vitest'
import { DB } from '@holo-js/db'
import {
  configureQueueRuntime,
  flushFailedQueueJobs,
  forgetFailedQueueJob,
  listFailedQueueJobs,
  persistFailedQueueJob,
  registerQueueJob,
  retryFailedQueueJobs,
  runQueueWorker,
} from '@holo-js/queue'
import { createSQLiteQueueHarness, type SQLiteQueueHarness } from './support/sqlite-queue'

const harnesses: SQLiteQueueHarness[] = []

function createEnvelope(name: string, id = `${name}-id`) {
  return Object.freeze({
    id,
    name,
    connection: 'database',
    queue: 'default',
    payload: { ok: true },
    attempts: 0,
    maxAttempts: 2,
    createdAt: Date.now(),
  })
}

afterEach(async () => {
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup()
  }
})

describe('@holo-js/queue-db failed job store', () => {
  it('persists, lists, retries, forgets, and flushes failed jobs', async () => {
    const harness = await createSQLiteQueueHarness({
      createFailedTable: true,
    })
    harnesses.push(harness)

    await harness.driver.dispatch(createEnvelope('jobs.persist', 'persist-job'))
    const reserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    const persisted = await persistFailedQueueJob(reserved!, new Error('persisted failure'))
    await harness.driver.delete(reserved!)

    expect(persisted).toMatchObject({
      jobId: 'persist-job',
      exception: expect.stringContaining('persisted failure'),
    })
    expect(await listFailedQueueJobs()).toHaveLength(1)
    expect(await retryFailedQueueJobs(persisted!.id)).toBe(1)
    expect(await listFailedQueueJobs()).toEqual([])
    expect((await harness.readJobRows()).map(row => row.id)).toContain('persist-job')

    const retryReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    await persistFailedQueueJob(retryReserved!, new Error('forget me'))
    await harness.driver.delete(retryReserved!)
    const [failedRecord] = await listFailedQueueJobs()
    expect(await forgetFailedQueueJob(failedRecord!.id)).toBe(true)
    expect(await forgetFailedQueueJob(failedRecord!.id)).toBe(false)

    await harness.driver.dispatch(createEnvelope('jobs.flush-one', 'flush-one'))
    const flushOneReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    await persistFailedQueueJob(flushOneReserved!, new Error('flush me once'))
    await harness.driver.delete(flushOneReserved!)
    await harness.driver.dispatch(createEnvelope('jobs.second', 'second-job'))
    const secondReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-2',
    })
    await persistFailedQueueJob(secondReserved!, new Error('flush me twice'))
    await harness.driver.delete(secondReserved!)
    expect(await flushFailedQueueJobs()).toBe(2)
    expect(await listFailedQueueJobs()).toEqual([])
  })

  it('retries all failed jobs in one pass', async () => {
    const harness = await createSQLiteQueueHarness({
      createFailedTable: true,
    })
    harnesses.push(harness)

    for (const jobId of ['retry-all-1', 'retry-all-2']) {
      await harness.driver.dispatch(createEnvelope(`jobs.${jobId}`, jobId))
      const reserved = await harness.driver.reserve({
        queueNames: ['default'],
        workerId: jobId,
      })
      await persistFailedQueueJob(reserved!, new Error(`failed ${jobId}`))
      await harness.driver.delete(reserved!)
    }

    expect(await retryFailedQueueJobs('all')).toBe(2)
    expect(await listFailedQueueJobs()).toEqual([])
    expect((await harness.readJobRows()).map(row => row.id)).toEqual(['retry-all-1', 'retry-all-2'])
  })

  it('returns disabled-store defaults and rejects malformed failed payloads', async () => {
    const disabledHarness = await createSQLiteQueueHarness({
      createFailedTable: false,
    })
    harnesses.push(disabledHarness)

    await disabledHarness.driver.dispatch(createEnvelope('jobs.disabled', 'disabled-job'))
    const reserved = await disabledHarness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })

    await expect(persistFailedQueueJob(reserved!, new Error('ignored'))).resolves.toBeNull()
    await expect(listFailedQueueJobs()).resolves.toEqual([])
    await expect(retryFailedQueueJobs('all')).resolves.toBe(0)
    await expect(forgetFailedQueueJob('missing')).resolves.toBe(false)
    await expect(flushFailedQueueJobs()).resolves.toBe(0)

    const malformedHarness = await createSQLiteQueueHarness({
      createFailedTable: true,
      failedTableName: 'broken_failed_jobs',
      queueConfig: {
        default: 'database',
        failed: {
          driver: 'database',
          connection: 'default',
          table: 'broken_failed_jobs',
        },
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
          },
        },
      },
    })
    harnesses.push(malformedHarness)

    await malformedHarness.connection.executeCompiled({
      sql: 'INSERT INTO "broken_failed_jobs" (id, job_id, job, connection, queue, payload, exception, failed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      bindings: ['broken-1', 'job-1', 'jobs.broken', 'database', 'default', '"invalid"', 'broken payload', 123],
      source: 'test:failed:malformed',
    })

    await expect(retryFailedQueueJobs('all')).rejects.toThrow('Stored queue job payload must serialize a queue job envelope object.')
  })

  it('surfaces persistence failures from queue-db integration operations', async () => {
    const harness = await createSQLiteQueueHarness({
      createFailedTable: false,
      queueConfig: {
        default: 'database',
        failed: {
          driver: 'database',
          connection: 'missing',
          table: 'failed_jobs',
        },
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
          },
        },
      },
    })
    harnesses.push(harness)

    await harness.driver.dispatch(createEnvelope('jobs.missing-store', 'missing-store'))
    const reserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })

    await expect(persistFailedQueueJob(reserved!, new Error('cannot persist'))).rejects.toThrow('Failed job store could not persist the failed job')
    await expect(forgetFailedQueueJob('missing')).rejects.toThrow('Failed job store could not forget the failed job')
    await expect(flushFailedQueueJobs()).rejects.toThrow('Failed job store could not flush failed jobs')
  })

  it('persists an error without a stack and handles absent failed jobs', async () => {
    const harness = await createSQLiteQueueHarness({ createFailedTable: true })
    harnesses.push(harness)
    const error = new Error('message fallback')
    error.stack = ''

    const persisted = await persistFailedQueueJob({
      reservationId: 'reservation-1',
      reservedAt: Date.now(),
      envelope: createEnvelope('jobs.fallback', 'fallback-job'),
    }, error)
    expect(persisted).toMatchObject({ exception: 'message fallback' })
    expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ exception: 'message fallback' })])
    await expect(forgetFailedQueueJob('missing')).resolves.toBe(false)
    await expect(flushFailedQueueJobs()).resolves.toBe(1)
    await expect(flushFailedQueueJobs()).resolves.toBe(0)
  })

  it('persists worker failures before removing exhausted jobs', async () => {
    const harness = await createSQLiteQueueHarness({
      createFailedTable: true,
    })
    harnesses.push(harness)

    registerQueueJob({
      tries: 1,
      async handle() {
        throw new Error('worker exploded')
      },
    }, {
      name: 'jobs.worker-fail',
    })

    await harness.driver.dispatch({
      ...createEnvelope('jobs.worker-fail', 'worker-fail-job'),
      maxAttempts: 1,
    })

    await expect(runQueueWorker({
      connection: 'database',
      once: true,
    })).resolves.toMatchObject({
      failed: 1,
      stoppedBecause: 'once',
    })

    expect(await harness.readJobRows()).toEqual([])
    expect(await listFailedQueueJobs()).toEqual([
      expect.objectContaining({
        jobId: 'worker-fail-job',
        exception: expect.stringContaining('worker exploded'),
      }),
    ])
  })

  it('rolls back a failed job together with the application transaction', async () => {
    const harness = await createSQLiteQueueHarness({ createFailedTable: true })
    harnesses.push(harness)
    await expect(DB.transaction(async () => {
      await persistFailedQueueJob({
        reservationId: 'reservation-1',
        reservedAt: Date.now(),
        envelope: createEnvelope('jobs.transaction', 'transaction-job'),
      }, new Error('transaction failure'))
      expect(await listFailedQueueJobs()).toEqual([expect.objectContaining({ jobId: 'transaction-job' })])
      throw new Error('application transaction failed')
    })).rejects.toThrow('application transaction failed')
    expect(await listFailedQueueJobs()).toEqual([])
  })
})
