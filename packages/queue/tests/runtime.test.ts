import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueueDriverFactory, QueueJsonValue, QueueReservedJob, RegisterableQueueJobDefinition } from '../src'
import {
  Queue,
  QueueReleaseUnsupportedError,
  configureQueueRuntime,
  dispatch,
  dispatchSync,
  getQueueRuntime,
  getRegisteredQueueJob,
  listRegisteredQueueJobs,
  normalizeQueueConfig,
  queueRegistryInternals,
  queueRuntimeInternals,
  registerQueueJob,
  registerQueueJobs,
  resetQueueRegistry,
  resetQueueRuntime,
  shutdownQueueRuntime,
  unregisterQueueJob,
  useQueueConnection,
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

function createAsyncDriverFactory(
  driverName: 'redis' | 'database',
  dispatched: ReturnType<typeof vi.fn>,
  close = vi.fn(async () => {}),
): QueueDriverFactory {
  return {
    driver: driverName,
    create(connection, _context) {
      return {
        name: connection.name,
        driver: connection.driver,
        mode: 'async' as const,
        async dispatch(job) {
          dispatched({
            connection,
            job,
          })

          return {
            jobId: job.id,
            synchronous: false,
          }
        },
        async clear() {
          return 0
        },
        close,
        async reserve<TPayload extends QueueJsonValue = QueueJsonValue>() {
          return null as QueueReservedJob<TPayload> | null
        },
        async acknowledge() {},
        async release() {},
        async delete() {},
      }
    },
  }
}

afterEach(() => {
  resetQueueRegistry()
  resetQueueRuntime()
  vi.useRealTimers()
})

function registerNamedJob<TPayload extends QueueJsonValue, TResult>(
  name: string,
  definition: RegisterableQueueJobDefinition<TPayload, TResult>,
) {
  return registerQueueJob(definition, { name })
}

describe('@holo-js/queue runtime', () => {
  it('accepts shared redis config when configuring Redis-backed runtime connections', () => {
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: {
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
      },
    })

    expect(getQueueRuntime().config.connections.redis).toMatchObject({
      driver: 'redis',
      connection: 'default',
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    })
  })

  it('registers jobs from explicit names, definitions, and source-path-derived names', () => {
    const packageJob = registerQueueJob({
      async handle() {},
    }, {
      name: 'media.generate-conversions',
    })

    const explicitOptionJob = registerQueueJob({
      async handle() {},
    }, {
      name: 'reports.manual',
    })

    const discoveredJob = registerQueueJob({
      async handle() {},
    }, {
      sourcePath: 'server/jobs/reports/daily-summary.ts',
    })

    const batch = registerQueueJobs([
      {
        definition: {
          async handle() {},
        },
        options: {
          name: 'reports.weekly',
        },
      },
    ])

    expect(packageJob.name).toBe('media.generate-conversions')
    expect(explicitOptionJob.name).toBe('reports.manual')
    expect(discoveredJob.name).toBe('reports.daily-summary')
    expect(batch).toHaveLength(1)
    expect(getRegisteredQueueJob('reports.daily-summary')?.sourcePath).toBe('server/jobs/reports/daily-summary.ts')
    expect(listRegisteredQueueJobs().map(entry => entry.name)).toEqual([
      'media.generate-conversions',
      'reports.daily-summary',
      'reports.manual',
      'reports.weekly',
    ])
    expect(queueRegistryInternals.deriveJobNameFromSourcePath('app/server/jobs/cleanup/cache.ts')).toBe('cleanup.cache')
    expect(queueRegistryInternals.deriveJobNameFromSourcePath('plain-job.ts')).toBe('plain-job')
  })

  it('rejects duplicate, unnamed, and malformed registered jobs', () => {
    registerQueueJob({
      async handle() {},
    }, {
      name: 'emails.send',
    })

    expect(() => registerQueueJob({
      async handle() {},
    }, {
      name: 'emails.send',
    })).toThrow('Queue job "emails.send" is already registered.')

    expect(() => registerQueueJob({
      name: 'legacy.job',
      async handle() {},
    } as never)).toThrow('Registered jobs require an explicit name or a sourcePath-derived name.')

    expect(() => registerQueueJob({
      async handle() {},
    })).toThrow('Registered jobs require an explicit name or a sourcePath-derived name.')

    expect(() => registerQueueJob({
      tries: 0,
      async handle() {},
    }, {
      sourcePath: 'server/jobs/bad-job.ts',
    })).toThrow('Job tries must be greater than or equal to 1.')

    expect(() => registerQueueJob({
      handle: 'not-a-function',
    } as never, {
      name: 'broken.job',
    })).toThrow('Jobs must define a "handle" function.')
  })

  it('replaces discovered jobs only when explicitly requested', async () => {
    registerQueueJob({
      async handle() {
        return 'first'
      },
    }, {
      name: 'reports.daily',
      sourcePath: 'server/jobs/reports/daily.ts',
    })

    registerQueueJob({
      async handle() {
        return 'second'
      },
    }, {
      name: 'reports.daily',
      sourcePath: 'server/jobs/reports/daily.ts',
      replaceExisting: true,
    })

    await expect(dispatchSync<Record<string, never>, string>('reports.daily', {})).resolves.toBe('second')
    expect(getRegisteredQueueJob('reports.daily')?.sourcePath).toBe('server/jobs/reports/daily.ts')
  })

  it('dispatches synchronously through the built-in sync driver and returns sync results explicitly', async () => {
    const handled = vi.fn(async (
      payload: { readonly userId: number },
      context: {
        readonly attempt: number
        readonly connection: string
        readonly maxAttempts: number
        readonly queue: string
      },
    ) => {
      expect(context.connection).toBe('sync')
      expect(context.queue).toBe('default')
      expect(context.attempt).toBe(1)
      expect(context.maxAttempts).toBe(3)
      return payload.userId * 2
    })

    registerNamedJob('users.reindex', {
      tries: 3,
      async handle(payload, context) {
        return handled(payload as { readonly userId: number }, {
          attempt: context.attempt,
          connection: context.connection,
          maxAttempts: context.maxAttempts,
          queue: context.queue,
        })
      },
    })

    const asyncResult = await dispatch('users.reindex', {
      userId: 21,
    })
    const syncResult = await dispatchSync<{ readonly userId: number }, number>('users.reindex', {
      userId: 21,
    })

    expect(asyncResult).toEqual({
      jobId: expect.any(String),
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
    expect(syncResult).toBe(42)
    expect(handled).toHaveBeenCalledTimes(2)
  })

  it('supports PromiseLike catch(), finally(), onComplete(), and onFailed() on pending dispatches', async () => {
    const onFinally = vi.fn()
    const onComplete = vi.fn()
    const onFailed = vi.fn()

    registerNamedJob('jobs.promise-like', {
      async handle(payload) {
        return payload
      },
    })

    const result = await dispatch('jobs.promise-like', { ok: true })
      .onComplete(async (dispatchResult) => {
        onComplete(dispatchResult)
      })
      .finally(onFinally)
    const resultWithNullFinally = await dispatch('jobs.promise-like', { ok: true }).finally(null)
    const recovered = await dispatch('missing.job', { ok: true })
      .onFailed(async (error) => {
        onFailed(error)
      })
      .catch((error) => {
        return error instanceof Error ? error.message : String(error)
      })

    expect(result).toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
    expect(resultWithNullFinally).toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
    expect(recovered).toContain('Queue job "missing.job" is not registered.')
    expect(onFinally).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    }))
    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledWith(expect.any(Error))
  })

  it('warns and preserves the original dispatch outcome when pending dispatch hooks fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    registerNamedJob('jobs.hook-warning', {
      async handle(payload) {
        return payload
      },
    })

    await expect(dispatch('jobs.hook-warning', { ok: true })
      .onComplete(async () => {
        throw new Error('complete hook failed')
      })).resolves.toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })

    await expect(dispatch('jobs.hook-warning', { ok: true })
      .onComplete(async () => {
        throw 'complete hook string failed'
      })).resolves.toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })

    await expect(dispatch('missing.job', { ok: true })
      .onFailed(async () => {
        throw new Error('failed hook failed')
      })).rejects.toThrow('Queue job "missing.job" is not registered.')

    await expect(dispatch('missing.job', { ok: true })
      .onFailed(async () => {
        throw 'failed hook string failed'
      })).rejects.toThrow('Queue job "missing.job" is not registered.')

    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[Holo Queue] onComplete hook failed during dispatch of "jobs.hook-warning": complete hook failed',
    )
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[Holo Queue] onComplete hook failed during dispatch of "jobs.hook-warning": complete hook string failed',
    )
    expect(warn).toHaveBeenNthCalledWith(
      3,
      '[Holo Queue] onFailed hook failed during dispatch of "missing.job": failed hook failed',
    )
    expect(warn).toHaveBeenNthCalledWith(
      4,
      '[Holo Queue] onFailed hook failed during dispatch of "missing.job": failed hook string failed',
    )
  })

  it('runs job completion hooks for synchronous execution and ignores hook failures', async () => {
    const onCompleted = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    registerNamedJob('jobs.complete', {
      async handle(payload) {
        return { doubled: (payload as { readonly count: number }).count * 2 }
      },
      async onCompleted(payload, result, context) {
        onCompleted({
          payload,
          result,
          context: {
            jobName: context.jobName,
            queue: context.queue,
            connection: context.connection,
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
          },
        })
      },
    })

    registerNamedJob('jobs.complete-warn', {
      async handle() {
        return 'ok'
      },
      async onCompleted() {
        throw 'hook failed'
      },
    })

    await expect(dispatch('jobs.complete', { count: 5 }).dispatch()).resolves.toMatchObject({
      synchronous: true,
    })
    await expect(dispatchSync<{ readonly count: number }, { readonly doubled: number }>('jobs.complete', { count: 7 })).resolves.toEqual({
      doubled: 14,
    })
    await expect(dispatch('jobs.complete-warn', { ok: true }).dispatch()).resolves.toMatchObject({
      synchronous: true,
    })

    expect(onCompleted).toHaveBeenNthCalledWith(1, {
      payload: { count: 5 },
      result: { doubled: 10 },
      context: {
        jobName: 'jobs.complete',
        queue: 'default',
        connection: 'sync',
        attempt: 1,
        maxAttempts: 1,
      },
    })
    expect(onCompleted).toHaveBeenNthCalledWith(2, {
      payload: { count: 7 },
      result: { doubled: 14 },
      context: {
        jobName: 'jobs.complete',
        queue: 'default',
        connection: 'sync',
        attempt: 1,
        maxAttempts: 1,
      },
    })
    expect(warn).toHaveBeenCalledWith('[Holo Queue] onCompleted hook failed for job "jobs.complete-warn": hook failed')
  })

  it('runs terminal failure hooks for synchronous execution and ignores hook failures', async () => {
    const onFailed = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    registerNamedJob('jobs.fail-sync', {
      async handle() {
        throw new Error('sync failed')
      },
      async onFailed(payload, error, context) {
        onFailed({
          payload,
          error: error.message,
          context: {
            jobName: context.jobName,
            queue: context.queue,
            connection: context.connection,
            attempt: context.attempt,
            maxAttempts: context.maxAttempts,
          },
        })
      },
    })

    registerNamedJob('jobs.fail-sync-warn', {
      async handle() {
        throw new Error('boom')
      },
      async onFailed() {
        throw 'hook blew up'
      },
    })

    registerNamedJob('jobs.fail-sync-string', {
      async handle() {
        throw 'string failure'
      },
      async onFailed(_payload, error) {
        onFailed({
          payload: { count: 3 },
          error: error.message,
          context: {
            jobName: 'jobs.fail-sync-string',
            queue: 'default',
            connection: 'sync',
            attempt: 1,
            maxAttempts: 1,
          },
        })
      },
    })

    await expect(dispatch('jobs.fail-sync', { count: 1 }).dispatch()).rejects.toThrow('sync failed')
    await expect(dispatchSync('jobs.fail-sync', { count: 2 })).rejects.toThrow('sync failed')
    await expect(dispatch('jobs.fail-sync-warn', { ok: true }).dispatch()).rejects.toThrow('boom')
    await expect(dispatch('jobs.fail-sync-string', { count: 3 }).dispatch()).rejects.toBe('string failure')

    expect(onFailed).toHaveBeenNthCalledWith(1, {
      payload: { count: 1 },
      error: 'sync failed',
      context: {
        jobName: 'jobs.fail-sync',
        queue: 'default',
        connection: 'sync',
        attempt: 1,
        maxAttempts: 1,
      },
    })
    expect(onFailed).toHaveBeenNthCalledWith(2, {
      payload: { count: 2 },
      error: 'sync failed',
      context: {
        jobName: 'jobs.fail-sync',
        queue: 'default',
        connection: 'sync',
        attempt: 1,
        maxAttempts: 1,
      },
    })
    expect(onFailed).toHaveBeenNthCalledWith(3, {
      payload: { count: 3 },
      error: 'string failure',
      context: {
        jobName: 'jobs.fail-sync-string',
        queue: 'default',
        connection: 'sync',
        attempt: 1,
        maxAttempts: 1,
      },
    })
    expect(warn).toHaveBeenCalledWith('[Holo Queue] onFailed hook failed for job "jobs.fail-sync-warn": hook blew up')
  })

  it('does not run terminal failure hooks when async dispatch enqueueing fails before execution', async () => {
    const onFailed = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        {
          driver: 'redis',
          create(connection, _context) {
            return {
              name: connection.name,
              driver: connection.driver,
              mode: 'async' as const,
              async dispatch() {
                throw new Error('enqueue failed')
              },
              async clear() {
                return 0
              },
              async close() {},
              async reserve<TPayload extends QueueJsonValue = QueueJsonValue>() {
                return null as QueueReservedJob<TPayload> | null
              },
              async acknowledge() {},
              async release() {},
              async delete() {},
            }
          },
        },
      ],
    })

    registerNamedJob('jobs.async-enqueue-failure', {
      async handle() {},
      async onFailed() {
        onFailed()
      },
    })

    await expect(dispatch('jobs.async-enqueue-failure', {
      ok: true,
    }).onConnection('redis').dispatch()).rejects.toThrow('enqueue failed')
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('supports fluent dispatch overrides individually and in combination for async connections', async () => {
    const dispatched = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'emails',
          },
          database: {
            driver: 'database',
            queue: 'reports',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createAsyncDriverFactory('redis', dispatched),
        createAsyncDriverFactory('database', dispatched),
      ],
    })

    registerNamedJob('mail.send', {
      connection: 'database',
      queue: 'mailers',
      tries: 5,
      async handle() {},
    })

    const dateDelay = new Date('2030-01-01T00:00:00.000Z')
    const connectionOnly = await dispatch('mail.send', { recipient: 'a@example.com' }).onConnection('redis')
    const queueOnly = await dispatch('mail.send', { recipient: 'b@example.com' }).onQueue('priority').dispatch()
    const delayed = await dispatch('mail.send', { recipient: 'c@example.com' }).delay(30).dispatch()
    const combined = await dispatch('mail.send', { recipient: 'd@example.com' })
      .onConnection('redis')
      .onQueue('critical')
      .delay(dateDelay)
      .dispatch()
    const optionsDispatch = await dispatch('mail.send', { recipient: 'e@example.com' }, {
      connection: 'redis',
      queue: 'bulk',
      delay: 45,
    })

    expect(connectionOnly.connection).toBe('redis')
    expect(queueOnly.queue).toBe('priority')
    expect(delayed.synchronous).toBe(false)
    expect(combined).toEqual({
      jobId: expect.any(String),
      connection: 'redis',
      queue: 'critical',
      synchronous: false,
    })
    expect(optionsDispatch).toEqual({
      jobId: expect.any(String),
      connection: 'redis',
      queue: 'bulk',
      synchronous: false,
    })
    expect(dispatched).toHaveBeenCalledTimes(5)
    expect(dispatched.mock.calls[0]?.[0]).toMatchObject({
      connection: {
        name: 'redis',
      },
      job: {
        connection: 'redis',
        queue: 'mailers',
        maxAttempts: 5,
      },
    })
    expect(dispatched.mock.calls[1]?.[0]).toMatchObject({
      connection: {
        name: 'database',
      },
      job: {
        connection: 'database',
        queue: 'priority',
      },
    })
    expect(dispatched.mock.calls[2]?.[0]).toMatchObject({
      job: {
        connection: 'database',
        queue: 'mailers',
        availableAt: expect.any(Number),
      },
    })
    expect(dispatched.mock.calls[3]?.[0]).toMatchObject({
      connection: {
        name: 'redis',
      },
      job: {
        connection: 'redis',
        queue: 'critical',
        availableAt: dateDelay.getTime(),
      },
    })
    expect(dispatched.mock.calls[4]?.[0]).toMatchObject({
      connection: {
        name: 'redis',
      },
      job: {
        connection: 'redis',
        queue: 'bulk',
        availableAt: expect.any(Number),
      },
    })
  })

  it('supports Queue.connection(name) and useQueueConnection(name) facade access', async () => {
    const dispatched = vi.fn()

    configureQueueRuntime({
      config: {
        default: 'sync',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'emails',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: new Map<string, QueueDriverFactory>([
        ['redis', createAsyncDriverFactory('redis', dispatched)],
      ]),
    })

    registerNamedJob('users.notify', {
      async handle(payload) {
        return payload
      },
    })

    const queued = await Queue.connection('redis').dispatch('users.notify', { ok: true })
    const syncResult = await useQueueConnection('redis').dispatchSync<{ readonly ok: boolean }, { readonly ok: boolean }>('users.notify', { ok: true })

    expect(queued.connection).toBe('redis')
    expect(syncResult).toEqual({ ok: true })
    expect(dispatched).toHaveBeenCalledTimes(1)
  })

  it('validates payloads and driver resolution errors across edge cases', async () => {
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'default',
          },
        },
      },
      redisConfig: sharedRedisConfig,
    })

    registerNamedJob('queue.validate', {
      async handle() {},
    })

    await expect(dispatch('missing.job', { ok: true }).dispatch()).rejects.toThrow('Queue job "missing.job" is not registered.')
    await expect(dispatch('queue.validate', { ok: true }).onConnection('database').dispatch()).rejects.toThrow('Queue connection "database" is not configured. Available connections: redis')
    await expect(dispatchSync('queue.validate', { ok: true }, {
      connection: 'missing',
    })).rejects.toThrow('Queue connection "missing" is not configured. Available connections: redis')

    await expect(dispatch('queue.validate', {
      nested: {
        bad: undefined,
      },
    } as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload.nested.bad" must be JSON-serializable.')

    await expect(dispatch('queue.validate', {
      nested: new Date(),
    } as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload.nested" must be a plain JSON object, array, or primitive.')

    await expect(dispatch('queue.validate', {
      count: Number.POSITIVE_INFINITY,
    } as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload.count" must be JSON-serializable.')

    await expect(dispatch('queue.validate', {
      big: 1n,
    } as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload.big" must be JSON-serializable.')

    const circular: { readonly name: string, self?: unknown } = { name: 'loop' }
    circular.self = circular
    await expect(dispatch('queue.validate', circular as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload.self" contains a circular reference.')
    const circularArray: unknown[] = ['loop']
    circularArray.push(circularArray)
    await expect(dispatch('queue.validate', circularArray as unknown as QueueJsonValue).dispatch()).rejects.toThrow('Queue payload at "payload[1]" contains a circular reference.')
    await expect(dispatchSync('queue.validate', {
      items: [1, { ok: true }, null],
    })).resolves.toBeUndefined()

    expect(() => dispatch('queue.validate', { ok: true }).onConnection('   ')).toThrow('Queue connection names must be non-empty strings.')
    expect(() => dispatch('queue.validate', { ok: true }).onQueue('   ')).toThrow('Queue names must be non-empty strings.')
    expect(() => dispatch('queue.validate', { ok: true }).delay(-1)).toThrow('Queue delay must be a finite number greater than or equal to 0.')
    expect(() => dispatch('queue.validate', { ok: true }).delay(new Date('invalid'))).toThrow('Queue delay dates must be valid Date instances.')
    expect(() => dispatch('queue.validate', { ok: true }).onComplete('bad' as never)).toThrow('Queue dispatch onComplete hook must be a function.')
    expect(() => dispatch('queue.validate', { ok: true }).onFailed('bad' as never)).toThrow('Queue dispatch onFailed hook must be a function.')
    expect(queueRuntimeInternals.normalizeQueueName('emails')).toBe('emails')
    expect(queueRuntimeInternals.normalizeDelay(undefined)).toBeUndefined()
    expect(queueRuntimeInternals.isPlainObject([])).toBe(false)
    expect(queueRuntimeInternals.isPlainObject(null)).toBe(false)
  })

  it('defines sync handler context fail/release behavior and propagates thrown errors', async () => {
    registerNamedJob('sync.release', {
      async handle(_payload, context) {
        await expect(context.release()).rejects.toBeInstanceOf(QueueReleaseUnsupportedError)
        await expect(context.fail(new Error('boom'))).rejects.toThrow('boom')
        return context.attempt
      },
    })

    registerNamedJob('sync.throw', {
      async handle() {
        throw new Error('sync failed')
      },
    })
    registerNamedJob('sync.fail-override', {
      async handle(_payload, context) {
        await context.fail(new Error('override'))
        return 'continued'
      },
    })

    await expect(dispatchSync<QueueJsonValue, number>('sync.release', {
      ok: true,
    })).resolves.toBe(1)
    await expect(dispatchSync('sync.throw', {
      ok: true,
    })).rejects.toThrow('sync failed')
    await expect(queueRuntimeInternals.executeRegisteredQueueJob({
      id: 'job-with-fail-override',
      name: 'sync.fail-override',
      connection: 'sync',
      queue: 'default',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: Date.now(),
    }, {
      fail: async () => {},
    })).resolves.toBe('continued')
  })

  it('creates and caches driver factories and resolved drivers cleanly', async () => {
    const dispatched = vi.fn()
    const redisFactory = createAsyncDriverFactory('redis', dispatched)
    const defaultFactories = queueRuntimeInternals.createQueueDriverFactoryMap()
    const arrayFactories = queueRuntimeInternals.createQueueDriverFactoryMap([redisFactory])
    const mapFactories = queueRuntimeInternals.createQueueDriverFactoryMap(new Map<string, QueueDriverFactory>([
      ['redis', redisFactory],
    ]))

    expect(queueRuntimeInternals.createDefaultDriverFactories().has('sync')).toBe(true)
    expect(queueRuntimeInternals.createDefaultDriverFactories().has('redis')).toBe(true)
    expect(queueRuntimeInternals.createDefaultDriverFactories().has('database')).toBe(false)
    expect(defaultFactories.has('sync')).toBe(true)
    expect(arrayFactories.get('sync')).toBeDefined()
    expect(arrayFactories.get('redis')).toBe(redisFactory)
    expect(mapFactories.get('redis')).toBe(redisFactory)

    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'redis',
        connections: {
          sync: {
            driver: 'sync',
          },
          redis: {
            driver: 'redis',
            queue: 'emails',
          },
        },
      }, sharedRedisConfig),
      driverFactories: [redisFactory],
    })

    registerNamedJob('jobs.resolve', {
      async handle(payload) {
        return payload
      },
    })

    const redisDriver = queueRuntimeInternals.resolveConnectionDriver('redis')
    const sameRedisDriver = queueRuntimeInternals.resolveConnectionDriver('redis')
    const syncDriver = queueRuntimeInternals.resolveSyncExecutionDriver()
    const sameSyncDriver = queueRuntimeInternals.resolveSyncExecutionDriver()

    expect(redisDriver).toBe(sameRedisDriver)
    expect(syncDriver).toBe(sameSyncDriver)
    expect(redisDriver.mode).toBe('async')
    expect(syncDriver.mode).toBe('sync')
    expect(queueRuntimeInternals.resolveDriverFactory(
      queueRuntimeInternals.getQueueRuntimeState(),
      queueRuntimeInternals.resolveConnectionConfig(queueRuntimeInternals.getQueueRuntimeState().config, 'redis'),
    )).toBe(redisFactory)

    await expect(dispatch('jobs.resolve', {
      ok: true,
    }).onConnection('redis').dispatch()).resolves.toMatchObject({
      connection: 'redis',
      synchronous: false,
    })
    expect(dispatched).toHaveBeenCalledTimes(1)
    expect(() => queueRuntimeInternals.resolveDriverFactory(
      queueRuntimeInternals.getQueueRuntimeState(),
      {
        name: 'broken',
        driver: 'sqs',
      } as never,
    )).toThrow('Queue connection "broken" uses driver "sqs" but no queue driver factory is registered.')
  })

  it('resets runtime state without clearing registered jobs', async () => {
    const dispatched = vi.fn()
    const close = vi.fn(async () => {})

    registerNamedJob('jobs.cleanup', {
      async handle() {
        return 'done'
      },
    })

    configureQueueRuntime({
      config: normalizeQueueConfig({
        default: 'database',
        connections: {
          database: {
            driver: 'database',
            queue: 'reports',
          },
        },
      }),
      driverFactories: [
        createAsyncDriverFactory('database', dispatched, close),
      ],
    })

    expect(listRegisteredQueueJobs()).toHaveLength(1)
    expect(Queue.connection().name).toBe('database')
    expect(queueRuntimeInternals.getQueueRuntimeState().drivers.size).toBe(0)

    await dispatch('jobs.cleanup', {
      ok: true,
    }).dispatch()
    expect(queueRuntimeInternals.getQueueRuntimeState().drivers.size).toBe(1)

    resetQueueRuntime()

    expect(listRegisteredQueueJobs().map(entry => entry.name)).toEqual(['jobs.cleanup'])
    expect(Queue.connection().name).toBe('sync')
    expect(queueRuntimeInternals.getQueueRuntimeState().drivers.size).toBe(0)
    expect(queueRuntimeInternals.getQueueRuntimeState().driverFactories.size).toBe(2)
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1)
    })
    await expect(dispatch('jobs.cleanup', {
      ok: true,
    }).dispatch()).resolves.toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
  })

  it('unregisters individual jobs without clearing the entire registry', async () => {
    registerNamedJob('jobs.keep', {
      async handle() {},
    })
    registerNamedJob('jobs.remove', {
      async handle() {},
    })

    expect(unregisterQueueJob('jobs.remove')).toBe(true)
    expect(unregisterQueueJob('jobs.remove')).toBe(false)
    expect(listRegisteredQueueJobs().map(entry => entry.name)).toEqual(['jobs.keep'])
  })

  it('exposes the stable runtime accessor and awaits driver teardown during shutdown', async () => {
    let releaseClose: (() => void) | undefined
    const close = vi.fn(() => new Promise<void>((resolve) => {
      releaseClose = resolve
    }))

    registerNamedJob('jobs.shutdown', {
      async handle() {},
    })

    configureQueueRuntime({
      config: {
        default: 'database',
        connections: {
          database: {
            driver: 'database',
            queue: 'reports',
          },
        },
      },
      driverFactories: [
        createAsyncDriverFactory('database', vi.fn(), close),
      ],
    })

    const beforeDispatch = getQueueRuntime()
    expect(beforeDispatch.config.default).toBe('database')
    expect(beforeDispatch.drivers.size).toBe(0)
    expect(queueRuntimeInternals.createQueueRuntimeBinding(queueRuntimeInternals.getQueueRuntimeState())).toEqual(beforeDispatch)

    await dispatch('jobs.shutdown', {
      ok: true,
    }).dispatch()

    const shutdownPromise = shutdownQueueRuntime()
    expect(close).toHaveBeenCalledTimes(1)
    expect(listRegisteredQueueJobs()).toHaveLength(1)

    releaseClose?.()
    await shutdownPromise

    expect(getQueueRuntime().config.default).toBe('sync')
    expect(getQueueRuntime().drivers.size).toBe(0)
    expect(listRegisteredQueueJobs().map(entry => entry.name)).toEqual(['jobs.shutdown'])
    await expect(dispatch('jobs.shutdown', {
      ok: true,
    }).dispatch()).resolves.toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
  })

  it('closes cached drivers when runtime configuration changes and swallows close failures', async () => {
    const dispatched = vi.fn()
    const close = vi.fn(async () => {})
    const failingClose = vi.fn(async () => {
      throw new Error('close failed')
    })

    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
          },
        },
      },
      redisConfig: sharedRedisConfig,
      driverFactories: [
        createAsyncDriverFactory('redis', dispatched, close),
      ],
    })

    registerNamedJob('jobs.reconfigure', {
      async handle() {},
    })

    await dispatch('jobs.reconfigure', {
      ok: true,
    }).dispatch()
    configureQueueRuntime({
      driverFactories: [
        createAsyncDriverFactory('redis', dispatched, failingClose),
      ],
    })

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1)
    })

    expect(queueRuntimeInternals.getQueueRuntimeState().drivers.size).toBe(0)
    queueRuntimeInternals.closeQueueDrivers([])
    await Promise.resolve()
  })

  it('swallows explicit closeQueueDrivers teardown failures', async () => {
    queueRuntimeInternals.closeQueueDrivers([{
      name: 'broken',
      driver: 'sync',
      mode: 'sync',
      async dispatch() {
        return {
          jobId: 'broken',
          synchronous: true,
          result: undefined,
        }
      },
      async clear() {
        return 0
      },
      async close() {
        throw new Error('close failed')
      },
    }])

    await Promise.resolve()
  })

  it('falls back to the default queue name when runtime config is already normalized without a queue value', async () => {
    queueRuntimeInternals.getQueueRuntimeState().config = {
      default: 'sync',
      failed: false,
      connections: {
        sync: {
          name: 'sync',
          driver: 'sync',
        },
      },
    } as never

    registerNamedJob('jobs.default-queue', {
      async handle(_payload, context) {
        return context.queue
      },
    })

    await expect(dispatchSync<QueueJsonValue, string>('jobs.default-queue', {
      ok: true,
    })).resolves.toBe('default')
  })
})
