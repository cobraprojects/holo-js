import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueueAsyncDriver, QueueDriver } from '../src'

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

const execFileAsync = promisify(execFile)

async function hasBun(): Promise<boolean> {
  try {
    await execFileAsync('bun', ['--version'], {
      timeout: 30_000,
    })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }

    throw error
  }
}

type StoredJobState = 'waiting' | 'active' | 'delayed' | 'completed' | 'failed' | 'removed'

type StoredJob = {
  key: string
  id?: string
  name: string
  data: unknown
  queueName: string
  state: StoredJobState
  attempts: number
  attemptsStarted: number
  attemptsMade: number
  timestamp: number
  availableAt?: number
  token?: string
  removeOnComplete: boolean
  removeOnFail: boolean
  discarded: boolean
  moveToCompletedError?: unknown
  moveToWaitError?: unknown
  moveToDelayedError?: unknown
  moveToFailedError?: unknown
}

type QueueRecord = {
  options?: unknown
  jobs: StoredJob[]
  addError?: unknown
  forceUndefinedAddId?: boolean
  countError?: unknown
  drainError?: unknown
  closeError?: unknown
}

type WorkerRecord = {
  options?: unknown
  getNextJobError?: unknown
  getNextJobCalls?: Array<{
    readonly token: string
    readonly block: boolean
  }>
  getNextJobImpl?: (input: {
    readonly token: string
    readonly block: boolean
    readonly queue: QueueRecord
  }) => StoredJob | null | Promise<StoredJob | null>
  waitUntilReadyError?: unknown
  closeError?: unknown
}

type BullState = {
  queues: Map<string, QueueRecord>
  workers: Map<string, WorkerRecord>
  nextId: number
}

function createBullState(): BullState {
  return {
    queues: new Map<string, QueueRecord>(),
    workers: new Map<string, WorkerRecord>(),
    nextId: 1,
  }
}

function ensureQueueRecord(state: BullState, queueName: string): QueueRecord {
  let record = state.queues.get(queueName)
  if (!record) {
    record = {
      jobs: [],
    }
    state.queues.set(queueName, record)
  }

  return record
}

function ensureWorkerRecord(state: BullState, queueName: string): WorkerRecord {
  let record = state.workers.get(queueName)
  if (!record) {
    record = {}
    state.workers.set(queueName, record)
  }

  return record
}

function jobMatchesType(job: StoredJob, type: string): boolean {
  switch (type) {
    case 'wait':
    case 'waiting':
      return job.state === 'waiting'
    case 'paused':
    case 'prioritized':
      return false
    case 'delayed':
      return job.state === 'delayed'
    case 'active':
      return job.state === 'active'
    case 'completed':
      return job.state === 'completed'
    case 'failed':
      return job.state === 'failed'
    default:
      return false
  }
}

