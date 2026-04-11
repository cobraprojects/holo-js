import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB } from '@holo-js/db'
import type { DatabaseContext, Dialect } from '@holo-js/db'
import { connectionAsyncContext } from '@holo-js/db'
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
import { createQueueDbRuntimeOptions, queueDbFailedStoreInternals } from '../src'
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

function createDialect(name: string, placeholderPrefix: '$' | '?'): Dialect {
  return {
    name,
    capabilities: {
      concurrentQueries: false,
      jsonOperations: true,
      lateralJoins: false,
      workerThreadExecution: false,
      pessimisticLocking: false,
      savepoints: true,
      vectorColumns: false,
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return placeholderPrefix === '$' ? `$${index}` : '?'
    },
  }
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

  it('falls back to error.message and zero affected rows when the store driver omits them', async () => {
    const spy = vi.spyOn(DB, 'connection').mockReturnValue({
      async initialize() {},
      getDialect() {
        return {
          name: 'sqlite',
          capabilities: {
            concurrentQueries: false,
            jsonOperations: true,
            lateralJoins: false,
            workerThreadExecution: false,
            pessimisticLocking: false,
            savepoints: true,
            vectorColumns: false,
          },
          quoteIdentifier(identifier: string) {
            return `"${identifier}"`
          },
          createPlaceholder() {
            return '?'
          },
        }
      },
      async executeCompiled() {
        return {}
      },
      async queryCompiled() {
        return { rows: [], rowCount: 0 }
      },
    } as never)

    configureQueueRuntime({
      config: {
        default: 'database',
        failed: {
          driver: 'database',
          connection: 'default',
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
      ...createQueueDbRuntimeOptions(),
    })

    const error = new Error('message fallback')
    error.stack = ''

    await expect(persistFailedQueueJob({
      reservationId: 'reservation-1',
      reservedAt: 1,
      envelope: createEnvelope('jobs.fallback', 'fallback-job'),
    }, error)).resolves.toMatchObject({
      exception: 'message fallback',
    })
    await expect(forgetFailedQueueJob('missing')).resolves.toBe(false)
    await expect(flushFailedQueueJobs()).resolves.toBe(0)

    spy.mockRestore()
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
    expect(queueDbFailedStoreInternals.getFailedStoreConfig()).toEqual({
      driver: 'database',
      connection: 'default',
      table: 'failed_jobs',
    })
    expect(await queueDbFailedStoreInternals.getFailedStoreConnection()).not.toBeNull()
  })

  it('reuses the active async-context connection for the failed-job store when names match', async () => {
    const executeCompiled = vi.fn(async () => ({}))
    const activeConnection = {
      async initialize() {},
      getConnectionName() {
        return 'default'
      },
      getDialect() {
        return createDialect('sqlite', '?')
      },
      async executeCompiled(statement: unknown) {
        return await executeCompiled(statement)
      },
      async queryCompiled() {
        return {
          rows: [],
          rowCount: 0,
        }
      },
    } as unknown as DatabaseContext

    const spy = vi.spyOn(DB, 'connection').mockImplementation(() => {
      throw new Error('DB.connection() should not be used when an active matching connection exists.')
    })

    configureQueueRuntime({
      config: {
        default: 'database',
        failed: {
          driver: 'database',
          connection: 'default',
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
      ...createQueueDbRuntimeOptions(),
    })

    const error = new Error('active-context failure')
    error.stack = ''

    await expect(connectionAsyncContext.run({
      connectionName: 'default',
      connection: activeConnection,
    }, async () => persistFailedQueueJob({
      reservationId: 'reservation-1',
      reservedAt: 1,
      envelope: createEnvelope('jobs.active-context', 'active-context-job'),
    }, error))).resolves.toMatchObject({
      jobId: 'active-context-job',
      exception: 'active-context failure',
    })

    expect(executeCompiled).toHaveBeenCalledTimes(1)

    spy.mockRestore()
  })
})
