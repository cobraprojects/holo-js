import { reportError } from '@holo-js/kernel/error-reporting'
import { randomUUID } from 'node:crypto'
import type {
  NormalizedQueueConnectionConfig,
  NormalizedHoloQueueConfig,
  QueueSharedRedisConfig,
  QueueConnectionFacade,
  QueueDelayValue,
  QueueDispatchCompletedHook,
  QueueDispatchFailedHook,
  QueueDispatchOptions,
  QueueDispatchResult,
  QueueDriver,
  QueueDriverFactory,
  QueueFailedJobStore,
  QueueDriverFactoryContext,
  QueueJobContext,
  QueueJobContextOverrides,
  QueueJobEnvelope,
  QueueJsonValue,
  QueuePendingDispatch,
  QueuePayloadFor,
  QueueResultFor,
  QueueRuntimeBinding,
  HoloQueueJobRegistry,
  HoloQueueConfig,
} from './contracts'
import { queueJobInternals } from './contracts'
import { DEFAULT_QUEUE_NAME, assertQueueTimeoutBelowRetryAfter } from './config'
import { normalizeQueueConfig, holoQueueDefaults } from './config'
import { syncQueueDriverFactory } from './drivers/sync'
import { getRegisteredQueueJob, listRegisteredQueueJobs, setQueueJobRegistrationTimeoutCheck } from './registry'
import { loadQueuePluginDriverFactories, resetQueuePluginDriverFactories } from './plugins'

type RuntimeQueueState = {
  config: NormalizedHoloQueueConfig
  driverFactories: Map<string, QueueDriverFactory>
  drivers: Map<string, QueueDriver>
  failedJobStore?: QueueFailedJobStore
}

type QueuePayloadValidationState = {
  readonly seen: Set<unknown>
}

type ConfigureQueueRuntimeOptions = {
  readonly config?: HoloQueueConfig | NormalizedHoloQueueConfig
  readonly redisConfig?: QueueSharedRedisConfig
  readonly driverFactories?: ReadonlyArray<QueueDriverFactory> | ReadonlyMap<string, QueueDriverFactory>
  readonly failedJobStore?: QueueFailedJobStore
}

const INLINE_SYNC_DRIVER_KEY = '__inline_sync__'

export class QueueReleaseUnsupportedError extends Error {
  constructor() {
    super('[Holo Queue] release() is not supported during synchronous queue execution.')
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertQueueJsonValue(
  value: unknown,
  path: string,
  state: QueuePayloadValidationState,
): asserts value is QueueJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }

  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError(`[Holo Queue] Queue payload at "${path}" must be JSON-serializable.`)
  }

  if (typeof value === 'number') {
    return
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`[Holo Queue] Queue payload at "${path}" must be JSON-serializable.`)
  }

  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      throw new TypeError(`[Holo Queue] Queue payload at "${path}" contains a circular reference.`)
    }

    state.seen.add(value)
    for (let index = 0; index < value.length; index += 1) {
      assertQueueJsonValue(value[index], `${path}[${index}]`, state)
    }
    state.seen.delete(value)
    return
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`[Holo Queue] Queue payload at "${path}" must be a plain JSON object, array, or primitive.`)
  }

  if (state.seen.has(value)) {
    throw new TypeError(`[Holo Queue] Queue payload at "${path}" contains a circular reference.`)
  }

  state.seen.add(value)
  for (const [key, nested] of Object.entries(value)) {
    assertQueueJsonValue(nested, `${path}.${key}`, state)
  }
  state.seen.delete(value)
}

function validateQueuePayload<TPayload>(payload: TPayload): asserts payload is TPayload & QueueJsonValue {
  assertQueueJsonValue(payload, 'payload', { seen: new Set<unknown>() })
}

function normalizeConnectionName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error('[Holo Queue] Queue connection names must be non-empty strings.')
  }

  return normalized
}

function normalizeQueueName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error('[Holo Queue] Queue names must be non-empty strings.')
  }

  return normalized
}

function isNormalizedQueueConfig(
  config: HoloQueueConfig | NormalizedHoloQueueConfig,
): config is NormalizedHoloQueueConfig {
  return typeof config.default === 'string'
    && typeof config.connections === 'object'
    && config.connections !== null
    && Object.values(config.connections).every((connection) => {
      return typeof connection === 'object'
        && connection !== null
        && 'name' in connection
        && 'driver' in connection
        && 'queue' in connection
        && typeof connection.name === 'string'
        && typeof connection.driver === 'string'
        && typeof connection.queue === 'string'
    })
}

