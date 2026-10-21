import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB } from '@holo-js/db'
import { configureQueueRuntime, queueRuntimeInternals } from '@holo-js/queue'
import {
  createQueueDbRuntimeOptions,
  databaseQueueDriverInternals,
  DatabaseQueueDriver,
  DatabaseQueueDriverError,
} from '../src'
import { createSQLiteQueueHarness, type SQLiteQueueHarness } from './support/sqlite-queue'
import { runSharedQueueDriverContract } from '../../queue/tests/support/shared-driver-contract'

const harnesses: SQLiteQueueHarness[] = []

describe('@holo-js/queue-db driver internals', () => {
  it('normalizes database errors and queue-name fallbacks', () => {
    expect(databaseQueueDriverInternals.normalizeDatabaseErrorMessage('failed')).toBe('failed')
    const wrapped = new DatabaseQueueDriverError('database', 'reserve a job', 'failed')
    expect(databaseQueueDriverInternals.wrapDatabaseError('database', 'reserve a job', wrapped)).toBe(wrapped)
    expect(databaseQueueDriverInternals.normalizeQueueNames([' ', ''], 'default')).toEqual(['default'])
  })
})

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
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup()
  }
})

describe('@holo-js/queue-db database driver', () => {
  it('dispatches, reserves, releases, acknowledges, deletes, and clears queued jobs', async () => {

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

    const delayedAvailableAt = Date.now() + 2_200
    await harness.driver.dispatch(createEnvelope('jobs.immediate', {
      id: 'job-immediate',
      createdAt: Date.now(),
    }))
    await harness.driver.dispatch(createEnvelope('jobs.delayed', {
      id: 'job-delayed',
      availableAt: delayedAvailableAt,
      createdAt: Date.now(),
    }))
    await harness.driver.dispatch(createEnvelope('jobs.mail', {
      id: 'job-mail',
      queue: 'mail',
      createdAt: Date.now(),
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

    await harness.driver.release(firstReserved!, { delaySeconds: 1 })
    expect(await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })).toBeNull()

    expect(await harness.driver.clear({
      queueNames: ['mail'],
    })).toBe(1)
    expect((await harness.readJobRows()).map(row => row.id)).toEqual(['job-delayed', 'job-immediate'])

    const releasedReserved = await vi.waitFor(async () => {
      const reserved = await harness.driver.reserve({
        queueNames: ['default'],
        workerId: 'worker-1',
      })
      if (!reserved) throw new Error('Expected the released job to become available')
      return reserved
    }, { timeout: 5_000, interval: 50 })
    expect(releasedReserved).toMatchObject({
      envelope: {
        id: 'job-immediate',
        attempts: 1,
      },
    })
    await harness.driver.acknowledge(releasedReserved)

    const delayedReserved = await vi.waitFor(async () => {
      const reserved = await harness.driver.reserve({
        queueNames: ['default'],
        workerId: 'worker-1',
      })
      if (!reserved) throw new Error('Expected the delayed job to become available')
      return reserved
    }, { timeout: Math.max(0, delayedAvailableAt - Date.now()) + 5_000, interval: 50 })
    expect(delayedReserved).toMatchObject({
      envelope: {
        id: 'job-delayed',
      },
    })
    await harness.driver.release(delayedReserved)
    const redelivered = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(redelivered?.envelope.id).toBe('job-delayed')
    await harness.driver.delete(redelivered!)
    expect(await harness.readJobRows()).toEqual([])
  })

  it('reclaims jobs whose visibility timeout expired and leaves active reservations out of clear()', async () => {

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
      createdAt: Date.now(),
    }))
    await harness.driver.dispatch(createEnvelope('jobs.pending', {
      id: 'job-pending',
      createdAt: Date.now(),
    }))

    const activeReservation = await harness.driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    expect(activeReservation?.envelope.id).toBe('job-active')

    expect(await harness.driver.clear()).toBe(1)
    expect((await harness.readJobRows()).map(row => row.id)).toEqual(['job-active'])

    const reclaimedReservation = await vi.waitFor(async () => {
      const reserved = await harness.driver.reserve({
        queueNames: ['default'],
        workerId: 'worker-2',
      })
      if (!reserved) throw new Error('Expected the abandoned reservation to be reclaimed')
      return reserved
    }, { timeout: 5_000, interval: 50 })
    expect(reclaimedReservation).toMatchObject({
      envelope: {
        id: 'job-active',
        attempts: 1,
      },
    })
    await harness.driver.acknowledge(reclaimedReservation)
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

  it('reserves each queued job at most once across concurrent workers', async () => {
    const harness = await createSQLiteQueueHarness()
    harnesses.push(harness)
    await harness.driver.dispatch(createEnvelope('jobs.first', { id: 'job-1' }))
    await harness.driver.dispatch(createEnvelope('jobs.second', { id: 'job-2' }))

    const reservations = await Promise.all(['worker-1', 'worker-2', 'worker-3'].map(workerId => harness.driver.reserve({
      queueNames: ['default'],
      workerId,
    })))
    const reserved = reservations.filter(reservation => reservation !== null)
    expect(reserved.map(reservation => reservation.envelope.id).sort()).toEqual(['job-1', 'job-2'])
    expect(reservations.filter(reservation => reservation === null)).toHaveLength(1)
    await Promise.all(reserved.map(reservation => harness.driver.acknowledge(reservation)))
    expect(await harness.readJobRows()).toEqual([])
  })

  it('returns zero when clearing an empty queue', async () => {
    const harness = await createSQLiteQueueHarness()
    harnesses.push(harness)
    await expect(harness.driver.clear()).resolves.toBe(0)
  })

  it('rolls back queue writes together with the application transaction', async () => {
    const harness = await createSQLiteQueueHarness()
    harnesses.push(harness)
    await expect(DB.transaction(async () => {
      await harness.driver.dispatch(createEnvelope('jobs.transaction', { id: 'rolled-back-job' }))
      expect((await harness.readJobRows()).map(row => row.id)).toEqual(['rolled-back-job'])
      throw new Error('application transaction failed')
    })).rejects.toThrow('application transaction failed')
    expect(await harness.readJobRows()).toEqual([])
  })

})

runSharedQueueDriverContract({
  label: '@holo-js/queue-db',
  expected: { name: 'database', driver: 'database', mode: 'async' },
  async createDriver() {
    const harness = await createSQLiteQueueHarness()
    harnesses.push(harness)
    return harness.driver
  },
})
