import { randomUUID } from 'node:crypto'
import {
  Queue as BullQueue,
  Worker as BullWorker,
  type ConnectionOptions,
  type Job,
} from 'bullmq'

export type QueueJsonValue
  = null
  | string
  | number
  | boolean
  | readonly QueueJsonValue[]
  | { readonly [key: string]: QueueJsonValue }

export interface QueueJobEnvelope<TPayload extends QueueJsonValue = QueueJsonValue> {
  readonly id: string
  readonly name: string
  readonly connection: string
  readonly queue: string
  readonly payload: TPayload
  readonly attempts: number
  readonly maxAttempts: number
  readonly createdAt: number
  readonly availableAt?: number
}

export interface QueueDriverDispatchResult<TResult = unknown> {
  readonly jobId: string
  readonly synchronous: boolean
  readonly result?: TResult
}

export interface QueueReservedJob<TPayload extends QueueJsonValue = QueueJsonValue> {
  readonly reservationId: string
  readonly reservedAt: number
  readonly envelope: QueueJobEnvelope<TPayload>
}

export interface QueueReleaseOptions {
  readonly delaySeconds?: number
}

export interface QueueDriverFactoryContext {
  execute<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(job: QueueJobEnvelope<TPayload>): Promise<TResult>
}

export interface QueueAsyncDriver {
  readonly name: string
  readonly driver: 'redis'
  readonly mode: 'async'
  dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
    job: QueueJobEnvelope<TPayload>,
  ): Promise<QueueDriverDispatchResult<TResult>>
  reserve<TPayload extends QueueJsonValue = QueueJsonValue>(input: {
    readonly queueNames?: readonly string[]
    readonly workerId?: string
    readonly timeout?: number
  }): Promise<QueueReservedJob<TPayload> | null>
  acknowledge(job: QueueReservedJob): Promise<void>
  release(job: QueueReservedJob, options?: QueueReleaseOptions): Promise<void>
  delete(job: QueueReservedJob): Promise<void>
  clear(input?: { readonly queueNames?: readonly string[] }): Promise<number>
  close(): Promise<void>
}

export interface NormalizedQueueRedisConnectionConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly queue: string
  readonly retryAfter: number
  readonly blockFor: number
  readonly redis: {
    readonly host: string
    readonly port: number
    readonly password?: string
    readonly username?: string
    readonly db: number
  }
}

export interface QueueDriverFactory<TConfig extends NormalizedQueueRedisConnectionConfig = NormalizedQueueRedisConnectionConfig> {
  readonly driver: TConfig['driver']
  create(connection: TConfig, context: QueueDriverFactoryContext): QueueAsyncDriver
}

type RedisQueuedEnvelope = QueueJobEnvelope<QueueJsonValue>
type BullQueueInstance = BullQueue<RedisQueuedEnvelope, unknown, string>
type BullWorkerInstance = BullWorker<RedisQueuedEnvelope, unknown, string>
type BullJobInstance = Job<RedisQueuedEnvelope, unknown, string>

type RedisReservation = {
  readonly job: BullJobInstance
  readonly token: string
}

function normalizeRedisErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isQueueEnvelope(value: unknown): value is QueueJobEnvelope<QueueJsonValue> {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.connection === 'string'
    && typeof value.queue === 'string'
    && 'payload' in value
    && typeof value.attempts === 'number'
    && Number.isInteger(value.attempts)
    && value.attempts >= 0
    && typeof value.maxAttempts === 'number'
    && Number.isInteger(value.maxAttempts)
    && value.maxAttempts >= 1
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && (typeof value.availableAt === 'undefined' || (typeof value.availableAt === 'number' && Number.isFinite(value.availableAt)))
}

function resolveBullConnectionOptions(
  connection: NormalizedQueueRedisConnectionConfig,
): ConnectionOptions {
  return {
    host: connection.redis.host,
    port: connection.redis.port,
    username: connection.redis.username,
    password: connection.redis.password,
    db: connection.redis.db,
    maxRetriesPerRequest: null,
  }
}

export class RedisQueueDriverError extends Error {
  constructor(
    connectionName: string,
    action: string,
    cause: unknown,
  ) {
    super(
      `[Holo Queue] Redis queue connection "${connectionName}" failed to ${action}: ${normalizeRedisErrorMessage(cause)}`,
      { cause },
    )
    this.name = 'RedisQueueDriverError'
  }
}

function wrapRedisError(
  connectionName: string,
  action: string,
  error: unknown,
): RedisQueueDriverError {
  if (error instanceof RedisQueueDriverError) {
    return error
  }

  return new RedisQueueDriverError(connectionName, action, error)
}

