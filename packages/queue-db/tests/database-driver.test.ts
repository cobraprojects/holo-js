import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB } from '@holo-js/db'
import { connectionAsyncContext } from '@holo-js/db'
import { configureQueueRuntime, queueRuntimeInternals } from '@holo-js/queue'
import {
  createQueueDbRuntimeOptions,
  DatabaseQueueDriver,
} from '../src'
import { createQueueDatabaseContextMock } from './support/dialect'
import { createSQLiteQueueHarness, type SQLiteQueueHarness } from './support/sqlite-queue'

const harnesses: SQLiteQueueHarness[] = []

function createEnvelope(name: string, overrides: Partial<{
  id: string
  queue: string
  attempts: number
  maxAttempts: number
  availableAt: number
  createdAt: number
}> = {}) {
  return Object.freeze({
    id: overrides.id ?? `${name}-id`,
    name,
    connection: 'database',
    queue: overrides.queue ?? 'default',
    payload: { ok: true },
    attempts: overrides.attempts ?? 0,
    maxAttempts: overrides.maxAttempts ?? 3,
    ...(typeof overrides.availableAt === 'number' ? { availableAt: overrides.availableAt } : {}),
    createdAt: overrides.createdAt ?? Date.now(),
  })
}

afterEach(async () => {
  vi.useRealTimers()
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup()
  }
})

