import { afterEach, describe, expect, it, vi } from 'vitest'
import { DB } from '@holo-js/db'
import type { DatabaseContext, Dialect } from '@holo-js/db'
import { connectionAsyncContext } from '@holo-js/db'
import { configureQueueRuntime, queueRuntimeInternals } from '@holo-js/queue'
import {
  createQueueDbRuntimeOptions,
  DatabaseQueueDriver,
  databaseQueueDriverInternals,
  queueDatabaseInternals,
} from '../src'
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

function createDialect(name: string, placeholderPrefix: '$' | '?'): Dialect {
  return {
    name,
    capabilities: {
      returning: false,
      lockForUpdate: false,
      sharedLock: false,
      concurrentQueries: false,
      workerThreadExecution: false,
      savepoints: true,
      jsonValueQuery: true,
      jsonContains: true,
      jsonLength: true,
      schemaQualifiedIdentifiers: true,
      nativeUpsert: false,
      ddlAlterSupport: false,
      introspection: false,
    },
    quoteIdentifier(identifier: string) {
      return `"${identifier}"`
    },
    createPlaceholder(index: number) {
      return placeholderPrefix === '?' ? '?' : `${placeholderPrefix}${index}`
    },
  }
}

afterEach(async () => {
  vi.useRealTimers()
  while (harnesses.length > 0) {
    await harnesses.pop()?.cleanup()
  }
})