function resolveAttempts(job: BullJobInstance): number {
  const attemptsStarted = typeof job.attemptsStarted === 'number' && Number.isInteger(job.attemptsStarted)
    ? job.attemptsStarted
    : 0
  const attemptsMade = typeof job.attemptsMade === 'number' && Number.isInteger(job.attemptsMade)
    ? job.attemptsMade
    : 0
  return Math.max(
    attemptsStarted > 0 ? attemptsStarted - 1 : 0,
    attemptsMade,
    0,
  )
}

export class RedisQueueDriver implements QueueAsyncDriver {
  readonly name: string
  readonly driver = 'redis' as const
  readonly mode = 'async' as const

  private readonly connection: NormalizedQueueRedisConnectionConfig
  private readonly bullConnection: ConnectionOptions
  private readonly queues = new Map<string, BullQueueInstance>()
  private readonly workers = new Map<string, BullWorkerInstance>()
  private readonly reservations = new Map<string, RedisReservation>()
  private queueCursor = 0

  constructor(
    connection: NormalizedQueueRedisConnectionConfig,
    private readonly context: QueueDriverFactoryContext,
  ) {
    this.name = connection.name
    this.connection = connection
    this.bullConnection = resolveBullConnectionOptions(connection)
  }

  private getQueue(queueName: string): BullQueueInstance {
    const cached = this.queues.get(queueName)
    if (cached) {
      return cached
    }

    const queue = new BullQueue<RedisQueuedEnvelope, unknown, string>(queueName, {
      connection: this.bullConnection,
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
      },
    })