function normalizeDispatchCompletedHook(callback: QueueDispatchCompletedHook): QueueDispatchCompletedHook {
  if (typeof callback !== 'function') {
    throw new Error('[Holo Queue] Queue dispatch onComplete hook must be a function.')
  }

  return callback
}

function normalizeDispatchFailedHook(callback: QueueDispatchFailedHook): QueueDispatchFailedHook {
  if (typeof callback !== 'function') {
    throw new Error('[Holo Queue] Queue dispatch onFailed hook must be a function.')
  }

  return callback
}

function normalizeDelay(delay: QueueDelayValue | undefined): number | undefined {
  if (typeof delay === 'undefined') {
    return undefined
  }

  if (typeof delay === 'number') {
    if (!Number.isFinite(delay) || delay < 0) {
      throw new TypeError('[Holo Queue] Queue delay must be a finite number greater than or equal to 0.')
    }

    return Date.now() + Math.floor(delay * 1000)
  }

  const timestamp = delay.getTime()
  if (Number.isNaN(timestamp)) {
    throw new TypeError('[Holo Queue] Queue delay dates must be valid Date instances.')
  }

  return timestamp
}

function createDefaultDriverFactories(): Map<string, QueueDriverFactory> {
  return new Map<string, QueueDriverFactory>([
    [syncQueueDriverFactory.driver, syncQueueDriverFactory],
  ])
}

function createQueueDriverFactoryMap(
  factories?: ReadonlyArray<QueueDriverFactory> | ReadonlyMap<string, QueueDriverFactory>,
): Map<string, QueueDriverFactory> {
  const resolved = createDefaultDriverFactories()
  if (!factories) {
    return resolved
  }

  if (!Array.isArray(factories)) {
    for (const [name, factory] of factories.entries()) {
      resolved.set(String(name), factory)
    }
    return resolved
  }

  for (const factory of factories) {
    resolved.set(factory.driver, factory)
  }
  return resolved
}

function getQueueRuntimeState(): RuntimeQueueState {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueRuntime__?: RuntimeQueueState
  }

  runtime.__holoQueueRuntime__ ??= {
    config: holoQueueDefaults,
    driverFactories: createDefaultDriverFactories(),
    drivers: new Map<string, QueueDriver>(),
    failedJobStore: undefined,
  }

  return runtime.__holoQueueRuntime__
}

function createQueueRuntimeBinding(state: RuntimeQueueState): QueueRuntimeBinding {
  return Object.freeze({
    config: state.config,
    drivers: state.drivers,
  })
}

function requireRegisteredQueueJob(jobName: string) {
  const registered = getRegisteredQueueJob(jobName)
  if (!registered) {
    throw new Error(`[Holo Queue] Queue job "${jobName}" is not registered.`)
  }

  return registered
}

function resolveConnectionConfig(
  config: NormalizedHoloQueueConfig,
  requestedConnection: string | undefined,
): NormalizedQueueConnectionConfig {
  const connectionName = requestedConnection ? normalizeConnectionName(requestedConnection) : config.default
  const connection = config.connections[connectionName]
  if (!connection) {
    throw new Error(
      `[Holo Queue] Queue connection "${connectionName}" is not configured. `
      + `Available connections: ${Object.keys(config.connections).join(', ')}`,
    )
  }

  return connection
}

function createJobContext<TPayload extends QueueJsonValue>(
  envelope: QueueJobEnvelope<TPayload>,
  overrides: QueueJobContextOverrides = {},
): QueueJobContext {
  return {
    jobId: envelope.id,
    jobName: envelope.name,
    connection: envelope.connection,
    queue: envelope.queue,
    attempt: envelope.attempts + 1,
    maxAttempts: overrides.maxAttempts ?? envelope.maxAttempts,
    async release(delaySeconds?: number) {
      if (overrides.release) {
        await overrides.release(delaySeconds)
        return
      }

      throw new QueueReleaseUnsupportedError()
    },
    async fail(error: Error) {
      if (overrides.fail) {
        await overrides.fail(error)
        return
      }

      throw error
    },
  }
}

