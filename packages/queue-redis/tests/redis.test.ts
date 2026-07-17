import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runSharedQueueDriverContract } from '../../queue/tests/support/shared-driver-contract'

const bullMqMock = vi.hoisted(() => {
  type FakeJobState = 'waiting' | 'active' | 'completed' | 'delayed' | 'failed'

  type FakeJobEntry = {
    id: string
    name: string
    data: unknown
    state: FakeJobState
    attemptsStarted: number
    attemptsMade: number
    timestamp: number
    token?: string
    discarded: boolean
    moveToCompletedFailures: unknown[]
    moveToWaitFailures: unknown[]
    moveToDelayedFailures: unknown[]
    moveToFailedFailures: unknown[]
  }

  type ReadyController = {
    readonly promise: Promise<void>
    readonly resolve: () => void
  }

  const jobsByQueue = new Map<string, FakeJobEntry[]>()
  const readyControllers: ReadyController[] = []
  const workerInstances: FakeWorker[] = []

  function getQueueJobs(queueName: string): FakeJobEntry[] {
    let jobs = jobsByQueue.get(queueName)
    if (!jobs) {
      jobs = []
      jobsByQueue.set(queueName, jobs)
    }

    return jobs
  }

  function createReadyController(): ReadyController {
    let resolveController: (() => void) | undefined
    const promise = new Promise<void>((resolve) => {
      resolveController = resolve
    })

    return {
      promise,
      resolve() {
        resolveController?.()
      },
    }
  }

  class FakeJob {
    constructor(private readonly entry: FakeJobEntry) {}

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

    get timestamp() {
      return this.entry.timestamp
    }

    get opts() {
      return {
        attempts: 1,
      }
    }

    discard(): void {
      this.entry.discarded = true
    }

    async moveToCompleted(_result: unknown, token: string): Promise<void> {
      const failure = this.entry.moveToCompletedFailures.shift()
      if (failure) {
        throw failure
      }

      if (this.entry.token !== token) {
        throw new Error('Token mismatch while completing job.')
      }

      this.entry.token = undefined
      this.entry.state = 'completed'
    }

    async moveToWait(token: string): Promise<void> {
      const failure = this.entry.moveToWaitFailures.shift()
      if (failure) {
        throw failure
      }

      if (this.entry.token !== token) {
        throw new Error('Token mismatch while releasing job.')
      }

      this.entry.token = undefined
      this.entry.state = 'waiting'
    }

    async moveToDelayed(_timestamp: number, token?: string): Promise<void> {
      const failure = this.entry.moveToDelayedFailures.shift()
      if (failure) {
        throw failure
      }

      if (this.entry.token !== token) {
        throw new Error('Token mismatch while delaying job.')
      }

      this.entry.token = undefined
      this.entry.state = 'delayed'
    }

    async moveToFailed(_error: Error, token: string): Promise<void> {
      const failure = this.entry.moveToFailedFailures.shift()
      if (failure) {
        throw failure
      }

      if (this.entry.token !== token) {
        throw new Error('Token mismatch while failing job.')
      }

      this.entry.token = undefined
      this.entry.state = 'failed'
    }
  }

  class FakeQueue {
    constructor(private readonly queueName: string) {}

    async add(name: string, data: unknown, options?: { jobId?: string; timestamp?: number }): Promise<{ id?: string }> {
      const id = options?.jobId ?? `${this.queueName}-${getQueueJobs(this.queueName).length + 1}`
      getQueueJobs(this.queueName).push({
        id,
        name,
        data,
        state: 'waiting',
        attemptsStarted: 0,
        attemptsMade: 0,
        timestamp: options?.timestamp ?? Date.now(),
        discarded: false,
        moveToCompletedFailures: [],
        moveToWaitFailures: [],
        moveToDelayedFailures: [],
        moveToFailedFailures: [],
      })

      return { id }
    }

    async getJobCountByTypes(): Promise<number> {
      return getQueueJobs(this.queueName).filter(entry => entry.state === 'waiting' || entry.state === 'delayed').length
    }

    async drain(): Promise<void> {
      jobsByQueue.set(this.queueName, getQueueJobs(this.queueName).filter(entry => entry.state !== 'waiting' && entry.state !== 'delayed'))
    }

    async close(): Promise<void> {}
  }

  class FakeWorker {
    readonly queueName: string
    readonly closeCalls: boolean[] = []
    readonly getNextJobCalls: Array<{
      readonly token: string
      readonly block: boolean
    }> = []
    readonly options?: {
      readonly drainDelay?: number
    }

    constructor(queueName: string, _processor?: unknown, options?: { readonly drainDelay?: number }) {
      this.queueName = queueName
      this.options = options
      workerInstances.push(this)
    }

    waitUntilReady(): Promise<void> {
      const controller = createReadyController()
      readyControllers.push(controller)
      return controller.promise
    }

    async getNextJob(token: string, options?: { block?: boolean }): Promise<FakeJob | null> {
      this.getNextJobCalls.push({
        token,
        block: options?.block === true,
      })
      const job = getQueueJobs(this.queueName).find(entry => entry.state === 'waiting')
      if (!job) {
        return null
      }

      job.state = 'active'
      job.token = token
      job.attemptsStarted += 1
      return new FakeJob(job)
    }

    async close(force?: boolean): Promise<void> {
      this.closeCalls.push(force ?? false)
    }
  }

  return {
    jobsByQueue,
    Queue: FakeQueue,
    Worker: FakeWorker,
    readyControllers,
    workerInstances,
  }
})