    this.queues.set(queueName, queue)
    return queue
  }

  private async getWorker(queueName: string): Promise<BullWorkerInstance> {
    const cached = this.workers.get(queueName)
    if (cached) {
      return cached
    }

    const worker = new BullWorker<RedisQueuedEnvelope, unknown, string>(
      queueName,
      null,
      {
        autorun: false,
        concurrency: 1,
        connection: this.bullConnection,
        drainDelay: this.connection.blockFor,
        lockDuration: this.connection.retryAfter * 1000,
        removeOnComplete: { count: 0 },
        removeOnFail: { count: 0 },
      },
    )

    await worker.waitUntilReady()
    this.workers.set(queueName, worker)
    return worker
  }

  private normalizeQueueNames(queueNames: readonly string[] | undefined): readonly string[] {
    if (!queueNames || queueNames.length === 0) {
      return [...new Set([
        this.connection.queue,
        ...this.queues.keys(),
        ...this.workers.keys(),
      ])]
    }

    return [...new Set(queueNames)]
  }

  private rotateQueueNames(queueNames: readonly string[]): readonly string[] {
    if (queueNames.length <= 1) {
      return queueNames
    }

    const offset = this.queueCursor % queueNames.length
    this.queueCursor = (this.queueCursor + 1) % queueNames.length
    return Object.freeze([
      ...queueNames.slice(offset),
      ...queueNames.slice(0, offset),
    ])
  }

  private createReservedJob(
    job: BullJobInstance,
    token: string,
    queueName: string,
  ): QueueReservedJob<QueueJsonValue> {
    if (!job.id) {
      throw new Error('BullMQ returned a reserved job without an id.')
    }

    if (!isQueueEnvelope(job.data)) {
      throw new Error(`BullMQ returned a malformed payload for job "${job.id}".`)
    }

    const attempts = resolveAttempts(job)
    const envelope: QueueJobEnvelope<QueueJsonValue> = Object.freeze({
      id: job.id,
      name: job.data.name,
      connection: job.data.connection,
      queue: job.data.queue || queueName,
      payload: job.data.payload,
      attempts,
      maxAttempts: job.data.maxAttempts,
      ...(typeof job.data.availableAt === 'number' ? { availableAt: job.data.availableAt } : {}),
      createdAt: job.data.createdAt,
    })

    this.reservations.set(token, {
      job,
      token,
    })

    return {
      reservationId: token,
      envelope,
      reservedAt: Date.now(),
    }
  }

  private getReservation(reserved: QueueReservedJob): RedisReservation {
    const reservation = this.reservations.get(reserved.reservationId)
    if (!reservation) {
      throw new Error(`Queue reservation "${reserved.reservationId}" is not active.`)
    }

    return reservation
  }

  private async settleReservation(
    reserved: QueueReservedJob,
    action: string,
    callback: (reservation: RedisReservation) => Promise<void>,
  ): Promise<void> {
    const reservation = this.getReservation(reserved)

    try {
      await callback(reservation)
    } catch (error) {
      throw wrapRedisError(this.name, action, error)
    } finally {
      this.reservations.delete(reserved.reservationId)
    }
  }

  async dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
    job: QueueJobEnvelope<TPayload>,
  ): Promise<QueueDriverDispatchResult<TResult>> {
    try {
      const delay = typeof job.availableAt === 'number'
        ? Math.max(job.availableAt - Date.now(), 0)
        : undefined

      const queued = await this.getQueue(job.queue).add(job.name, job as RedisQueuedEnvelope, {
        attempts: job.maxAttempts,
        ...(typeof delay === 'number' ? { delay } : {}),
        jobId: job.id,
        removeOnComplete: true,
        removeOnFail: true,
        timestamp: job.createdAt,
      })

      return {
        jobId: queued.id ?? job.id,
        synchronous: false,
      }
    } catch (error) {
      throw wrapRedisError(this.name, 'enqueue job', error)
    }
  }

  async reserve<TPayload extends QueueJsonValue = QueueJsonValue>(
    input: { readonly queueNames: readonly string[], readonly workerId: string },
  ): Promise<QueueReservedJob<TPayload> | null> {
    try {
      const queueNames = this.rotateQueueNames(this.normalizeQueueNames(input.queueNames))

      for (const queueName of queueNames) {
        const token = `${input.workerId}:${randomUUID()}`
        const worker = await this.getWorker(queueName)
        const job = await worker.getNextJob(token, { block: false })
        if (job) {
          return this.createReservedJob(job, token, queueName) as QueueReservedJob<TPayload>
        }
      }

      const [blockingQueue] = queueNames
      if (!blockingQueue || this.connection.blockFor <= 0) {
        return null
      }

      const token = `${input.workerId}:${randomUUID()}`
      const worker = await this.getWorker(blockingQueue)
      const job = await worker.getNextJob(token, { block: true })
      if (!job) {
        return null
      }

      return this.createReservedJob(job, token, blockingQueue) as QueueReservedJob<TPayload>
    } catch (error) {
      throw wrapRedisError(this.name, 'reserve job', error)
    }
  }

  async acknowledge(job: QueueReservedJob): Promise<void> {
    await this.settleReservation(job, 'acknowledge job', async (reservation) => {
      await reservation.job.moveToCompleted(null, reservation.token, false)
    })
  }

  async release(job: QueueReservedJob, options?: QueueReleaseOptions): Promise<void> {
    await this.settleReservation(job, 'release job', async (reservation) => {
      if (typeof options?.delaySeconds === 'number' && options.delaySeconds > 0) {
        await reservation.job.moveToDelayed(Date.now() + (options.delaySeconds * 1000), reservation.token)
        return
      }

      await reservation.job.moveToWait(reservation.token)
    })
  }

  async delete(job: QueueReservedJob): Promise<void> {
    await this.settleReservation(job, 'delete job', async (reservation) => {
      reservation.job.discard()
      await reservation.job.moveToFailed(new Error('[Holo Queue] Job deleted.'), reservation.token, false)
    })
  }

  async clear(input?: { readonly queueNames?: readonly string[] }): Promise<number> {
    try {
      const queueNames = this.normalizeQueueNames(input?.queueNames)
      let cleared = 0

      for (const queueName of queueNames) {
        const queue = this.getQueue(queueName)
        cleared += await queue.getJobCountByTypes('wait', 'waiting', 'paused', 'prioritized', 'delayed')
        await queue.drain(true)
      }

      return cleared
    } catch (error) {
      throw wrapRedisError(this.name, 'clear queued jobs', error)
    }
  }

  async close(): Promise<void> {
    const resources = [
      ...this.workers.values(),
      ...this.queues.values(),
    ]

    this.reservations.clear()
    this.workers.clear()
    this.queues.clear()

    const results = await Promise.allSettled(resources.map(async (resource) => {
      if (resource instanceof BullWorker) {
        await resource.close(true)
        return
      }

      await resource.close()
    }))

    const rejection = results.find(result => result.status === 'rejected')
    if (rejection) {
      throw wrapRedisError(this.name, 'close driver', rejection.reason)
    }
  }
}

export const redisQueueDriverFactory: QueueDriverFactory<NormalizedQueueRedisConnectionConfig> = {
  driver: 'redis',
  create(connection, context) {
    return new RedisQueueDriver(connection, context)
  },
}

export const redisQueueDriverInternals = {
  isQueueEnvelope,
  normalizeRedisErrorMessage,
  resolveAttempts,
  resolveBullConnectionOptions,
  wrapRedisError,
}
