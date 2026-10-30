import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSQLiteQueueHarness } from '../../queue-db/tests/support/sqlite-queue'
import type { EventReferenceInput, ListenerHandledEvent } from '../src'
import {
  configureQueueRuntime,
  listFailedQueueJobs,
  runQueueWorker,
  getRegisteredQueueJob,
  normalizeQueueConfig,
  resetQueueRegistry,
  resetQueueRuntime,
} from '@holo-js/queue'
import {
  EVENTS_INVOKE_LISTENER_JOB,
  Event,
  defineEvent,
  defineListener,
  dispatchEvent,
  ensureEventsQueueJobRegistered,
  registerEvent,
  registerListener,
  resetEventsRegistry,
  resetEventsRuntime,
  runQueuedListenerInvocation,
  unregisterListener,
} from '../src'

const execFileAsync = promisify(execFile)
type PackageManifest = {
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly peerDependenciesMeta?: Record<string, {
    readonly optional?: boolean
  }>
  readonly devDependencies?: Record<string, string>
}

async function runBun(args: string[]): Promise<{ stdout: string, stderr: string } | undefined> {
  try {
    return await execFileAsync('bun', args, {
      timeout: 30_000,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

afterEach(() => {
  resetEventsRegistry()
  resetEventsRuntime()
  resetQueueRegistry()
  resetQueueRuntime()
  vi.useRealTimers()
})

describe('@holo-js/events queue integration', () => {
  it('publishes the queue integration as an optional peer dependency', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as PackageManifest

    expect(manifest.dependencies?.['@holo-js/queue']).toBeUndefined()
    expect(manifest.peerDependencies?.['@holo-js/queue']).toBe('*')
    expect(manifest.peerDependenciesMeta?.['@holo-js/queue']?.optional).toBe(true)
    expect(manifest.devDependencies?.['@holo-js/queue']).toBe('catalog:')
  })

  it('imports a bundled Events integration without Queue and reports registration errors', async () => {
    const outdir = await mkdtemp(join(tmpdir(), 'holo-events-queue-bundle-'))

    try {
      const result = await runBun([
        'build',
        resolve(import.meta.dirname, '../src/index.ts'),
        '--target=node',
        '--format=esm',
        '--external=@holo-js/*',
        `--outdir=${outdir}`,
      ])
      if (!result) {
        return
      }

      await mkdir(join(outdir, 'node_modules/@holo-js'), { recursive: true })
      await symlink(dirname(dirname(fileURLToPath(import.meta.resolve('@holo-js/db')))), join(outdir, 'node_modules/@holo-js/db'))
      const bundleUrl = pathToFileURL(join(outdir, 'index.js')).href
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict'
        const events = await import(${JSON.stringify(bundleUrl)})
        const message = '[@holo-js/events] Queued listeners require @holo-js/queue to be installed.'
        assert.throws(() => events.ensureEventsQueueJobRegistered(), { message })
        await assert.rejects(events.ensureEventsQueueJobRegisteredAsync(), { message })
        console.log('optional Queue remains optional')
      `])
      expect(stdout.trim()).toBe('optional Queue remains optional')
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })

  it('auto-registers the internal listener job and executes queued listeners through the sync queue driver', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const handled = vi.fn(async (_event: ListenerHandledEvent<EventReferenceInput>) => {})
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle(event) {
        await handled(event)
      },
    }))

    const result = await dispatchEvent('user.registered', {
      userId: 'usr-1',
    })

    expect(result).toMatchObject({
      eventName: 'user.registered',
      syncListeners: 0,
      queuedListeners: 1,
    })
    expect(getRegisteredQueueJob(EVENTS_INVOKE_LISTENER_JOB)?.name).toBe(EVENTS_INVOKE_LISTENER_JOB)
    expect(handled).toHaveBeenCalledTimes(1)
    expect(handled).toHaveBeenCalledWith(expect.objectContaining({
      name: 'user.registered',
      payload: {
        userId: 'usr-1',
      },
      occurredAt: expect.any(Number),
    }))
  })

  it('runs mixed sync and queued listeners through the real queue path in registration order', async () => {
    registerEvent(defineEvent<{ userId: string }, 'user.registered'>({
      name: 'user.registered',
    }))

    const order: string[] = []
    registerListener(defineListener({
      name: 'sync.audit',
      listensTo: ['user.registered'],
      async handle() {
        order.push('sync')
      },
    }))
    registerListener(defineListener({
      name: 'queued.welcome',
      listensTo: ['user.registered'],
      queue: true,
      async handle() {
        order.push('queued')
      },
    }))

    const result = await Event.dispatch('user.registered', {
      userId: 'usr-1',
    })

    expect(result).toMatchObject({
      syncListeners: 1,
      queuedListeners: 1,
    })
    expect(order).toEqual(['sync', 'queued'])
  })

  it('delays queued listeners and honors the submitted queue override on a real database queue', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      const handled: string[] = []
      const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
      registerEvent(event)
      registerListener(defineListener({
        name: 'send.welcome', listensTo: [event], queue: true, connection: 'database', queueName: 'emails', delay: 1,
        handle(envelope) { handled.push(envelope.payload.userId) },
      }))
      await Event.dispatch(event, { userId: 'default' })
      await Event.dispatch(event, { userId: 'override' }).onQueue('high').delay(0)
      expect(await runQueueWorker({ connection: 'database', queueNames: ['emails'], once: true })).toMatchObject({ processed: 0 })
      expect(await runQueueWorker({ connection: 'database', queueNames: ['high'], once: true })).toMatchObject({ processed: 1 })
      expect(handled).toEqual(['override'])
      await vi.waitFor(async () => {
        expect(await runQueueWorker({ connection: 'database', queueNames: ['emails'], once: true })).toMatchObject({ processed: 1 })
      }, { timeout: 10_000, interval: 50 })
      expect(handled).toEqual(['override', 'default'])
    } finally {
      await database.cleanup()
    }
  })

  it('applies listener tries to the queued job and defaults framework listeners to one try', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
      registerEvent(event)
      registerListener(defineListener({
        name: 'send.welcome', listensTo: [event], queue: true, connection: 'database', tries: 3,
        handle() {},
      }))
      registerListener(defineListener({
        name: 'send.digest', listensTo: [event], queue: true, connection: 'database', queueName: 'digests',
        handle() {},
      }))
      await Event.dispatch(event, { userId: 'usr-1' })
      expect((await database.readJobRows()).map(row => row.max_attempts).sort()).toEqual([1, 3])
    } finally {
      await database.cleanup()
    }
  })

  it('retries a failing queued listener after its backoff and runs the next attempt', async () => {
    const database = await createSQLiteQueueHarness()
    try {
      const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
      registerEvent(event)
      const attempts: number[] = []
      registerListener(defineListener({
        name: 'send.welcome', listensTo: [event], queue: true, connection: 'database', tries: 2, backoff: 1,
        handle() {
          attempts.push(attempts.length + 1)
          if (attempts.length === 1) throw new Error('transient')
        },
      }))
      await Event.dispatch(event, { userId: 'usr-1' })
      const released: (number | undefined)[] = []
      expect(await runQueueWorker({ connection: 'database', once: true, onJobReleased: ({ delaySeconds }) => { released.push(delaySeconds) } }))
        .toMatchObject({ processed: 0, released: 1, failed: 0 })
      expect(released).toEqual([1])
      await vi.waitFor(async () => {
        expect(await runQueueWorker({ connection: 'database', once: true })).toMatchObject({ processed: 1, failed: 0 })
      }, { timeout: 10_000, interval: 50 })
      expect(attempts).toEqual([1, 2])
    } finally {
      await database.cleanup()
    }
  })

  it('fails a queued listener terminally when its backoff is set but no attempts remain', async () => {
    const database = await createSQLiteQueueHarness({ createFailedTable: true })
    try {
      const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
      registerEvent(event)
      let handled = 0
      registerListener(defineListener({
        name: 'send.welcome', listensTo: [event], queue: true, connection: 'database', tries: 2, backoff: 0,
        handle() {
          handled += 1
          throw new Error('still failing')
        },
      }))
      await Event.dispatch(event, { userId: 'usr-1' })
      expect(await runQueueWorker({ connection: 'database', once: true })).toMatchObject({ released: 1, failed: 0 })
      expect(await runQueueWorker({ connection: 'database', once: true })).toMatchObject({ processed: 0, failed: 1 })
      expect(handled).toBe(2)
      expect(await listFailedQueueJobs()).toHaveLength(1)
    } finally {
      await database.cleanup()
    }
  })

  it('reports a failed backoff release and still rethrows the listener error', async () => {
    const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
    registerEvent(event)
    const handlerError = new Error('transient')
    const releaseError = new Error('queue unavailable')
    const listener = registerListener(defineListener({
      name: 'send.welcome', listensTo: [event], queue: true, backoff: 1,
      handle() {
        throw handlerError
      },
    }))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      await expect(runQueuedListenerInvocation(
        { listenerId: listener.id, eventName: 'user.registered', occurredAt: 0, payload: { userId: 'usr-1' } },
        { attempt: 1, maxAttempts: 2, release: async () => { throw releaseError } } as never,
      )).rejects.toBe(handlerError)
      expect(consoleError).toHaveBeenCalledWith('[holo:events] listener.releaseRetry', releaseError)
    } finally {
      consoleError.mockRestore()
    }
  })

  it('rejects listener tries and backoff without queue delivery and invalid values', () => {
    const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
    expect(() => defineListener({ listensTo: [event], tries: 2, handle() {} }))
      .toThrow('[Holo Events] Listener queue metadata requires queue: true.')
    expect(() => defineListener({ listensTo: [event], queue: true, backoff: 1, handle() {} })).not.toThrow()
    expect(() => defineListener({ listensTo: [event], queue: true, tries: 0, handle() {} }))
      .toThrow('[Holo Events] Listener tries must be an integer greater than or equal to 1.')
    expect(() => defineListener({ listensTo: [event], queue: true, backoff: [] as unknown as number[], handle() {} }))
      .toThrow('[Holo Events] Listener backoff must be an integer greater than or equal to 0 or a non-empty array of them.')
  })

  it.each(['removed', 'retargeted', 'throws'] as const)('fails a persisted listener job when its listener is %s', async (failure) => {
    const database = await createSQLiteQueueHarness({ createFailedTable: true })
    try {
      const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
      const deleted = defineEvent<{ userId: string }, 'user.deleted'>({ name: 'user.deleted' })
      registerEvent(event)
      registerEvent(deleted)
      let handled = 0
      registerListener(defineListener({
        name: 'send.welcome', listensTo: [event], queue: true,
        handle() {
          handled += 1
          throw new Error('listener failed')
        },
      }))
      await Event.dispatch(event, { userId: 'usr-1' })
      if (failure === 'removed') unregisterListener('send.welcome')
      if (failure === 'retargeted') {
        registerListener(defineListener({ name: 'send.welcome', listensTo: [deleted], queue: true, handle() {} }), { replaceExisting: true })
      }
      const errors: string[] = []
      expect(await runQueueWorker({ connection: 'database', once: true, onJobFailed({ error }) { errors.push(error.message) } })).toMatchObject({ processed: 0, failed: 1 })
      expect(errors).toEqual([failure === 'throws' ? 'listener failed' : failure === 'removed'
        ? '[Holo Events] Queued listener "send.welcome" is not registered.'
        : '[Holo Events] Queued listener "send.welcome" is not registered for event "user.registered".'])
      expect(handled).toBe(failure === 'throws' ? 1 : 0)
      expect(await listFailedQueueJobs()).toHaveLength(1)
      expect(await runQueueWorker({ connection: 'database', once: true })).toMatchObject({ processed: 0, failed: 0 })
    } finally {
      await database.cleanup()
    }
  })

  it('registers dispatchable listener jobs synchronously and again after Queue resets', async () => {
    const handled: string[] = []
    const event = defineEvent<{ userId: string }, 'user.registered'>({ name: 'user.registered' })
    registerEvent(event)
    registerListener(defineListener({
      name: 'send.welcome',
      listensTo: [event],
      queue: true,
      handle(envelope) { handled.push(envelope.payload.userId) },
    }))

    await Event.dispatch(event, { userId: 'usr-1' })
    resetQueueRegistry()
    await Event.dispatch(event, { userId: 'usr-2' })
    expect(handled).toEqual(['usr-1', 'usr-2'])
  })

})