describe('@holo-js/queue-db database driver', () => {
  it('normalizes identifiers, placeholders, stored rows, and wrapped error messages', () => {
    expect(queueDatabaseInternals.normalizeIdentifierPath(' public.jobs ', 'Queue table name')).toBe('public.jobs')
    expect(() => queueDatabaseInternals.normalizeIdentifierPath('', 'Queue table name')).toThrow('Queue table name must be a non-empty string.')
    expect(() => queueDatabaseInternals.normalizeIdentifierPath('jobs-table', 'Queue table name')).toThrow('Queue table name must contain only valid SQL identifier segments.')
    expect(() => queueDatabaseInternals.createPlaceholderList(createDialect('sqlite', '?'), 0)).toThrow('Placeholder lists require at least one binding.')
    expect(queueDatabaseInternals.createPlaceholderList(createDialect('postgres', '$'), 3)).toBe('$1, $2, $3')
    expect(queueDatabaseInternals.quoteIdentifierPath(createDialect('mysql', '?'), 'queue.jobs')).toBe('"queue"."jobs"')
    expect(queueDatabaseInternals.coerceOptionalInteger(undefined, 'Optional integer')).toBeUndefined()
    expect(queueDatabaseInternals.coerceOptionalInteger(null, 'Optional integer')).toBeUndefined()
    expect(queueDatabaseInternals.coerceOptionalInteger('4', 'Optional integer')).toBe(4)
    expect(() => queueDatabaseInternals.coerceRequiredString('', 'Required string')).toThrow('Required string must be a non-empty string.')
    expect(() => queueDatabaseInternals.coerceRequiredInteger(1.2, 'Required integer')).toThrow('Required integer must be an integer.')
    expect(() => queueDatabaseInternals.coerceRequiredInteger('nope', 'Required integer')).toThrow('Required integer must be an integer.')
    expect(() => queueDatabaseInternals.assertQueueJsonValue(Number.POSITIVE_INFINITY, 'payload')).toThrow('payload must be JSON-serializable.')
    expect(() => queueDatabaseInternals.assertQueueJsonValue(undefined, 'payload')).toThrow('payload must be JSON-serializable.')
    expect(() => queueDatabaseInternals.assertQueueJsonValue(new Date(), 'payload')).toThrow('payload must be a plain JSON object, array, or primitive.')
    const circularArray: unknown[] = []
    circularArray.push(circularArray)
    expect(() => queueDatabaseInternals.assertQueueJsonValue(circularArray, 'payload')).toThrow('payload[0] contains a circular reference.')
    const circularObject: Record<string, unknown> = {}
    circularObject.self = circularObject
    expect(() => queueDatabaseInternals.assertQueueJsonValue(circularObject, 'payload')).toThrow('payload.self contains a circular reference.')
    expect(queueDatabaseInternals.serializeQueueJson({ nested: [1, true, null] })).toBe('{"nested":[1,true,null]}')
    expect(() => queueDatabaseInternals.serializeQueueJson(new Date())).toThrow('Queue JSON payload must be a plain JSON object, array, or primitive.')
    expect(queueDatabaseInternals.parseStoredQueueJobRow({
      id: 'job-1',
      job: 'reports.generate',
      connection: 'database',
      queue: 'reports',
      payload: JSON.stringify({ ok: true }),
      attempts: '1',
      max_attempts: 3,
      available_at: null,
      created_at: 100,
    })).toEqual({
      id: 'job-1',
      name: 'reports.generate',
      connection: 'database',
      queue: 'reports',
      payload: { ok: true },
      attempts: 1,
      maxAttempts: 3,
      createdAt: 100,
    })
    expect(queueDatabaseInternals.parseStoredFailedQueueJobRow({
      id: 'failed-1',
      job_id: 'job-1',
      payload: JSON.stringify(createEnvelope('reports.generate', { id: 'job-1', createdAt: 100 })),
      exception: 'boom',
      failed_at: '200',
    })).toMatchObject({
      id: 'failed-1',
      jobId: 'job-1',
      exception: 'boom',
      failedAt: 200,
    })
    expect(queueDatabaseInternals.parseStoredQueueEnvelope(createEnvelope('reports.ready', {
      id: 'job-ready',
      createdAt: 100,
      availableAt: 200,
    }))).toMatchObject({
      id: 'job-ready',
      availableAt: 200,
    })
    expect(databaseQueueDriverInternals.normalizeDatabaseErrorMessage(new Error('boom'))).toBe('boom')
    expect(databaseQueueDriverInternals.normalizeDatabaseErrorMessage('boom')).toBe('boom')
    expect(databaseQueueDriverInternals.normalizeQueueNames(undefined, 'default')).toEqual(['default'])
    expect(databaseQueueDriverInternals.normalizeQueueNames(['   '], 'default')).toEqual(['default'])
    expect(databaseQueueDriverInternals.normalizeQueueNames(['  ', 'mail', 'mail'], 'default')).toEqual(['mail'])
    expect(() => queueDatabaseInternals.parseStoredFailedQueueJobRow({
      id: 'failed-2',
      job_id: 'job-2',
      payload: JSON.stringify('bad'),
      exception: 'boom',
      failed_at: 1,
    })).toThrow('Stored queue job payload must serialize a queue job envelope object.')
    expect(() => queueDatabaseInternals.parseStoredPayload('{bad json', 'payload')).toThrow()
    expect(databaseQueueDriverInternals.wrapDatabaseError('database', 'reserve job', new Error('down'))).toBeInstanceOf(Error)
    const wrapped = databaseQueueDriverInternals.wrapDatabaseError('database', 'reserve job', new Error('down'))
    expect(databaseQueueDriverInternals.wrapDatabaseError('database', 'reserve job', wrapped)).toBe(wrapped)
  })

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
    const spy = vi.spyOn(DB, 'connection').mockReturnValue({
      async initialize() {},
      getDialect() {
        return createDialect('sqlite', '?')
      },
      async transaction<T>(callback: (connection: DatabaseContext) => Promise<T>) {
        return callback(this as unknown as DatabaseContext)
      },
      queryCompiled,
      executeCompiled,
    } as never)
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
    const spy = vi.spyOn(DB, 'connection').mockReturnValue({
      async initialize() {},
      getDialect() {
        return createDialect('sqlite', '?')
      },
      async executeCompiled() {
        return {}
      },
    } as never)

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
    const initialize = vi.fn(async () => {})
    const activeConnection = {
      async initialize() {
        await initialize()
      },
      getConnectionName() {
        return 'default'
      },
      getDialect() {
        return createDialect('sqlite', '?')
      },
      async executeCompiled(statement: unknown) {
        return await executeCompiled(statement)
      },
    } as unknown as DatabaseContext

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