async function executeRegisteredQueueJob<TPayload extends QueueJsonValue, TResult>(
  envelope: QueueJobEnvelope<TPayload>,
  contextOverrides: QueueJobContextOverrides = {},
): Promise<TResult> {
  const registered = requireRegisteredQueueJob(envelope.name)
  const context = createJobContext(envelope, contextOverrides)
  const result = await registered.definition.handle(
    envelope.payload,
    context,
  ) as TResult

  if (contextOverrides.shouldSkipLifecycleHooks?.()) {
    return result
  }

  await executeRegisteredQueueJobCompletedHook(envelope, result, contextOverrides)
  return result
}

async function executeRegisteredQueueJobCompletedHook<TPayload extends QueueJsonValue, TResult>(
  envelope: QueueJobEnvelope<TPayload>,
  result: TResult,
  contextOverrides: QueueJobContextOverrides = {},
): Promise<void> {
  const registered = requireRegisteredQueueJob(envelope.name)
  if (!registered.definition.onCompleted) {
    return
  }

  try {
    await registered.definition.onCompleted(
      envelope.payload,
      result,
      createJobContext(envelope, contextOverrides),
    )
  } catch (error) {
    reportError(error, { capability: 'queue', operation: 'job.onCompleted' })
  }
}

async function executeRegisteredQueueJobFailedHook<TPayload extends QueueJsonValue>(
  envelope: QueueJobEnvelope<TPayload>,
  error: Error,
  contextOverrides: QueueJobContextOverrides = {},
): Promise<void> {
  const registered = requireRegisteredQueueJob(envelope.name)
  if (!registered.definition.onFailed) {
    return
  }

  try {
    await registered.definition.onFailed(
      envelope.payload,
      error,
      createJobContext(envelope, contextOverrides),
    )
  } catch (hookError) {
    reportError(hookError, { capability: 'queue', operation: 'job.onFailed' })
  }
}

async function dispatchThroughDriver(
  driver: QueueDriver,
  envelope: QueueJobEnvelope,
): Promise<Awaited<ReturnType<QueueDriver['dispatch']>>> {
  try {
    return await driver.dispatch(envelope)
  } catch (error) {
    if (driver.mode === 'sync') {
      const resolvedError = error instanceof Error ? error : new Error(String(error))
      await executeRegisteredQueueJobFailedHook(envelope, resolvedError, {
        maxAttempts: envelope.maxAttempts,
      })
    }

    throw error
  }
}

function createQueueDriverFactoryContext(): QueueDriverFactoryContext {
  return {
    async execute<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(job: QueueJobEnvelope<TPayload>): Promise<TResult> {
      return await executeRegisteredQueueJob<TPayload, TResult>(job)
    },
  }
}

function resolveDriverFactory(
  state: RuntimeQueueState,
  connection: NormalizedQueueConnectionConfig,
): QueueDriverFactory {
  const factory = state.driverFactories.get(connection.driver)
  if (!factory) {
    throw new Error(
      `[Holo Queue] Queue connection "${connection.name}" uses driver "${connection.driver}" `
      + 'but no queue driver factory is registered.',
    )
  }

  return factory
}

async function clearCachedDriversForFactoryNames(state: RuntimeQueueState, driverNames: ReadonlySet<string>): Promise<void> {
  const staleDrivers: QueueDriver[] = []

  for (const [connectionName, driver] of state.drivers.entries()) {
    const connection = state.config.connections[connectionName]
    const driverName = connection?.driver ?? driver.driver
    if (driverNames.has(driverName)) {
      staleDrivers.push(driver)
      state.drivers.delete(connectionName)
    }
  }

  await closeQueueDrivers(staleDrivers)
}

export async function loadQueuePluginDrivers(
  projectRoot = process.cwd(),
  pluginNames: readonly string[] = [],
): Promise<void> {
  const state = getQueueRuntimeState()
  const loadedDriverNames = new Set<string>()
  for (const factory of await loadQueuePluginDriverFactories(projectRoot, pluginNames)) {
    state.driverFactories.set(factory.driver, factory)
    loadedDriverNames.add(factory.driver)
  }

  if (loadedDriverNames.size > 0) {
    await clearCachedDriversForFactoryNames(state, loadedDriverNames)
  }
}

function resolveConnectionDriver(connectionName?: string): QueueDriver {
  const state = getQueueRuntimeState()
  const connection = resolveConnectionConfig(state.config, connectionName)
  const cached = state.drivers.get(connection.name)
  if (cached) {
    return cached
  }

  const driver = resolveDriverFactory(state, connection).create(
    connection as never,
    createQueueDriverFactoryContext(),
  )
  state.drivers.set(connection.name, driver)
  return driver
}

