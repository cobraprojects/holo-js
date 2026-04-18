import { randomUUID } from 'node:crypto'
import type {
  NormalizedQueueConnectionConfig,
  NormalizedHoloQueueConfig,
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
import { DEFAULT_QUEUE_NAME } from './config'
import { normalizeQueueConfig, holoQueueDefaults } from './config'
import { redisQueueDriverFactory } from './drivers/redis'
import { syncQueueDriverFactory } from './drivers/sync'
import { getRegisteredQueueJob } from './registry'

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
    [redisQueueDriverFactory.driver, redisQueueDriverFactory],
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
    const resolvedError = error instanceof Error ? error : new Error(String(error))
    console.warn(`[Holo Queue] onCompleted hook failed for job "${envelope.name}": ${resolvedError.message}`)
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
    const resolvedError = hookError instanceof Error ? hookError : new Error(String(hookError))
    console.warn(`[Holo Queue] onFailed hook failed for job "${envelope.name}": ${resolvedError.message}`)
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
): QueueJobEnvelope<TPayload> {
  const runtime = getQueueRuntimeState()
  const registered = requireRegisteredQueueJob(jobName)
  const connection = resolveConnectionConfig(
    runtime.config,
    options.connection ?? registered.definition.connection,
  )
  const queue = normalizeQueueName(options.queue ?? registered.definition.queue ?? connection.queue ?? DEFAULT_QUEUE_NAME)

  return Object.freeze({
    id: randomUUID(),
    name: registered.name,
    connection: connection.name,
    queue,
    payload,
    attempts: 0,
    maxAttempts: registered.definition.tries ?? 1,
    ...(typeof options.delay === 'undefined' ? {} : { availableAt: normalizeDelay(options.delay) }),
    createdAt: Date.now(),
  })
}

function createDispatchEnvelope<TPayload extends QueueJsonValue>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions = {},
): QueueJobEnvelope<TPayload> {
  validateQueuePayload(payload)
  return createJobEnvelope(jobName, payload, options)
}

async function dispatchRecord(
  envelope: QueueJobEnvelope,
): Promise<QueueDispatchResult> {
  const driver = resolveConnectionDriver(envelope.connection)
  const result = await dispatchThroughDriver(driver, envelope)

  return {
    jobId: result.jobId,
    connection: envelope.connection,
    queue: envelope.queue,
    synchronous: result.synchronous,
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
      try {
        const envelope = createDispatchEnvelope(this.jobName, this.payload, this.options)
        const result = await dispatchRecord(envelope)

        for (const hook of this.completedHooks) {
          try {
            await hook(result)
          } catch (error) {
            const resolvedError = error instanceof Error ? error : new Error(String(error))
            console.warn(`[Holo Queue] onComplete hook failed during dispatch of "${this.jobName}": ${resolvedError.message}`)
          }
        }

        return result
      } catch (error) {
        for (const hook of this.failedHooks) {
          try {
            await hook(error)
          } catch (hookError) {
            const resolvedError = hookError instanceof Error ? hookError : new Error(String(hookError))
            console.warn(`[Holo Queue] onFailed hook failed during dispatch of "${this.jobName}": ${resolvedError.message}`)
          }
        }

        throw error
      }
    })()

    return this.executionPromise
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

export function configureQueueRuntime(options: ConfigureQueueRuntimeOptions = {}): void {
  const state = getQueueRuntimeState()
  let shouldResetDrivers = false

  if (options.config) {
    state.config = normalizeQueueConfig(options.config)
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
  await closeQueueDrivers(state.drivers.values())
  resetQueueRuntimeState(state)
}

export function resetQueueRuntime(): void {
  const state = getQueueRuntimeState()
  void closeQueueDrivers(state.drivers.values())
  resetQueueRuntimeState(state)
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
    const envelope = createDispatchEnvelope(jobName, payload, options)
    const result = await dispatchThroughDriver(
      resolveSyncExecutionDriver(),
      envelope,
    ) as Awaited<ReturnType<QueueDriver['dispatch']>> & { readonly result?: unknown }
    return result.result
  })()
}

export function dispatchSync<TJobName extends Extract<keyof HoloQueueJobRegistry, string>>(
  jobName: TJobName,
  payload: QueuePayloadFor<TJobName>,
  options?: QueueDispatchOptions,
): Promise<QueueResultFor<TJobName>>
export function dispatchSync<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(
  jobName: string,
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

export function dispatch<TJobName extends Extract<keyof HoloQueueJobRegistry, string>>(
  jobName: TJobName,
  payload: QueuePayloadFor<TJobName>,
  options?: QueueDispatchOptions,
): QueuePendingDispatch<QueuePayloadFor<TJobName>>
export function dispatch<TPayload extends QueueJsonValue = QueueJsonValue>(
  jobName: string,
  payload: TPayload,
  options: QueueDispatchOptions = {},
): QueuePendingDispatch<TPayload> {
  return new PendingQueueDispatch(jobName, payload, options)
}

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