describe('@holo-js/queue-db database driver', () => {
  it('dispatches, reserves, releases, acknowledges, deletes, and clears queued jobs', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    const harness = await createSQLiteQueueHarness({
      queueConfig: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'default',
            retryAfter: 1,
          },
        },
      },
    })
    harnesses.push(harness)

    await harness.driver.dispatch(createEnvelope('jobs.immediate', {
      id: 'job-immediate',
      createdAt: 1_000,
    }))
    await harness.driver.dispatch(createEnvelope('jobs.delayed', {
      id: 'job-delayed',
      availableAt: 5_000,
      createdAt: 1_000,
    }))
    await harness.driver.dispatch(createEnvelope('jobs.mail', {
      id: 'job-mail',
      queue: 'mail',
      createdAt: 1_000,
    }))

    const firstReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(firstReserved).toMatchObject({
      envelope: {
        id: 'job-immediate',
        attempts: 0,
      },
    })

    await harness.driver.release(firstReserved!, { delaySeconds: 3 })
    expect(await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })).toBeNull()

    expect(await harness.driver.clear({
      queueNames: ['mail'],
    })).toBe(1)
    expect((await harness.readJobRows()).map(row => row.id)).toEqual(['job-delayed', 'job-immediate'])

    vi.setSystemTime(4_100)
    const releasedReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(releasedReserved).toMatchObject({
      envelope: {
        id: 'job-immediate',
        attempts: 1,
      },
    })
    await harness.driver.acknowledge(releasedReserved!)

    vi.setSystemTime(5_100)
    const delayedReserved = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(delayedReserved).toMatchObject({
      envelope: {
        id: 'job-delayed',
      },
    })
    await harness.driver.release(delayedReserved!)
    const redelivered = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(redelivered?.envelope.id).toBe('job-delayed')
    await harness.driver.delete(redelivered!)
    expect(await harness.readJobRows()).toEqual([])
  })

  it('reclaims jobs whose visibility timeout expired and leaves active reservations out of clear()', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)

    const harness = await createSQLiteQueueHarness({
      queueConfig: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'default',
            retryAfter: 1,
          },
        },
      },
    })
    harnesses.push(harness)

    await harness.driver.dispatch(createEnvelope('jobs.active', {
      id: 'job-active',
      createdAt: 10_000,
    }))
    await harness.driver.dispatch(createEnvelope('jobs.pending', {
      id: 'job-pending',
      createdAt: 10_000,
    }))

    const activeReservation = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(activeReservation?.envelope.id).toBe('job-active')

    expect(await harness.driver.clear()).toBe(1)
    expect((await harness.readJobRows()).map(row => row.id)).toEqual(['job-active'])

    vi.setSystemTime(11_500)
    const reclaimedReservation = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-2',
    })
    expect(reclaimedReservation).toMatchObject({
      envelope: {
        id: 'job-active',
        attempts: 1,
      },
    })
    await harness.driver.acknowledge(reclaimedReservation!)
  })

  it('fails clearly for invalid table names and missing DB connections', async () => {
    const harness = await createSQLiteQueueHarness()
    harnesses.push(harness)

    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'bad-table',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    expect(() => queueRuntimeInternals.resolveConnectionDriver('database')).toThrow('Queue table name must contain only valid SQL identifier segments.')

    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'missing',
            table: 'jobs',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const driver = queueRuntimeInternals.resolveConnectionDriver('database')
    await expect(driver.dispatch(createEnvelope('jobs.missing'))).rejects.toThrow('failed to enqueue job: Connection "missing" is not defined.')
  })

  it('wraps reserve, acknowledge, release, delete, and clear failures when the DB facade is no longer available', async () => {
    const harness = await createSQLiteQueueHarness()
    const driver = harness.driver
    const reservedJob = {
      reservationId: 'reservation-1',
      reservedAt: 1,
      envelope: createEnvelope('jobs.after-cleanup', {
        id: 'job-after-cleanup',
      }),
    }

    await harness.cleanup()

    await expect(driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })).rejects.toThrow('failed to reserve job: DB facade is not configured with a ConnectionManager.')
    await expect(driver.acknowledge(reservedJob)).rejects.toThrow('failed to acknowledge job: DB facade is not configured with a ConnectionManager.')
    await expect(driver.release(reservedJob, { delaySeconds: 1 })).rejects.toThrow('failed to release job: DB facade is not configured with a ConnectionManager.')
    await expect(driver.delete(reservedJob)).rejects.toThrow('failed to delete job: DB facade is not configured with a ConnectionManager.')
    await expect(driver.clear()).rejects.toThrow('failed to clear queued jobs: DB facade is not configured with a ConnectionManager.')
  })

  it('retries the same queue when a reservation update loses the race', async () => {
    const queryCompiled = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-1',
          job: 'jobs.raced',
          connection: 'database',
          queue: 'default',
          payload: JSON.stringify({ ok: true }),
          attempts: 0,
          max_attempts: 1,
          created_at: 1,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'job-2',
          job: 'jobs.next',
          connection: 'database',
          queue: 'default',
          payload: JSON.stringify({ ok: true }),
          attempts: 0,
          max_attempts: 1,
          created_at: 2,
        }],
        rowCount: 1,
      })
    const executeCompiled = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ affectedRows: 1 })
    const spy = vi.spyOn(DB, 'connection').mockReturnValue(createQueueDatabaseContextMock({
      async query<TRow extends Record<string, unknown>>(sql: string, bindings: readonly unknown[]) {
        return await queryCompiled({ sql, bindings }) as { rows: TRow[], rowCount: number }
      },
      async execute(sql: string, bindings: readonly unknown[]) {
        return await executeCompiled({ sql, bindings })
      },
    }))
    const driver = new DatabaseQueueDriver({
      name: 'database',
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
      retryAfter: 1,
      sleep: 1,
    }, {} as never)

    await expect(driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })).resolves.toMatchObject({
      envelope: {
        id: 'job-2',
      },
    })
    expect(queryCompiled).toHaveBeenCalledTimes(2)
    expect(executeCompiled).toHaveBeenCalledTimes(2)

    spy.mockRestore()
  })

  it('returns zero when clear reports no affected rows', async () => {
    const spy = vi.spyOn(DB, 'connection').mockReturnValue(createQueueDatabaseContextMock())

    const driver = new DatabaseQueueDriver({
      name: 'database',
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
      retryAfter: 1,
      sleep: 1,
    }, {} as never)
    await expect(driver.clear()).resolves.toBe(0)

    spy.mockRestore()
  })

  it('reuses the active async-context connection when it matches the configured database connection', async () => {
    const executeCompiled = vi.fn(async (_statement: unknown) => ({}))
    const activeConnection = createQueueDatabaseContextMock({
      connectionName: 'default',
      async execute(sql: string, bindings: readonly unknown[]) {
        return await executeCompiled({ sql, bindings })
      },
    })
    const initialize = vi.spyOn(activeConnection, 'initialize')

    const spy = vi.spyOn(DB, 'connection').mockImplementation(() => {
      throw new Error('DB.connection() should not be used when an active matching connection exists.')
    })

    const driver = new DatabaseQueueDriver({
      name: 'database',
      driver: 'database',
      connection: 'default',
      table: 'jobs',
      queue: 'default',
      retryAfter: 1,
      sleep: 1,
    }, {} as never)

    await expect(connectionAsyncContext.run({
      connectionName: 'default',
      connection: activeConnection,
    }, async () => driver.clear())).resolves.toBe(0)

    expect(initialize).toHaveBeenCalledTimes(1)
    expect(executeCompiled).toHaveBeenCalledTimes(1)

    spy.mockRestore()
  })
})