function resolveSyncExecutionDriver(): QueueDriver {
  const state = getQueueRuntimeState()
  const cached = state.drivers.get(INLINE_SYNC_DRIVER_KEY)
  if (cached) {
    return cached
  }

  const syncConnection = normalizeQueueConfig().connections.sync!
  const driver = resolveDriverFactory(state, syncConnection).create(
    syncConnection,
    createQueueDriverFactoryContext(),
  )
  state.drivers.set(INLINE_SYNC_DRIVER_KEY, driver)
  return driver
}

function createJobEnvelope<TPayload extends QueueJsonValue>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions,
  { validateTimeout = true }: { validateTimeout?: boolean } = {},
): QueueJobEnvelope<TPayload> {
  const runtime = getQueueRuntimeState()
  const registered = requireRegisteredQueueJob(jobName)
  const connection = resolveConnectionConfig(
    runtime.config,
    options.connection ?? registered.definition.connection,
  )
  const queue = normalizeQueueName(options.queue ?? registered.definition.queue ?? connection.queue ?? DEFAULT_QUEUE_NAME)
  const tries = queueJobInternals.normalizeOptionalInteger(options.tries, 'Queue dispatch tries', { minimum: 1 })
    ?? registered.definition.tries
    ?? 1
  if (validateTimeout) {
    assertQueueTimeoutBelowRetryAfter(`Queue job "${registered.name}"`, registered.definition.timeout, connection)
  }

  return Object.freeze({
    id: randomUUID(),
    name: registered.name,
    connection: connection.name,
    queue,
    payload,
    attempts: 0,
    maxAttempts: tries,
    ...(typeof options.delay === 'undefined' ? {} : { availableAt: normalizeDelay(options.delay) }),
    createdAt: Date.now(),
  })
}

function createDispatchEnvelope<TPayload extends QueueJsonValue>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions = {},
  { runsInline = false }: { runsInline?: boolean } = {},
): QueueJobEnvelope<TPayload> {
  validateQueuePayload(payload)
  // Snapshot the payload so a deferred (afterCommit) dispatch serializes what was passed in, not later mutations.
  const snapshot = JSON.parse(JSON.stringify(payload)) as TPayload
  return createJobEnvelope(jobName, snapshot, options, { validateTimeout: !runsInline })
}

type DatabaseTransactionConnection = {
  getScope(): { kind: string }
  afterCommit(callback: () => Promise<void>): void
}

type DatabaseModule = {
  connectionAsyncContext: {
    getActive(): { connection: DatabaseTransactionConnection } | undefined
  }
}

const databaseSpecifier = '@holo-js/db'

async function loadDatabaseModule(): Promise<DatabaseModule | null> {
  try {
    return await import(databaseSpecifier) as DatabaseModule
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
    ) {
      return null
    }

    throw error
  }
}

async function resolveOpenDatabaseTransaction(): Promise<DatabaseTransactionConnection | undefined> {
  const database = await loadDatabaseModule()
  const active = database?.connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return undefined
  }

  return active
}

type DispatchOutcomeHandlers = {
  completed(result: QueueDispatchResult): Promise<void>
  failed(error: unknown): Promise<void>
}

function toDispatchResult(
  envelope: QueueJobEnvelope,
  result: { readonly jobId: string, readonly synchronous: boolean },
): QueueDispatchResult {
  return {
    jobId: result.jobId,
    connection: envelope.connection,
    queue: envelope.queue,
    synchronous: result.synchronous,
  }
}