async function loadRedisQueueModule() {
  vi.resetModules()
  const state = createBullState()

  vi.doMock('bullmq', () => {
    class FakeJob {
      constructor(private readonly entry: StoredJob) {}

      get id() {
        return this.entry.id
      }

      get data() {
        return this.entry.data
      }

      get attemptsStarted() {
        return this.entry.attemptsStarted
      }

      get attemptsMade() {
        return this.entry.attemptsMade
      }

      discard() {
        this.entry.discarded = true
      }

      get opts() {
        return {
          attempts: this.entry.attempts,
        }
      }

      async moveToCompleted(_value: unknown, token: string) {
        if (this.entry.moveToCompletedError) {
          throw this.entry.moveToCompletedError
        }

        if (this.entry.token !== token) {
          throw new Error('Token mismatch while completing job.')
        }

        this.entry.token = undefined
        this.entry.state = this.entry.removeOnComplete ? 'removed' : 'completed'
      }

      async moveToWait(token?: string) {
        if (this.entry.moveToWaitError) {
          throw this.entry.moveToWaitError
        }

        if (this.entry.token !== token) {
          throw new Error('Token mismatch while releasing job.')
        }

        this.entry.token = undefined
        this.entry.state = 'waiting'
      }

      async moveToDelayed(timestamp: number, token?: string) {
        if (this.entry.moveToDelayedError) {
          throw this.entry.moveToDelayedError
        }

        if (this.entry.token !== token) {
          throw new Error('Token mismatch while delaying job.')
        }

        this.entry.token = undefined
        this.entry.availableAt = timestamp
        this.entry.state = 'delayed'
      }

      async moveToFailed(_error: Error, token: string) {
        if (this.entry.moveToFailedError) {
          throw this.entry.moveToFailedError
        }

        if (this.entry.token !== token) {
          throw new Error('Token mismatch while failing job.')
        }

        this.entry.token = undefined
        this.entry.attemptsMade += 1
        this.entry.state = (this.entry.removeOnFail || this.entry.discarded) ? 'removed' : 'failed'
      }
    }

    class FakeQueue {
      readonly record: QueueRecord

      constructor(private readonly queueName: string, options?: unknown) {
        this.record = ensureQueueRecord(state, queueName)
        this.record.options = options
      }

      async add(name: string, data: unknown, options?: {
        attempts?: number
        delay?: number
        jobId?: string
        removeOnComplete?: boolean
        removeOnFail?: boolean
        timestamp?: number
      }) {
        if (this.record.addError) {
          throw this.record.addError
        }

        const id = this.record.forceUndefinedAddId
          ? undefined
          : (options?.jobId ?? `auto-${state.nextId++}`)
        const entry: StoredJob = {
          key: id ?? `auto-${state.nextId++}`,
          id,
          name,
          data,
          queueName: this.queueName,
          state: typeof options?.delay === 'number' && options.delay > 0 ? 'delayed' : 'waiting',
          attempts: options?.attempts ?? 1,
          attemptsStarted: 0,
          attemptsMade: 0,
          timestamp: options?.timestamp ?? Date.now(),
          ...(typeof options?.delay === 'number' && options.delay > 0 ? { availableAt: Date.now() + options.delay } : {}),
          removeOnComplete: options?.removeOnComplete === true,
          removeOnFail: options?.removeOnFail === true,
          discarded: false,
        }

        this.record.jobs.push(entry)
        return new FakeJob(entry)
      }

      async getJobCountByTypes(...types: string[]) {
        if (this.record.countError) {
          throw this.record.countError
        }

        return this.record.jobs.filter(job => types.some(type => jobMatchesType(job, type))).length
      }

      async drain(delayed?: boolean) {
        if (this.record.drainError) {
          throw this.record.drainError
        }

        this.record.jobs = this.record.jobs.filter((job) => {
          if (job.state === 'waiting') {
            return false
          }

          if (delayed === true && job.state === 'delayed') {
            return false
          }

          return true
        })
      }

      async close() {
        if (this.record.closeError) {
          throw this.record.closeError
        }
      }
    }

    class FakeWorker {
      readonly record: WorkerRecord

      constructor(private readonly queueName: string, _processor: unknown, options?: unknown) {
        this.record = ensureWorkerRecord(state, queueName)
        this.record.options = options
      }

      async waitUntilReady() {
        if (this.record.waitUntilReadyError) {
          throw this.record.waitUntilReadyError
        }

        return {}
      }

      async getNextJob(token: string, options?: { block?: boolean }) {
        if (this.record.getNextJobError) {
          throw this.record.getNextJobError
        }

        const queue = ensureQueueRecord(state, this.queueName)
        const block = options?.block === true
        this.record.getNextJobCalls ??= []
        this.record.getNextJobCalls.push({
          token,
          block,
        })

        const resolved = this.record.getNextJobImpl
          ? await this.record.getNextJobImpl({
            token,
            block,
            queue,
          })
          : queue.jobs.find(job => job.state === 'waiting') ?? null

        const entry = resolved
        if (!entry) {
          return null
        }

        entry.state = 'active'
        entry.token = token
        entry.attemptsStarted += 1
        return new FakeJob(entry)
      }

      async close() {
        if (this.record.closeError) {
          throw this.record.closeError
        }
      }
    }

    return {
      Job: FakeJob,
      Queue: FakeQueue,
      Worker: FakeWorker,
    }
  })

  const queue = await import('../src')
  queue.resetQueueRuntime()
  return {
    queue,
    state,
  }
}

function requireAsyncDriver(driver: QueueDriver): QueueAsyncDriver {
  if (driver.mode !== 'async') {
    throw new Error('Expected an async queue driver.')
  }

  return driver
}