vi.mock('bullmq', () => ({
  Queue: bullMqMock.Queue,
  Worker: bullMqMock.Worker,
}))

vi.mock('ioredis', () => {
  class FakeRedis {
    static constructorArgs: unknown[][] = []

    constructor(...args: unknown[]) {
      FakeRedis.constructorArgs.push(args)
    }

    static Cluster = class FakeRedisCluster {
      constructor(
        public readonly startupNodes: readonly unknown[],
        public readonly options?: unknown,
      ) {}
    }
  }

  return {
    default: FakeRedis,
  }
})

describe('@holo-js/queue-redis', () => {
  beforeEach(() => {
    bullMqMock.jobsByQueue.clear()
    bullMqMock.readyControllers.length = 0
    bullMqMock.workerInstances.length = 0
  })

  it('shares and closes a worker created by concurrent delayed reservations', async () => {
    const { redisQueueDriverFactory } = await import('../src')
    const driver = redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'emails',
      retryAfter: 90,
      blockFor: 0,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }, {
      async execute() {
        throw new Error('The Redis queue test reserves jobs without executing them.')
      },
    })

    const firstReservation = driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-a',
    })
    const secondReservation = driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-b',
    })

    expect(bullMqMock.workerInstances).toHaveLength(1)
    expect(bullMqMock.readyControllers).toHaveLength(1)

    const closePromise = driver.close()
    expect(bullMqMock.workerInstances[0]?.closeCalls).toEqual([true])

    bullMqMock.readyControllers[0]?.resolve()

    await expect(firstReservation).resolves.toBeNull()
    await expect(secondReservation).resolves.toBeNull()
    await expect(closePromise).resolves.toBeUndefined()
    expect(bullMqMock.workerInstances).toHaveLength(1)
    expect(bullMqMock.workerInstances[0]?.closeCalls).toEqual([true])
  })

  it('accepts the exported reserve input shape with default queue, default worker id, and timeout override', async () => {
    const { redisQueueDriverFactory } = await import('../src')
    const driver = redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'emails',
      retryAfter: 90,
      blockFor: 10,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }, {
      async execute() {
        throw new Error('The Redis queue test reserves jobs without executing them.')
      },
    })

    await driver.dispatch({
      id: 'job-default-reserve',
      name: 'emails.send',
      connection: 'redis',
      queue: 'emails',
      payload: {
        ok: true,
      },
      attempts: 0,
      maxAttempts: 1,
      createdAt: 100,
    })

    const defaultReservation = driver.reserve({
      timeout: 0,
    })
    bullMqMock.readyControllers[0]?.resolve()

    const reserved = await defaultReservation
    expect(reserved).toMatchObject({
      reservationId: expect.stringContaining('redis:'),
      envelope: {
        id: 'job-default-reserve',
        queue: 'emails',
      },
    })
    await driver.acknowledge(reserved!)

    const timedReservation = driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-timeout',
      timeout: 2,
    })
    await Promise.resolve()
    await Promise.resolve()
    bullMqMock.readyControllers[1]?.resolve()

    await expect(timedReservation).resolves.toBeNull()
    expect(bullMqMock.workerInstances.map(worker => worker.options?.drainDelay)).toEqual([10, 2])
    expect(bullMqMock.workerInstances[1]?.getNextJobCalls).toEqual([
      {
        token: expect.stringContaining('worker-timeout:'),
        block: true,
      },
    ])

    await driver.close()
  })

  it('keeps failed settle reservations retryable until the settle succeeds', async () => {
    const { redisQueueDriverFactory } = await import('../src')
    const driver = redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'emails',
      retryAfter: 90,
      blockFor: 0,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 0,
      },
    }, {
      async execute() {
        throw new Error('The Redis queue test reserves jobs without executing them.')
      },
    })

    await driver.dispatch({
      id: 'ack-retry',
      name: 'emails.ack',
      connection: 'redis',
      queue: 'emails',
      payload: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 100,
    })
    const ackJob = bullMqMock.jobsByQueue.get('emails')?.find(job => job.id === 'ack-retry')
    if (!ackJob) {
      throw new Error('Expected ack retry job to be queued.')
    }
    ackJob.moveToCompletedFailures.push(new Error('complete failed once'))

    const ackReservation = driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-ack',
    })
    bullMqMock.readyControllers[0]?.resolve()
    const ackReserved = await ackReservation
    await expect(driver.acknowledge(ackReserved!)).rejects.toThrow('failed to acknowledge job: complete failed once')
    await expect(driver.acknowledge(ackReserved!)).resolves.toBeUndefined()
    expect(ackJob.state).toBe('completed')

    await driver.dispatch({
      id: 'release-retry',
      name: 'emails.release',
      connection: 'redis',
      queue: 'emails',
      payload: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 200,
    })
    const releaseJob = bullMqMock.jobsByQueue.get('emails')?.find(job => job.id === 'release-retry')
    if (!releaseJob) {
      throw new Error('Expected release retry job to be queued.')
    }
    releaseJob.moveToWaitFailures.push(new Error('release failed once'))

    const releaseReserved = await driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-release',
    })
    await expect(driver.release(releaseReserved!)).rejects.toThrow('failed to release job: release failed once')
    await expect(driver.release(releaseReserved!)).resolves.toBeUndefined()
    expect(releaseJob.state).toBe('waiting')
    releaseJob.state = 'completed'

    await driver.dispatch({
      id: 'delete-retry',
      name: 'emails.delete',
      connection: 'redis',
      queue: 'emails',
      payload: null,
      attempts: 0,
      maxAttempts: 1,
      createdAt: 300,
    })
    const deleteJob = bullMqMock.jobsByQueue.get('emails')?.find(job => job.id === 'delete-retry')
    if (!deleteJob) {
      throw new Error('Expected delete retry job to be queued.')
    }
    deleteJob.moveToFailedFailures.push(new Error('delete failed once'))

    const deleteReserved = await driver.reserve({
      queueNames: ['emails'],
      workerId: 'worker-delete',
    })
    await expect(driver.delete(deleteReserved!)).rejects.toThrow('failed to delete job: delete failed once')
    await expect(driver.delete(deleteReserved!)).resolves.toBeUndefined()
    expect(deleteJob.state).toBe('failed')
    expect(deleteJob.discarded).toBe(true)

    await driver.close()
  })

  it('exports the redis driver factory and helpers', async () => {
    const {
      RedisQueueDriverError,
      redisQueueDriverFactory,
      redisQueueDriverInternals,
    } = await import('../src')

    expect(redisQueueDriverFactory.driver).toBe('redis')
    expect(redisQueueDriverInternals.resolveBullConnectionOptions({
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
    })).toEqual({
      host: '127.0.0.1',
      port: 6379,
      username: undefined,
      password: undefined,
      db: 0,
      maxRetriesPerRequest: null,
    })
    expect(redisQueueDriverInternals.resolveAttempts({
      attemptsStarted: 3,
      attemptsMade: 1,
    } as never)).toBe(2)
    expect(
      redisQueueDriverInternals.wrapRedisError('redis', 'reserve job', new Error('boom')),
    ).toBeInstanceOf(RedisQueueDriverError)
  })

  it('propagates TLS options for rediss cluster nodes', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')

    const connection = redisQueueDriverInternals.resolveBullConnection({
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
        clusters: [
          {
            url: 'rediss://cache.internal:6380',
            host: 'cache.internal',
            port: 6380,
          },
        ],
      },
    }) as {
      readonly startupNodes: readonly unknown[]
      readonly options?: {
        readonly redisOptions?: {
          readonly tls?: Record<string, never>
        }
      }
    }

    expect(connection.startupNodes).toEqual([
      {
        host: 'cache.internal',
        port: 6380,
      },
    ])
    expect(connection.options).toEqual({
      redisOptions: {
        username: undefined,
        password: undefined,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        tls: {},
      },
    })
  })

  it('rejects non-zero redis db values in cluster mode', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')

    expect(() => redisQueueDriverInternals.resolveBullConnection({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        host: '127.0.0.1',
        port: 6379,
        db: 4,
        clusters: [
          {
            url: 'redis://cache.internal:6380',
            host: 'cache.internal',
            port: 6380,
          },
        ],
      },
    })).toThrow('cannot select redis.db=4 in cluster mode')
  })

  it('creates a managed ioredis client for url-based connections', async () => {
    const {
      redisQueueDriverInternals,
    } = await import('../src')
    const RedisModule = (await import('ioredis')).default as unknown as {
      constructorArgs: unknown[][]
    }

    redisQueueDriverInternals.resolveBullConnection({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 5,
      redis: {
        url: 'rediss://cache.internal:6380/4',
        host: '127.0.0.1',
        port: 6379,
        username: 'worker',
        password: 'secret',
        db: 4,
      },
    })

    expect(RedisModule.constructorArgs.at(-1)).toEqual([
      'rediss://cache.internal:6380/4',
      {
        username: 'worker',
        password: 'secret',
        db: 4,
        lazyConnect: true,
        maxRetriesPerRequest: null,
        tls: {},
      },
    ])
  })
})

runSharedQueueDriverContract({
  label: '@holo-js/queue-redis',
  expected: { name: 'redis', driver: 'redis', mode: 'async' },
  async createDriver() {
    const { redisQueueDriverFactory } = await import('../src')
    return redisQueueDriverFactory.create({
      name: 'redis',
      driver: 'redis',
      connection: 'default',
      queue: 'default',
      retryAfter: 90,
      blockFor: 0,
      redis: { host: '127.0.0.1', port: 6379, db: 0 },
    }, {
      async execute() {
        throw new Error('The shared driver contract does not execute jobs.')
      },
    })
  },
})