async function dispatchRecord(
  envelope: QueueJobEnvelope,
  options: Pick<QueueDispatchOptions, 'afterCommit'>,
  handlers: DispatchOutcomeHandlers,
): Promise<QueueDispatchResult> {
  try {
    const driver = resolveConnectionDriver(envelope.connection)
    const connection = resolveConnectionConfig(getQueueRuntimeState().config, envelope.connection)
    const afterCommit = options.afterCommit ?? connection.afterCommit
    // The awaited result is returned before commit, so it can only carry the caller's job ID if the driver stores that ID.
    if (afterCommit && driver.acceptsJobId !== true) {
      throw new Error(
        `[Holo Queue] Queue connection "${envelope.connection}" uses driver "${driver.driver}", `
        + 'which does not accept a caller-supplied job ID, so afterCommit needs a driver that accepts the job ID.',
      )
    }

    const transaction = afterCommit ? await resolveOpenDatabaseTransaction() : undefined

    if (transaction) {
      // Completion and failure hooks run at commit time, so they reflect what was actually enqueued.
      transaction.afterCommit(async () => {
        try {
          const result = await dispatchThroughDriver(driver, envelope)
          if (result.jobId !== envelope.id) {
            throw new Error(
              `[Holo Queue] Queue connection "${envelope.connection}" driver "${driver.driver}" returned job ID "${result.jobId}" `
              + `for job "${envelope.id}", but it declares that it accepts the job ID.`,
            )
          }

          await handlers.completed(toDispatchResult(envelope, result))
        } catch (error) {
          await handlers.failed(error)
          throw error
        }
      })

      // The driver runs at commit, so report how it will run now, not after commit.
      return {
        jobId: envelope.id,
        connection: envelope.connection,
        queue: envelope.queue,
        synchronous: driver.mode === 'sync',
      }
    }

    const dispatched = toDispatchResult(envelope, await dispatchThroughDriver(driver, envelope))
    await handlers.completed(dispatched)
    return dispatched
  } catch (error) {
    await handlers.failed(error)
    throw error
  }
}

class PendingQueueDispatch<TPayload extends QueueJsonValue> implements QueuePendingDispatch<TPayload> {
  private readonly jobName: string
  private readonly payload: TPayload
  private readonly options: QueueDispatchOptions
  private readonly completedHooks: readonly QueueDispatchCompletedHook[]
  private readonly failedHooks: readonly QueueDispatchFailedHook[]
  private executionPromise?: Promise<QueueDispatchResult>

  constructor(
    jobName: string,
    payload: TPayload,
    options: QueueDispatchOptions = {},
    completedHooks: readonly QueueDispatchCompletedHook[] = [],
    failedHooks: readonly QueueDispatchFailedHook[] = [],
  ) {
    this.jobName = jobName
    this.payload = payload
    this.options = options
    this.completedHooks = completedHooks
    this.failedHooks = failedHooks
  }

  onConnection(name: string): QueuePendingDispatch<TPayload> {
    return new PendingQueueDispatch(this.jobName, this.payload, {
      ...this.options,
      connection: normalizeConnectionName(name),
    }, this.completedHooks, this.failedHooks)
  }

  onQueue(name: string): QueuePendingDispatch<TPayload> {
    return new PendingQueueDispatch(this.jobName, this.payload, {
      ...this.options,
      queue: normalizeQueueName(name),
    }, this.completedHooks, this.failedHooks)
  }

  delay(value: QueueDelayValue): QueuePendingDispatch<TPayload> {
    normalizeDelay(value)
    return new PendingQueueDispatch(this.jobName, this.payload, {
      ...this.options,
      delay: value,
    }, this.completedHooks, this.failedHooks)
  }

  afterCommit(): QueuePendingDispatch<TPayload> {
    return new PendingQueueDispatch(this.jobName, this.payload, {
      ...this.options,
      afterCommit: true,
    }, this.completedHooks, this.failedHooks)
  }

  onComplete(callback: QueueDispatchCompletedHook): QueuePendingDispatch<TPayload> {
    return new PendingQueueDispatch(
      this.jobName,
      this.payload,
      this.options,
      [...this.completedHooks, normalizeDispatchCompletedHook(callback)],
      this.failedHooks,
    )
  }

  onFailed(callback: QueueDispatchFailedHook): QueuePendingDispatch<TPayload> {
    return new PendingQueueDispatch(
      this.jobName,
      this.payload,
      this.options,
      this.completedHooks,
      [...this.failedHooks, normalizeDispatchFailedHook(callback)],
    )
  }