afterEach(() => {
  vi.doUnmock('bullmq')
  vi.doUnmock('@holo-js/queue-redis')
  vi.resetModules()
})

describe('@holo-js/queue redis driver', () => {
  it('keeps the optional redis driver import visible to bundlers without a bare package specifier', async () => {
    if (!await hasBun()) {
      return
    }

    const outdir = await mkdtemp(join(tmpdir(), 'holo-queue-redis-bundle-'))

    try {
      await execFileAsync('bun', [
        'build',
        resolve(import.meta.dirname, '../src/drivers/redis.ts'),
        '--target=node',
        '--format=esm',
        '--external=@holo-js/queue-redis',
        `--outdir=${outdir}`,
      ], {
        timeout: 30_000,
      })

      const output = await readFile(join(outdir, 'redis.js'), 'utf8')

      expect(output).toMatch(/\b(?:const|let|var)\s+specifier\s*=\s*['"]@holo-js\/queue-redis['"]/)
      expect(output).toMatch(/\bimport\s*\(\s*specifier\s*\)/)
      expect(output).not.toMatch(/import\(\s*['"]@holo-js\/queue-redis['"]\s*\)/)
    } finally {
      await rm(outdir, { recursive: true, force: true })
    }
  })

  it('exports the standalone config helper and supports closing unresolved redis drivers', async () => {
    const { queue } = await loadRedisQueueModule()
    const config = queue.defineQueueConfig({
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })

    expect(config).toEqual({
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })
    expect(Object.isFrozen(config)).toBe(true)

    const driver = queue.redisQueueDriverFactory.create({
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
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext())

    await expect(driver.close()).resolves.toBeUndefined()
  })

  it('rejects split drivers that do not implement the async contract', async () => {
    vi.resetModules()
    vi.doMock('@holo-js/queue-redis', () => ({
      redisQueueDriverFactory: {
        create() {
          return {
            mode: 'sync' as const,
          }
        },
      },
    }))

    const queue = await import('../src')
    const driver = queue.redisQueueDriverFactory.create({
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
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext())

    await expect(driver.dispatch({
      id: 'job-1',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'default',
      payload: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 0,
    })).rejects.toThrow('Redis queue driver must be async.')
  })

  it('dispatches, reserves, acknowledges, releases, deletes, clears, and closes through the async driver contract', async () => {
    const { queue, state } = await loadRedisQueueModule()
    queue.registerQueueJob({
      tries: 3,
      async handle(payload) {
        return payload
      },
    }, {
      name: 'redis.contract',
    })

    const driver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 1,
      },
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))

    const dispatched = await driver.dispatch({
      id: 'job-1',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'critical',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: 100,
    })
    expect(dispatched).toEqual({
      jobId: 'job-1',
      synchronous: false,
    })
    expect(state.queues.get('critical')?.options).toMatchObject({
      connection: {
        host: '127.0.0.1',
        port: 6379,
        db: 1,
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
      },
    })

    const reserved = await driver.reserve({
      queueNames: ['critical'],
      workerId: 'worker-1',
    })
    expect(reserved).toMatchObject({
      reservationId: expect.stringContaining('worker-1:'),
      envelope: {
        id: 'job-1',
        name: 'redis.contract',
        connection: 'redis',
        queue: 'critical',
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 3,
        createdAt: 100,
      },
    })
    await driver.acknowledge(reserved!)
    expect(state.queues.get('critical')?.jobs[0]?.state).toBe('removed')

    await driver.dispatch({
      id: 'job-2',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'critical',
      payload: {
        release: true,
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: 200,
    })

    const released = await driver.reserve({
      queueNames: ['critical'],
      workerId: 'worker-2',
    })
    await driver.release(released!, {
      delaySeconds: 4,
    })
    expect(state.queues.get('critical')?.jobs.find(job => job.id === 'job-2')).toMatchObject({
      state: 'delayed',
      availableAt: expect.any(Number),
    })

    const queueRecord = state.queues.get('critical')!
    const delayedJob = queueRecord.jobs.find(job => job.id === 'job-2')!
    delayedJob.state = 'waiting'
    const retried = await driver.reserve({
      queueNames: ['critical'],
      workerId: 'worker-3',
    })
    expect(retried?.envelope.attempts).toBe(1)
    await driver.delete(retried!)
    expect(delayedJob.state).toBe('removed')

    await driver.dispatch({
      id: 'job-2b',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'critical',
      payload: {
        release: false,
      },
      attempts: 0,
      maxAttempts: 3,
      createdAt: 250,
    })
    const immediateRelease = await driver.reserve({
      queueNames: ['critical'],
      workerId: 'worker-2b',
    })
    await driver.release(immediateRelease!)
    expect(state.queues.get('critical')?.jobs.find(job => job.id === 'job-2b')).toMatchObject({
      state: 'waiting',
      token: undefined,
    })

    await driver.dispatch({
      id: 'job-3',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'default',
      payload: {
        clear: true,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: 300,
    })
    await driver.dispatch({
      id: 'job-4',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'default',
      payload: {
        clearDelayed: true,
      },
      attempts: 0,
      maxAttempts: 1,
      availableAt: Date.now() + 60_000,
      createdAt: 400,
    })

    await expect(driver.clear()).resolves.toBe(3)
    expect(queueRecord.jobs.filter(job => job.state !== 'removed')).toEqual([])
    await expect(driver.close()).resolves.toBeUndefined()
  })

  it('passes redis URLs through to BullMQ connection options', async () => {
    const { queue, state } = await loadRedisQueueModule()

    const driver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        url: 'redis://cache.internal:6380/4',
        host: '127.0.0.1',
        port: 6379,
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))

    await driver.dispatch({
      id: 'job-url',
      name: 'redis.contract',
      connection: 'redis',
      queue: 'critical',
      payload: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 0,
    })

    const criticalQueueOptions = state.queues.get('critical')?.options as {
      readonly connection?: {
        readonly options?: {
          readonly host?: string
          readonly port?: number
          readonly username?: string
          readonly password?: string
          readonly db?: number
          readonly lazyConnect?: boolean
          readonly maxRetriesPerRequest?: null
        }
      }
    } | undefined

    expect(criticalQueueOptions?.connection).toMatchObject({
      options: {
        host: 'cache.internal',
        port: 6380,
        username: 'worker',
        password: 'secret',
        db: 4,
        lazyConnect: true,
        maxRetriesPerRequest: null,
      },
    })

    await driver.close()
  })

  it('supports default runtime integration for delayed dispatch, worker processing, and named queue routing', async () => {
    const { queue, state } = await loadRedisQueueModule()
    queue.configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'emails',
            blockFor: 0,
            redis: {
              db: 2,
            },
          },
        },
      },
      redisConfig: sharedRedisConfig,
    })

    queue.registerQueueJob({
      tries: 2,
      async handle(payload) {
        expect(payload).toEqual({ recipient: 'hello@example.com' })
      },
    }, {
      name: 'mail.send',
    })

    const delayedResult = await queue.dispatch('mail.send', {
      recipient: 'delayed@example.com',
    }).delay(5).dispatch()
    expect(delayedResult).toMatchObject({
      connection: 'redis',
      queue: 'emails',
      synchronous: false,
    })
    expect(state.queues.get('emails')?.jobs[0]?.state).toBe('delayed')

    const result = await queue.dispatch('mail.send', {
      recipient: 'hello@example.com',
    }).onQueue('priority').dispatch()
    expect(result).toEqual({
      jobId: expect.any(String),
      connection: 'redis',
      queue: 'priority',
      synchronous: false,
    })

    await expect(queue.runQueueWorker({
      connection: 'redis',
      queueNames: ['priority'],
      stopWhenEmpty: true,
    })).resolves.toEqual({
      processed: 1,
      released: 0,
      failed: 0,
      stoppedBecause: 'empty',
    })

    expect(state.queues.get('priority')?.jobs.find(job => job.state !== 'removed')).toBeUndefined()
    expect(queue.queueRuntimeInternals.createDefaultDriverFactories().has('redis')).toBe(true)
  })

  it('maps retry releases and blockFor zero to the shared worker loop without leaking BullMQ types', async () => {
    const { queue, state } = await loadRedisQueueModule()
    queue.configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'default',
            blockFor: 0,
          },
        },
      },
      redisConfig: sharedRedisConfig,
    })

    queue.registerQueueJob({
      tries: 2,
      backoff: [7, 11],
      async handle() {
        throw new Error('retry me')
      },
    }, {
      name: 'mail.retry',
    })

    await queue.dispatch('mail.retry', {
      recipient: 'fail@example.com',
    }).dispatch()

    await expect(queue.runQueueWorker({
      connection: 'redis',
      once: true,
    })).resolves.toEqual({
      processed: 0,
      released: 1,
      failed: 0,
      stoppedBecause: 'once',
    })

    expect(state.queues.get('default')?.jobs[0]).toMatchObject({
      state: 'delayed',
      availableAt: expect.any(Number),
    })
  })

  it('normalizes enqueue, reserve, malformed payload, missing id, and reserve setup failures', async () => {
    const { queue, state } = await loadRedisQueueModule()
    const driver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: 'redis.internal',
        port: 6380,
        db: 3,
      },
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))

    state.queues.set('default', {
      jobs: [],
      addError: new Error('redis down'),
    })
    await expect(driver.dispatch({
      id: 'job-1',
      name: 'broken',
      connection: 'redis',
      queue: 'default',
      payload: {
        ok: false,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: 100,
    })).rejects.toThrow('failed to enqueue job: redis down')

    state.queues.set('default', { jobs: [] })
    state.workers.set('default', {
      getNextJobError: new Error('reserve failed'),
    })
    await expect(driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })).rejects.toThrow('failed to reserve job: reserve failed')

    ensureWorkerRecord(state, 'default').getNextJobError = undefined
    state.queues.get('default')?.jobs.push({
      key: 'bad-payload',
      id: 'bad-payload',
      name: 'broken',
      data: {
        nope: true,
      },
      queueName: 'default',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 100,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
    })
    await expect(driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-2',
    })).rejects.toThrow('failed to reserve job: BullMQ returned a malformed payload for job "bad-payload".')

    state.queues.set('default', {
      jobs: [{
        key: 'missing-id',
        id: undefined,
        name: 'broken',
        data: {
          id: 'missing-id',
          name: 'broken',
          connection: 'redis',
          queue: 'default',
          payload: {
            ok: false,
          },
          attempts: 0,
          maxAttempts: 1,
          createdAt: 100,
        },
        queueName: 'default',
        state: 'waiting',
        attempts: 1,
        attemptsStarted: 0,
        attemptsMade: 0,
        timestamp: 100,
        removeOnComplete: true,
        removeOnFail: true,
        discarded: false,
      }],
    })
    await expect(driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-3',
    })).rejects.toThrow('failed to reserve job: BullMQ returned a reserved job without an id.')

    const readyDriver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'ready',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: 'redis.internal',
        port: 6380,
        db: 3,
      },
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))
    ensureWorkerRecord(state, 'ready').waitUntilReadyError = new Error('not ready')
    await expect(readyDriver.reserve({
      queueNames: ['ready'],
      workerId: 'worker-4',
    })).rejects.toThrow('failed to reserve job: not ready')

    state.queues.set('fallback-id', {
      jobs: [],
      forceUndefinedAddId: true,
    })
    await expect(driver.dispatch({
      id: 'job-fallback-id',
      name: 'broken',
      connection: 'redis',
      queue: 'fallback-id',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: 100,
    })).resolves.toEqual({
      jobId: 'job-fallback-id',
      synchronous: false,
    })
  })

  it('normalizes acknowledge, release, delete, clear, and close failures', async () => {
    const { queue, state } = await loadRedisQueueModule()
    const driver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 0,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))

    const queueRecord = ensureQueueRecord(state, 'default')
    queueRecord.jobs.push({
      key: 'ack-fail',
      id: 'ack-fail',
      name: 'broken',
      data: {
        id: 'ack-fail',
        name: 'broken',
        connection: 'redis',
        queue: 'default',
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 100,
      },
      queueName: 'default',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 100,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
      moveToCompletedError: new Error('complete failed'),
    })

    const ackReserved = await driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-1',
    })
    await expect(driver.acknowledge(ackReserved!)).rejects.toThrow('failed to acknowledge job: complete failed')

    queueRecord.jobs.push({
      key: 'release-fail',
      id: 'release-fail',
      name: 'broken',
      data: {
        id: 'release-fail',
        name: 'broken',
        connection: 'redis',
        queue: 'default',
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 100,
      },
      queueName: 'default',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 100,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
      moveToWaitError: new Error('release failed'),
    })
    const releaseReserved = await driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-2',
    })
    await expect(driver.release(releaseReserved!)).rejects.toThrow('failed to release job: release failed')

    queueRecord.jobs.push({
      key: 'delete-fail',
      id: 'delete-fail',
      name: 'broken',
      data: {
        id: 'delete-fail',
        name: 'broken',
        connection: 'redis',
        queue: 'default',
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 100,
      },
      queueName: 'default',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 100,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
      moveToFailedError: new Error('delete failed'),
    })
    const deleteReserved = await driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-3',
    })
    await expect(driver.delete(deleteReserved!)).rejects.toThrow('failed to delete job: delete failed')

    queueRecord.countError = new Error('count failed')
    await expect(driver.clear({
      queueNames: ['default'],
    })).rejects.toThrow('failed to clear queued jobs: count failed')

    queueRecord.countError = undefined
    queueRecord.closeError = new Error('queue close failed')
    await expect(driver.close()).rejects.toThrow('failed to close driver: queue close failed')
  })

  it('covers blocking reserve, queue rotation, missing reservations, and queue fallbacks', async () => {
    const { queue, state } = await loadRedisQueueModule()
    const driver = requireAsyncDriver(queue.redisQueueDriverFactory.create({
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
    }, queue.queueRuntimeInternals.createQueueDriverFactoryContext()))

    ensureQueueRecord(state, 'first').jobs.push({
      key: 'first-job',
      id: 'first-job',
      name: 'rotated',
      data: {
        id: 'first-job',
        name: 'rotated',
        connection: 'redis',
        queue: 'first',
        payload: {
          source: 'first',
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 100,
      },
      queueName: 'first',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 100,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
    })
    ensureQueueRecord(state, 'second').jobs.push({
      key: 'second-job',
      id: 'second-job',
      name: 'rotated',
      data: {
        id: 'second-job',
        name: 'rotated',
        connection: 'redis',
        queue: 'second',
        payload: {
          source: 'second',
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 110,
      },
      queueName: 'second',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 110,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
    })

    const firstReserved = await driver.reserve({
      queueNames: ['first', 'second'],
      workerId: 'worker-rotate-1',
    })
    expect(firstReserved?.envelope.queue).toBe('first')
    await driver.acknowledge(firstReserved!)

    const secondReserved = await driver.reserve({
      queueNames: ['first', 'second'],
      workerId: 'worker-rotate-2',
    })
    expect(secondReserved?.envelope.queue).toBe('second')
    await driver.acknowledge(secondReserved!)

    ensureQueueRecord(state, 'default').jobs.push({
      key: 'fallback-job',
      id: 'fallback-job',
      name: 'fallback',
      data: {
        id: 'fallback-job',
        name: 'fallback',
        connection: 'redis',
        queue: '',
        payload: {
          ok: true,
        },
        attempts: 0,
        maxAttempts: 1,
        availableAt: 123,
        createdAt: 200,
      },
      queueName: 'default',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 200,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
    })
    const fallbackReserved = await driver.reserve({
      queueNames: ['default'],
      workerId: 'worker-fallback',
    })
    expect(fallbackReserved?.envelope).toMatchObject({
      queue: 'default',
      availableAt: 123,
    })
    await driver.acknowledge(fallbackReserved!)

    const blockingWorker = ensureWorkerRecord(state, 'blocking')
    ensureQueueRecord(state, 'blocking').jobs.push({
      key: 'blocking-job',
      id: 'blocking-job',
      name: 'blocking',
      data: {
        id: 'blocking-job',
        name: 'blocking',
        connection: 'redis',
        queue: 'blocking',
        payload: {
          blocked: true,
        },
        attempts: 0,
        maxAttempts: 1,
        createdAt: 300,
      },
      queueName: 'blocking',
      state: 'waiting',
      attempts: 1,
      attemptsStarted: 0,
      attemptsMade: 0,
      timestamp: 300,
      removeOnComplete: true,
      removeOnFail: true,
      discarded: false,
    })
    blockingWorker.getNextJobImpl = ({ block, queue: queueRecord }) => {
      if (!block) {
        return null
      }

      return queueRecord.jobs.find(job => job.state === 'waiting') ?? null
    }

    const blockedReserved = await driver.reserve({
      queueNames: ['blocking'],
      workerId: 'worker-blocking',
    })
    expect(blockedReserved?.envelope.id).toBe('blocking-job')
    expect(blockingWorker.getNextJobCalls).toEqual([
      {
        token: expect.stringContaining('worker-blocking:'),
        block: false,
      },
      {
        token: expect.stringContaining('worker-blocking:'),
        block: true,
      },
    ])
    await driver.acknowledge(blockedReserved!)

    const emptyBlockingWorker = ensureWorkerRecord(state, 'empty-blocking')
    emptyBlockingWorker.getNextJobImpl = () => null
    await expect(driver.reserve({
      queueNames: ['empty-blocking'],
      workerId: 'worker-empty-blocking',
    })).resolves.toBeNull()
    expect(emptyBlockingWorker.getNextJobCalls).toEqual([
      {
        token: expect.stringContaining('worker-empty-blocking:'),
        block: false,
      },
      {
        token: expect.stringContaining('worker-empty-blocking:'),
        block: true,
      },
    ])

    const missingReservation = {
      reservationId: 'missing',
      reservedAt: 0,
      envelope: {
        id: 'missing',
        name: 'broken',
        connection: 'redis',
        queue: 'default',
        payload: null,
        attempts: 0,
        maxAttempts: 1,
        createdAt: 0,
      },
    }

    await expect(driver.acknowledge(missingReservation)).rejects.toThrow('Queue reservation "missing" is not active.')
    await expect(driver.release(missingReservation)).rejects.toThrow('Queue reservation "missing" is not active.')
    await expect(driver.delete(missingReservation)).rejects.toThrow('Queue reservation "missing" is not active.')
    await expect(driver.clear({
      queueNames: [],
    })).resolves.toBe(0)
  })

  it('exposes BullMQ mapping helpers for internal consumers', async () => {
    const { queue } = await loadRedisQueueModule()
    expect(queue.redisQueueDriverInternals.resolveBullConnectionOptions({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: ' redis.internal '.trim(),
        port: 6380,
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    })).toEqual({
      host: 'redis.internal',
      port: 6380,
      username: 'worker',
      password: 'secret',
      db: 4,
      maxRetriesPerRequest: null,
    })
    expect(queue.redisQueueDriverInternals.resolveBullConnectionOptions({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '/tmp/redis.sock',
        port: 6380,
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    })).toEqual({
      path: '/tmp/redis.sock',
      username: 'worker',
      password: 'secret',
      db: 4,
      maxRetriesPerRequest: null,
    })
    expect(queue.redisQueueDriverInternals.normalizeRedisErrorMessage('plain failure')).toBe('plain failure')
    expect(queue.redisQueueDriverInternals.isQueueEnvelope({
      id: 'job-1',
      name: 'emails.send',
      connection: 'redis',
      queue: 'default',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: 100,
    })).toBe(true)
    expect(queue.redisQueueDriverInternals.isQueueEnvelope({
      id: 'job-1',
      payload: {
        ok: true,
      },
    })).toBe(false)
    expect(queue.redisQueueDriverInternals.isQueueEnvelope({
      id: 'job-1',
      name: 'emails.send',
      connection: 'redis',
      queue: 'default',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 1,
      availableAt: 200,
      createdAt: 100,
    })).toBe(true)
    expect(queue.redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: 3,
      attemptsMade: 1,
    })).toBe(2)
    expect(queue.redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: Number.NaN,
      attemptsMade: 4,
    })).toBe(4)
    expect(queue.redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: 2.5,
      attemptsMade: 1.5,
    })).toBe(0)
    expect(queue.redisQueueDriverInternals.wrapRedisError('redis', 'reserve job', new Error('boom'))).toBeInstanceOf(queue.RedisQueueDriverError)
    const existing = new queue.RedisQueueDriverError('redis', 'reserve job', new Error('already wrapped'))
    expect(queue.redisQueueDriverInternals.wrapRedisError('redis', 'reserve job', existing)).toBe(existing)
  })

  it('loads the redis driver package through the dynamic loader', async () => {
    const { queue } = await loadRedisQueueModule()
    const redisModule = await queue.redisQueueDriverInternals.loadRedisDriverModule()

    expect(redisModule).toMatchObject({
      redisQueueDriverFactory: {
        driver: 'redis',
        create: expect.any(Function),
      },
    })
  })
})
