import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorReportingInternals, type HoloErrorReportContext } from '@holo-js/kernel/error-reporting'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import { createQueueDbRuntimeOptions } from '../../queue-db/src'
import { redisQueueDriverFactory } from '../../queue-redis/src'
import { startRedisService } from '../../session/tests/support/redis'
import type { QueueJobEnvelope, QueueJsonValue, QueueReservedJob, RegisterableQueueJobDefinition } from '../src'
import {
  Queue,
  runQueueWorker,
  clearQueueConnection,
  QueueReleaseUnsupportedError,
  configureQueueRuntime,
  defineJob,
  dispatch,
  dispatchSync,
  getQueueRuntime,
  getRegisteredQueueJob,
  listRegisteredQueueJobs,
  loadQueuePluginDriverFactories,
  loadQueuePluginDrivers,
  normalizeQueueConfig,
  queueRegistryInternals,
  queueRuntimeInternals,
  registerQueueJob,
  registerQueueJobs,
  resetQueueRegistry,
  resetQueuePluginDriverFactories,
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

afterEach(() => {
  resetQueueRegistry()
  resetQueueRuntime()
  errorReportingInternals.configure(undefined)
  vi.useRealTimers()
})

function collectReportedErrors(): Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> {
  const reports: Array<{ readonly error: unknown, readonly context: HoloErrorReportContext }> = []
  errorReportingInternals.configure({
    report(error, context) {
      reports.push({ error, context })
    },
  })
  return reports
}

function registerNamedJob<TPayload extends QueueJsonValue, TResult>(
  name: string,
  definition: RegisterableQueueJobDefinition<TPayload, TResult>,
) {
  return registerQueueJob(definition, { name })
}

describe('@holo-js/queue runtime', () => {
  it('rethrows invalid queue plugin driver factories after a failed load attempt', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-queue-broken-plugin-'))

    try {
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({
        name: 'queue-broken-plugin-fixture',
        private: true,
      }, null, 2))
      await mkdir(join(projectRoot, 'config'), { recursive: true })
      await writeFile(join(projectRoot, 'config/app.mjs'), `
export default {
  plugins: ['holo-plugin-broken-queue'],
}
`)
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-broken-queue')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'holo-plugin-broken-queue',
        type: 'module',
        holo: {
          plugin: './plugin.mjs',
        },
      }, null, 2))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `
export default {
  id: 'broken-queue-plugin',
  contributes: {
    queue: {
      drivers: {
        broken: {
          runtime: './driver.mjs',
        },
      },
    },
  },
}
`)
      await writeFile(join(pluginRoot, 'driver.mjs'), `
export default {
  driver: 'broken',
}
`)

      await expect(loadQueuePluginDriverFactories(projectRoot, ['holo-plugin-broken-queue'])).rejects.toThrow('must export a matching QueueDriverFactory')
      await expect(loadQueuePluginDriverFactories(projectRoot, ['holo-plugin-broken-queue'])).rejects.toThrow('must export a matching QueueDriverFactory')
    } finally {
      resetQueuePluginDriverFactories()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('executes persisted plugin jobs through normalized configuration', async () => {
    const service = await startRedisService()
    const port = service.ports[0]
    if (port === undefined) throw new Error('Expected an owned Redis port')
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-native-queue-plugin-'))
    try {
      await mkdir(join(projectRoot, 'node_modules/holo-plugin-native-queue'), { recursive: true })
      await symlink(resolve(import.meta.dirname, '../../..', 'packages'), join(projectRoot, 'node_modules/@holo-js'))
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module' }))
      const pluginRoot = join(projectRoot, 'node_modules/holo-plugin-native-queue')
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'holo-plugin-native-queue', type: 'module', holo: { plugin: './plugin.mjs' } }))
      await writeFile(join(pluginRoot, 'plugin.mjs'), "export default { id: 'native-queue', contributes: { queue: { drivers: { native: { runtime: './driver.mjs' } } } } }")
      const driverPath = join(pluginRoot, 'driver.mjs')
      await writeFile(driverPath, `
import { redisQueueDriverFactory } from '@holo-js/queue-redis'
export default {
  driver: 'native',
  create(connection, context) {
    return redisQueueDriverFactory.create({ ...connection, driver: 'redis', redis: { host: '127.0.0.1', port: ${port}, db: 0 } }, context)
  },
}
`)
      await loadQueuePluginDrivers(projectRoot, ['holo-plugin-native-queue'])
      configureQueueRuntime({ config: { default: 'native', failed: false, connections: { native: { driver: 'native', queue: 'native-jobs', retryAfter: 30, blockFor: 0 } } } })
      const handled: string[] = []
      registerNamedJob('native.deliver', defineJob({ async handle(payload: { message: string }) { handled.push(payload.message) } }))
      await expect(dispatch('native.deliver', { message: 'persisted' })).resolves.toMatchObject({ connection: 'native', queue: 'native-jobs', synchronous: false })
      expect(handled).toEqual([])
      const first = await runQueueWorker({ connection: 'native', stopWhenEmpty: true })
      expect(first.processed).toBe(1)
      expect(handled).toEqual(['persisted'])
      const second = await runQueueWorker({ connection: 'native', stopWhenEmpty: true })
      expect(second.processed).toBe(0)
      expect(handled).toEqual(['persisted'])
    } finally {
      await shutdownQueueRuntime()
      resetQueuePluginDriverFactories()
      await rm(projectRoot, { recursive: true, force: true })
    }
  }, 30000)

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

  it('dispatches through registered job definitions', async () => {
    const job = defineJob({
      tries: 2,
      async handle(payload: { readonly userId: string }, context) {
        return {
          userId: payload.userId,
          attempt: context.attempt,
        }
      },
    })
    registerNamedJob('users.digest', job)

    const asyncResult = await job.dispatch({
      userId: 'usr-1',
    })
    const syncResult = await job.dispatchSync({
      userId: 'usr-2',
    })

    expect(asyncResult).toMatchObject({
      connection: 'sync',
      queue: 'default',
      synchronous: true,
    })
    expect(syncResult).toEqual({
      userId: 'usr-2',
      attempt: 1,
    })
  })

  it.each(['distinct handlers', 'closed-over handlers'] as const)(
    'dispatches only registered definitions with matching options and %s',
    async (handlerKind) => {
      const createJob = (prefix: string) => defineJob({
        async handle(payload: { readonly id: string }) {
          return `${prefix}:${payload.id}`
        },
      })
      const first = handlerKind === 'closed-over handlers'
        ? createJob('FIRST')
        : defineJob({
            async handle(payload: { readonly id: string }) {
              return `FIRST:${payload.id}`
            },
          })
      const second = handlerKind === 'closed-over handlers'
        ? createJob('SECOND')
        : defineJob({
            async handle(payload: { readonly id: string }) {
              return `SECOND:${payload.id}`
            },
          })
      registerNamedJob('jobs.first', first)

      expect(() => second.dispatch({ id: '42' })).toThrow('cannot dispatch before the job is registered')
      expect(() => second.dispatchSync({ id: '42' })).toThrow('cannot dispatch before the job is registered')

      registerNamedJob('jobs.second', second)

      await expect(first.dispatchSync({ id: '42' })).resolves.toBe('FIRST:42')
      await expect(second.dispatchSync({ id: '42' })).resolves.toBe('SECOND:42')
    },
  )

  it.each(['unregister', 'reset', 'replace'] as const)(
    'revokes typed dispatch when its registration is removed by %s',
    async (operation) => {
      const original = defineJob({ async handle() { return 'original' } })
      const replacement = defineJob({ async handle() { return 'replacement' } })
      const registration = registerQueueJob(original, { name: 'jobs.lifetime' })
      const registeredDefinition = defineJob(registration.definition)
      await expect(registeredDefinition.dispatchSync({})).resolves.toBe('original')
      if (operation === 'unregister') unregisterQueueJob('jobs.lifetime')
      if (operation === 'reset') resetQueueRegistry()
      registerQueueJob(replacement, { name: 'jobs.lifetime', replaceExisting: operation === 'replace' })

      expect(() => original.dispatchSync({})).toThrow('cannot dispatch before the job is registered')
      expect(() => registeredDefinition.dispatchSync({})).toThrow('cannot dispatch before the job is registered')
      await expect(replacement.dispatchSync({})).resolves.toBe('replacement')
    },
  )

  it('retains typed dispatch when another name for the same definition is unregistered', async () => {
    const job = defineJob({ async handle(_payload, context) { return context.jobName } })
    registerNamedJob('jobs.previous', job)
    registerNamedJob('jobs.current', job)
    unregisterQueueJob('jobs.previous')

    await expect(job.dispatchSync({})).resolves.toBe('jobs.current')
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

  it('reports hook failures and preserves the original dispatch outcome when pending dispatch hooks fail', async () => {
    const reports = collectReportedErrors()
    const completeHookError = new Error('complete hook failed')
    const failedHookError = new Error('failed hook failed')

    registerNamedJob('jobs.hook-warning', {
      async handle(payload) {
        return payload
      },
    })

    await expect(dispatch('jobs.hook-warning', { ok: true })
      .onComplete(async () => {
        throw completeHookError
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
        throw failedHookError
      })).rejects.toThrow('Queue job "missing.job" is not registered.')

    await expect(dispatch('missing.job', { ok: true })
      .onFailed(async () => {
        throw 'failed hook string failed'
      })).rejects.toThrow('Queue job "missing.job" is not registered.')

    expect(reports).toEqual([
      { error: completeHookError, context: { capability: 'queue', operation: 'dispatch.onComplete' } },
      { error: 'complete hook string failed', context: { capability: 'queue', operation: 'dispatch.onComplete' } },
      { error: failedHookError, context: { capability: 'queue', operation: 'dispatch.onFailed' } },
      { error: 'failed hook string failed', context: { capability: 'queue', operation: 'dispatch.onFailed' } },
    ])
  })

  it('runs job completion hooks for synchronous execution and reports hook failures', async () => {
    const onCompleted = vi.fn()
    const reports = collectReportedErrors()

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
    expect(reports).toEqual([{ error: 'hook failed', context: { capability: 'queue', operation: 'job.onCompleted' } }])
  })

  it('runs terminal failure hooks for synchronous execution and reports hook failures', async () => {
    const onFailed = vi.fn()
    const reports = collectReportedErrors()

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
    expect(reports).toEqual([{ error: 'hook blew up', context: { capability: 'queue', operation: 'job.onFailed' } }])
  })

  it('does not run terminal failure hooks when a real database rejects enqueueing', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      await database.schema.dropTable('jobs')
      let failed = 0
      registerNamedJob('jobs.async-enqueue-failure', {
        async handle() {},
        onFailed() { failed += 1 },
      })
      await expect(dispatch('jobs.async-enqueue-failure', { ok: true })).rejects.toThrow('no such table: jobs')
      expect(failed).toBe(0)
    } finally {
      await database.cleanup()
    }
  })

  it('routes real queued jobs using definition defaults and fluent overrides', async () => {
    const database = await createSQLiteQueueHarness({ queueConfig: {
      default: 'database', failed: false,
      connections: {
        database: { driver: 'database', connection: 'default', table: 'jobs', queue: 'reports' },
        secondary: { driver: 'database', connection: 'default', table: 'jobs', queue: 'emails' },
      },
    } })
    try {
      const handled: string[] = []
      registerNamedJob('mail.send', defineJob({
        connection: 'database', queue: 'mailers', tries: 5,
        handle(payload: { recipient: string }) { handled.push(payload.recipient) },
      }))
      await dispatch('mail.send', { recipient: 'a' }).onConnection('secondary')
      await dispatch('mail.send', { recipient: 'b' }).onQueue('priority')
      await dispatch('mail.send', { recipient: 'c' }).delay(30)
      await dispatch('mail.send', { recipient: 'd' }).onConnection('secondary').onQueue('critical').delay(new Date(Date.now() + 60000))
      await dispatch('mail.send', { recipient: 'e' }, { connection: 'secondary', queue: 'bulk', delay: 45 })
      const attempts: number[] = []
      expect(await runQueueWorker({ connection: 'secondary', queueNames: ['mailers'], once: true, onJobProcessed(event) { attempts.push(event.maxAttempts) } })).toMatchObject({ processed: 1 })
      expect(await runQueueWorker({ connection: 'database', queueNames: ['priority'], once: true })).toMatchObject({ processed: 1 })
      expect(await runQueueWorker({ connection: 'database', queueNames: ['mailers'], once: true })).toMatchObject({ processed: 0 })
      expect(await runQueueWorker({ connection: 'secondary', queueNames: ['critical', 'bulk'], once: true })).toMatchObject({ processed: 0 })
      expect(handled).toEqual(['a', 'b'])
      expect(attempts).toEqual([5])
      expect(await clearQueueConnection('database', { queueNames: ['mailers'] })).toBe(1)
      expect(await clearQueueConnection('secondary', { queueNames: ['critical', 'bulk'] })).toBe(2)
    } finally {
      await database.cleanup()
    }
  })

  it('executes asynchronous and synchronous jobs through the named connection facades', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      let handled = 0
      registerNamedJob('users.notify', defineJob({
        handle(payload: { ok: boolean }) { handled += 1
          return payload },
      }))
      expect(await Queue.connection('database').dispatch('users.notify', { ok: true })).toMatchObject({ connection: 'database', synchronous: false })
      expect(handled).toBe(0)
      expect(await useQueueConnection('database').dispatchSync<{ ok: boolean }, { ok: boolean }>('users.notify', { ok: true })).toEqual({ ok: true })
      expect(handled).toBe(1)
      expect(await runQueueWorker({ connection: 'database', once: true })).toMatchObject({ processed: 1 })
      expect(handled).toBe(2)
    } finally {
      await database.cleanup()
    }
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

  it('retains queued jobs and registered handlers when resetting the runtime', async () => {
    const database = await createSQLiteQueueHarness()
    const handled: string[] = []
    const job = defineJob({
      async handle(payload: { message: string }) {
        handled.push(payload.message)
        return payload.message
      },
    })
    try {
      registerNamedJob('jobs.cleanup', job)
      await job.dispatch({ message: 'queued before reset' })
      resetQueueRuntime()

      await expect(job.dispatch({ message: 'sync after reset' })).resolves.toMatchObject({
        connection: 'sync',
        synchronous: true,
      })
      await expect(job.dispatchSync({ message: 'sync result after reset' })).resolves.toBe('sync result after reset')
      expect(handled).toEqual(['sync after reset', 'sync result after reset'])

      configureQueueRuntime({
        config: { default: 'database', connections: { database: { driver: 'database', connection: 'default', table: 'jobs' } } },
        ...createQueueDbRuntimeOptions(),
      })
      await runQueueWorker({ connection: 'database', once: true })
      expect(handled).toEqual(['sync after reset', 'sync result after reset', 'queued before reset'])
      expect(await database.readJobRows()).toEqual([])
    } finally {
      await database.cleanup()
    }
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

  it('preserves persisted jobs and handlers across shutdown and restart', async () => {
    const database = await createSQLiteQueueHarness()
    const handled: string[] = []
    const job = defineJob({
      async handle(payload: { message: string }) {
        handled.push(payload.message)
      },
    })
    try {
      registerNamedJob('jobs.shutdown', job)
      await job.dispatch({ message: 'before shutdown' })
      await shutdownQueueRuntime()
      await shutdownQueueRuntime()
      await job.dispatch({ message: 'after shutdown' })
      expect(handled).toEqual(['after shutdown'])

      configureQueueRuntime({
        config: { default: 'database', connections: { database: { driver: 'database', connection: 'default', table: 'jobs' } } },
        ...createQueueDbRuntimeOptions(),
      })
      await runQueueWorker({ connection: 'database', once: true })
      expect(handled).toEqual(['after shutdown', 'before shutdown'])
      expect(await database.readJobRows()).toEqual([])
    } finally {
      await database.cleanup()
    }
  })

  it('preserves real Redis jobs across shutdown after the server denies QUIT', async () => {
    const service = await startRedisService()
    const port = service.ports[0]
    const admin = service.clients[0]
    if (port === undefined || !admin) throw new Error('Expected an owned Redis server')
    await admin.acl('SETUSER', 'worker', 'on', '>secret', '~*', '+@all')
    const options = {
      config: { default: 'redis', connections: { redis: { driver: 'redis' as const, queue: 'shutdown', connection: 'default' } } },
      redisConfig: { default: 'default', connections: { default: { name: 'default', host: '127.0.0.1', port, db: 0, username: 'worker', password: 'secret' } } },
      driverFactories: [redisQueueDriverFactory],
    }
    const handled: string[] = []
    registerNamedJob('jobs.shutdown', { async handle(payload: { message: string }) { handled.push(payload.message) } })
    configureQueueRuntime(options)
    await dispatch('jobs.shutdown', { message: 'before shutdown' }).dispatch()
    await admin.acl('SETUSER', 'worker', '-quit')
    await shutdownQueueRuntime()
    await admin.acl('SETUSER', 'worker', '+quit')
    configureQueueRuntime(options)
    await runQueueWorker({ connection: 'redis', once: true })
    expect(handled).toEqual(['before shutdown'])
    expect(await clearQueueConnection('redis')).toBe(0)
    await shutdownQueueRuntime()
  }, 15000)

  it('uses the default queue name when no queue is configured', async () => {
    configureQueueRuntime({
      config: { default: 'sync', connections: { sync: { driver: 'sync' } } },
    })

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