  then<TResult1 = QueueDispatchResult, TResult2 = never>(
    onfulfilled?: ((value: QueueDispatchResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<QueueDispatchResult | TResult> {
    return this.execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<QueueDispatchResult> {
    return this.execute().finally(onfinally ?? undefined)
  }

  async dispatch(): Promise<QueueDispatchResult> {
    return this.execute()
  }

  private execute(): Promise<QueueDispatchResult> {
    this.executionPromise ??= (async () => {
      let envelope: QueueJobEnvelope
      try {
        envelope = createDispatchEnvelope(this.jobName, this.payload, this.options)
      } catch (error) {
        await this.runFailedHooks(error)
        throw error
      }

      return dispatchRecord(envelope, { afterCommit: this.options.afterCommit }, {
        completed: result => this.runCompletedHooks(result),
        failed: error => this.runFailedHooks(error),
      })
    })()

    return this.executionPromise
  }

  private async runCompletedHooks(result: QueueDispatchResult): Promise<void> {
    for (const hook of this.completedHooks) {
      try {
        await hook(result)
      } catch (error) {
        reportError(error, { capability: 'queue', operation: 'dispatch.onComplete' })
      }
    }
  }

  private async runFailedHooks(error: unknown): Promise<void> {
    for (const hook of this.failedHooks) {
      try {
        await hook(error)
      } catch (hookError) {
        reportError(hookError, { capability: 'queue', operation: 'dispatch.onFailed' })
      }
    }
  }
}

function createQueueConnection(name?: string): QueueConnectionFacade {
  const resolvedName = name ? normalizeConnectionName(name) : getQueueRuntimeState().config.default
  const dispatchViaConnection = ((
    jobName: string,
    payload: QueueJsonValue,
    options: QueueDispatchOptions = {},
  ): QueuePendingDispatch<QueueJsonValue> => {
    return new PendingQueueDispatch(jobName, payload, {
      ...options,
      connection: resolvedName,
    })
  }) as QueueConnectionFacade['dispatch']
  const dispatchSyncViaConnection = (async (
    jobName: string,
    payload: QueueJsonValue,
  ): Promise<unknown> => {
    return dispatchSyncInternal(jobName, payload, {
      connection: resolvedName,
    })
  }) as QueueConnectionFacade['dispatchSync']

  return {
    name: resolvedName,
    dispatch: dispatchViaConnection,
    dispatchSync: dispatchSyncViaConnection,
  }
}

export type QueueJobTimeoutCandidate = {
  readonly name: string
  readonly definition: {
    readonly timeout?: number
    readonly connection?: string
  }
}

function assertJobTimeoutsBelowRetryAfter(
  config: NormalizedHoloQueueConfig,
  jobs: readonly QueueJobTimeoutCandidate[],
): void {
  for (const job of jobs) {
    const connectionName = job.definition.connection
      ? normalizeConnectionName(job.definition.connection)
      : config.default
    const connection = config.connections[connectionName]
    if (!connection) {
      continue
    }

    assertQueueTimeoutBelowRetryAfter(`Queue job "${job.name}"`, job.definition.timeout, connection)
  }
}

export function assertQueueJobTimeouts(jobs: readonly QueueJobTimeoutCandidate[]): void {
  assertJobTimeoutsBelowRetryAfter(getQueueRuntimeState().config, jobs)
}

setQueueJobRegistrationTimeoutCheck(job => assertJobTimeoutsBelowRetryAfter(getQueueRuntimeState().config, [job]))

export function configureQueueRuntime(options: ConfigureQueueRuntimeOptions = {}): void {
  const state = getQueueRuntimeState()
  let shouldResetDrivers = false

  if (options.config) {
    const config = isNormalizedQueueConfig(options.config)
      ? options.config
      : normalizeQueueConfig(options.config, options.redisConfig)
    assertJobTimeoutsBelowRetryAfter(config, listRegisteredQueueJobs().filter(job => !job.sourcePath))
    state.config = config
    shouldResetDrivers = true
  }

  if (options.driverFactories) {
    state.driverFactories = createQueueDriverFactoryMap(options.driverFactories)
    shouldResetDrivers = true
  }

  if (Object.prototype.hasOwnProperty.call(options, 'failedJobStore')) {
    state.failedJobStore = options.failedJobStore
  }

  if (shouldResetDrivers) {
    closeQueueDrivers(state.drivers.values())
    state.drivers.clear()
  }
}

function resetQueueRuntimeState(state: RuntimeQueueState): void {
  state.config = normalizeQueueConfig()
  state.driverFactories = createDefaultDriverFactories()
  state.drivers.clear()
  state.failedJobStore = undefined
}

export async function shutdownQueueRuntime(): Promise<void> {
  const state = getQueueRuntimeState()
  const drivers = [...new Set(state.drivers.values())]
  state.drivers.clear()
  try {
    const results = await Promise.allSettled(drivers.map(async driver => driver.close()))
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Queue drivers failed to close.')
  } finally {
    resetQueueRuntimeState(state)
  }
}

export function resetQueueRuntime(): void {
  const state = getQueueRuntimeState()
  void closeQueueDrivers(state.drivers.values())
  resetQueueRuntimeState(state)
  resetQueuePluginDriverFactories()
}

export function getQueueRuntime(): QueueRuntimeBinding {
  return createQueueRuntimeBinding(getQueueRuntimeState())
}

export function useQueueConnection(name?: string): QueueConnectionFacade {
  return createQueueConnection(name)
}

function dispatchSyncInternal(
  jobName: string,
  payload: QueueJsonValue,
  options: QueueDispatchOptions = {},
): Promise<unknown> {
  return (async () => {
    const envelope = createDispatchEnvelope(jobName, payload, options, { runsInline: true })
    const result = await dispatchThroughDriver(
      resolveSyncExecutionDriver(),
      envelope,
    ) as Awaited<ReturnType<QueueDriver['dispatch']>> & { readonly result?: unknown }
    return result.result
  })()
}

type KnownRuntimeQueueJobName = Extract<keyof HoloQueueJobRegistry, string>

type DynamicRuntimeQueueJobName<TJobName extends string>
  = [KnownRuntimeQueueJobName] extends [never]
    ? TJobName
    : TJobName extends KnownRuntimeQueueJobName
      ? never
      : KnownRuntimeQueueJobName extends TJobName
        ? never
        : TJobName

export function dispatchSync<TJobName extends KnownRuntimeQueueJobName>(
  jobName: TJobName,
  payload: QueuePayloadFor<TJobName>,
  options?: QueueDispatchOptions,
): Promise<QueueResultFor<TJobName>>
export function dispatchSync<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown, const TJobName extends string = string>(
  jobName: TJobName & DynamicRuntimeQueueJobName<TJobName>,
  payload: TPayload,
  options?: QueueDispatchOptions,
): Promise<TResult>
export async function dispatchSync<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions = {},
): Promise<TResult> {
  return await dispatchSyncInternal(jobName, payload, options) as TResult
}

export function dispatch<TJobName extends KnownRuntimeQueueJobName>(
  jobName: TJobName,
  payload: QueuePayloadFor<TJobName>,
  options?: QueueDispatchOptions,
): QueuePendingDispatch<QueuePayloadFor<TJobName>>
export function dispatch<TPayload extends QueueJsonValue = QueueJsonValue, const TJobName extends string = string>(
  jobName: TJobName & DynamicRuntimeQueueJobName<TJobName>,
  payload: TPayload,
  options?: QueueDispatchOptions,
): QueuePendingDispatch<TPayload>
export function dispatch<TPayload extends QueueJsonValue = QueueJsonValue>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions = {},
): QueuePendingDispatch<TPayload> {
  return new PendingQueueDispatch(jobName, payload, options)
}

queueJobInternals.setQueueJobDispatcher(dispatch)
queueJobInternals.setQueueJobSyncDispatcher(dispatchSync)

export const Queue = {
  connection(name?: string): QueueConnectionFacade {
    return createQueueConnection(name)
  },
  dispatch,
  dispatchSync,
}

export const queueRuntimeInternals = {
  assertQueueJsonValue,
  createQueueRuntimeBinding,
  createDefaultDriverFactories,
  createDispatchEnvelope,
  createJobContext,
  createJobEnvelope,
  createQueueConnection,
  createQueueDriverFactoryContext,
  createQueueDriverFactoryMap,
  closeQueueDrivers,
  dispatchRecord,
  dispatchThroughDriver,
  executeRegisteredQueueJob,
  executeRegisteredQueueJobCompletedHook,
  executeRegisteredQueueJobFailedHook,
  getQueueRuntimeState,
  isPlainObject,
  normalizeConnectionName,
  normalizeDelay,
  normalizeQueueName,
  resolveConnectionConfig,
  resolveConnectionDriver,
  resolveDriverFactory,
  resolveSyncExecutionDriver,
  resetQueueRuntimeState,
  validateQueuePayload,
}
async function closeQueueDrivers(drivers: Iterable<QueueDriver>): Promise<void> {
  const pending = [...drivers].map(async (driver) => {
    try {
      await driver.close()
    } catch {
      // Ignore teardown failures during runtime reset and reconfiguration.
    }
  })

  if (pending.length === 0) {
    return
  }

  await Promise.allSettled(pending)
}
