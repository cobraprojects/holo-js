import type {
  NormalizedQueueRedisConnectionConfig,
  QueueAsyncDriver,
  QueueDriverDispatchResult,
  QueueDriverFactory,
  QueueDriverFactoryContext,
  QueueJobEnvelope,
  QueueJsonValue,
  QueueReleaseOptions,
  QueueReservedJob,
} from '../contracts'

type RedisDriverModule = {
  redisQueueDriverFactory: QueueDriverFactory<NormalizedQueueRedisConnectionConfig>
}

type RedisQueuedEnvelope = QueueJobEnvelope<QueueJsonValue>

/* v8 ignore next 6 -- exercised only when the optional peer is absent outside the monorepo test graph */
function isModuleNotFoundError(error: unknown): boolean {
  return !!error
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
}

/* v8 ignore next 14 -- optional-peer absence is validated in published-package integration, not in this monorepo test graph */
async function loadRedisDriverModule(): Promise<RedisDriverModule> {
  try {
    const specifier = '@holo-js/queue-redis' as string
    return await import(specifier) as RedisDriverModule
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new Error('[@holo-js/queue] Redis queue support requires @holo-js/queue-redis to be installed.', {
        cause: error,
      })
    }

    throw error
  }
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

function isQueueEnvelope(value: unknown): value is RedisQueuedEnvelope {
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

type RedisConnectionOptions = {
  url?: string
  clusters?: readonly {
    readonly url?: string
    readonly host: string
    readonly port: number
  }[]
  host?: string
  port?: number
  path?: string
  username?: string
  password?: string
  db: number
  maxRetriesPerRequest: null
}

function isRedisSocketConnectionTarget(value: string): boolean {
  return value.startsWith('unix://') || value.startsWith('/')
}

function toRedisSocketPath(value: string): string {
  return value.startsWith('unix://')
    ? value.slice('unix://'.length)
    : value
}

function resolveBullConnectionOptions(
  connection: NormalizedQueueRedisConnectionConfig,
): RedisConnectionOptions {
  const redisHost = connection.redis.host

  return {
    ...(typeof connection.redis.url === 'string'
      ? { url: connection.redis.url }
      : connection.redis.clusters && connection.redis.clusters.length > 0
        ? { clusters: connection.redis.clusters }
        : typeof redisHost === 'string' && isRedisSocketConnectionTarget(redisHost)
          ? { path: toRedisSocketPath(redisHost) }
      : {
          host: redisHost,
          port: connection.redis.port,
        }),
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

function resolveAttempts(job: { attemptsStarted?: number, attemptsMade?: number }): number {
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

  private driverInstance?: QueueAsyncDriver
  private pending?: Promise<QueueAsyncDriver>

  constructor(
    private readonly connection: NormalizedQueueRedisConnectionConfig,
    private readonly context: QueueDriverFactoryContext,
  ) {
    this.name = connection.name
  }

  private async resolveDriver(): Promise<QueueAsyncDriver> {
    if (this.driverInstance) {
      return this.driverInstance
    }

    this.pending ??= loadRedisDriverModule().then((module) => {
      const driver = module.redisQueueDriverFactory.create(this.connection, this.context)
      if (driver.mode !== 'async') {
        throw new Error('[Holo Queue] Redis queue driver must be async.')
      }

      this.driverInstance = driver
      return driver
    }).finally(() => {
      this.pending = undefined
    })

    return this.pending
  }

  async dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
    job: QueueJobEnvelope<TPayload>,
  ): Promise<QueueDriverDispatchResult<TResult>> {
    return (await this.resolveDriver()).dispatch<TPayload, TResult>(job)
  }

  async reserve<TPayload extends QueueJsonValue = QueueJsonValue>(
    input: Parameters<QueueAsyncDriver['reserve']>[0],
  ): Promise<QueueReservedJob<TPayload> | null> {
    return (await this.resolveDriver()).reserve<TPayload>(input)
  }

  async acknowledge(job: QueueReservedJob): Promise<void> {
    await (await this.resolveDriver()).acknowledge(job)
  }

  async release(job: QueueReservedJob, options?: QueueReleaseOptions): Promise<void> {
    await (await this.resolveDriver()).release(job, options)
  }

  async delete(job: QueueReservedJob): Promise<void> {
    await (await this.resolveDriver()).delete(job)
  }

  async clear(input?: Parameters<QueueAsyncDriver['clear']>[0]): Promise<number> {
    return (await this.resolveDriver()).clear(input)
  }

  async close(): Promise<void> {
    if (!this.driverInstance && !this.pending) {
      return
    }

    await (await this.resolveDriver()).close()
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
  loadRedisDriverModule,
  normalizeRedisErrorMessage,
  resolveAttempts,
  resolveBullConnectionOptions,
  toRedisSocketPath,
  wrapRedisError,
}
