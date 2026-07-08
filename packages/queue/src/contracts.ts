type QueueJsonPrimitive = string | number | boolean | null
export type QueueJsonValue = QueueJsonPrimitive | readonly QueueJsonValue[] | { readonly [key: string]: QueueJsonValue }

type QueueJobDispatcher = <TPayload extends QueueJsonValue>(
  jobName: string,
  payload: TPayload,
) => QueuePendingDispatch<TPayload>

type QueueJobSyncDispatcher = <TPayload extends QueueJsonValue, TResult>(
  jobName: string,
  payload: TPayload,
) => Promise<TResult>

function getQueueJobDispatcher(): QueueJobDispatcher | undefined {
  return (globalThis as typeof globalThis & {
    __holoQueueJobDispatcher__?: QueueJobDispatcher
  }).__holoQueueJobDispatcher__
}

function setQueueJobDispatcher(dispatcher: QueueJobDispatcher): void {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueJobDispatcher__?: QueueJobDispatcher
  }

  runtime.__holoQueueJobDispatcher__ = dispatcher
}

function getQueueJobSyncDispatcher(): QueueJobSyncDispatcher | undefined {
  return (globalThis as typeof globalThis & {
    __holoQueueJobSyncDispatcher__?: QueueJobSyncDispatcher
  }).__holoQueueJobSyncDispatcher__
}

function setQueueJobSyncDispatcher(dispatcher: QueueJobSyncDispatcher): void {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueJobSyncDispatcher__?: QueueJobSyncDispatcher
  }

  runtime.__holoQueueJobSyncDispatcher__ = dispatcher
}

function getQueueJobDefinitionNames(): WeakMap<object, string> {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueJobDefinitionNames__?: WeakMap<object, string>
  }

  runtime.__holoQueueJobDefinitionNames__ ??= new WeakMap<object, string>()
  return runtime.__holoQueueJobDefinitionNames__
}

function getQueueJobDefinitionFingerprints(): Map<string, Set<string>> {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueJobDefinitionFingerprints__?: Map<string, Set<string>>
  }

  runtime.__holoQueueJobDefinitionFingerprints__ ??= new Map<string, Set<string>>()
  return runtime.__holoQueueJobDefinitionFingerprints__
}

function getQueueJobDefinitionOptionFingerprints(): Map<string, Set<string>> {
  const runtime = globalThis as typeof globalThis & {
    __holoQueueJobDefinitionOptionFingerprints__?: Map<string, Set<string>>
  }

  runtime.__holoQueueJobDefinitionOptionFingerprints__ ??= new Map<string, Set<string>>()
  return runtime.__holoQueueJobDefinitionOptionFingerprints__
}

function createQueueJobDefinitionOptionsFingerprint(definition: QueueJobDefinition): string {
  return JSON.stringify({
    connection: definition.connection,
    queue: definition.queue,
    tries: definition.tries,
    backoff: definition.backoff,
    timeout: definition.timeout,
  })
}

function getQueueJobDefinitionFingerprint(definition: object): string | undefined {
  if (!isQueueJobDefinition(definition)) {
    return undefined
  }

  return JSON.stringify({
    options: createQueueJobDefinitionOptionsFingerprint(definition),
    handle: definition.handle.toString(),
  })
}

function addQueueJobDefinitionNameByFingerprint(
  fingerprints: Map<string, Set<string>>,
  fingerprint: string,
  name: string,
): void {
  const names = fingerprints.get(fingerprint) ?? new Set<string>()
  names.add(name)
  fingerprints.set(fingerprint, names)
}

function setQueueJobDefinitionName(definition: object, name: string): void {
  getQueueJobDefinitionNames().set(definition, name)

  if (!isQueueJobDefinition(definition)) {
    return
  }

  addQueueJobDefinitionNameByFingerprint(
    getQueueJobDefinitionFingerprints(),
    getQueueJobDefinitionFingerprint(definition)!,
    name,
  )
  addQueueJobDefinitionNameByFingerprint(
    getQueueJobDefinitionOptionFingerprints(),
    createQueueJobDefinitionOptionsFingerprint(definition),
    name,
  )
}

function deleteQueueJobDefinitionName(name: string): void {
  for (const fingerprints of [
    getQueueJobDefinitionFingerprints(),
    getQueueJobDefinitionOptionFingerprints(),
  ]) {
    for (const [fingerprint, names] of fingerprints) {
      names.delete(name)
      if (names.size === 0) {
        fingerprints.delete(fingerprint)
      }
    }
  }
}

function clearQueueJobDefinitionNames(): void {
  getQueueJobDefinitionFingerprints().clear()
  getQueueJobDefinitionOptionFingerprints().clear()
}

function resolveSingleQueueJobDefinitionFingerprintName(
  names: Set<string> | undefined,
): string | undefined {
  if (!names) {
    return undefined
  }

  if (names.size === 1) {
    return [...names][0]!
  }

  throw new Error('[Holo Queue] Job definition dispatch is ambiguous because multiple registered jobs match the same definition.')
}

function resolveQueueJobDefinitionName(definition: object): string {
  const name = getQueueJobDefinitionNames().get(definition)
  if (name) {
    return name
  }

  const fingerprint = getQueueJobDefinitionFingerprint(definition)
  const fingerprintName = fingerprint
    ? resolveSingleQueueJobDefinitionFingerprintName(getQueueJobDefinitionFingerprints().get(fingerprint))
    : undefined

  if (fingerprintName) {
    return fingerprintName
  }

  if (isQueueJobDefinition(definition)) {
    const optionFingerprintName = resolveSingleQueueJobDefinitionFingerprintName(
      getQueueJobDefinitionOptionFingerprints().get(createQueueJobDefinitionOptionsFingerprint(definition)),
    )

    if (optionFingerprintName) {
      return optionFingerprintName
    }
  }

  throw new Error('[Holo Queue] Job definitions cannot dispatch before the job is registered.')
}

function dispatchDefinedQueueJob<TPayload extends QueueJsonValue>(
  definition: object,
  payload: TPayload,
): QueuePendingDispatch<TPayload> {
  const dispatcher = getQueueJobDispatcher()
  if (!dispatcher) {
    throw new Error('[Holo Queue] Job definitions cannot dispatch before the queue runtime is loaded.')
  }

  return dispatcher(resolveQueueJobDefinitionName(definition), payload)
}

function dispatchDefinedQueueJobSync<TPayload extends QueueJsonValue, TResult>(
  definition: object,
  payload: TPayload,
): Promise<TResult> {
  const dispatcher = getQueueJobSyncDispatcher()
  if (!dispatcher) {
    throw new Error('[Holo Queue] Job definitions cannot dispatch before the queue runtime is loaded.')
  }

  return dispatcher(resolveQueueJobDefinitionName(definition), payload)
}

function normalizeOptionalString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Queue] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeOptionalInteger(
  value: number | undefined,
  label: string,
  options: { minimum?: number } = {},
): number | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (!Number.isInteger(value)) {
    throw new Error(`[Holo Queue] ${label} must be an integer when provided.`)
  }

  if (typeof options.minimum === 'number' && value < options.minimum) {
    throw new Error(`[Holo Queue] ${label} must be greater than or equal to ${options.minimum}.`)
  }

  return value
}

function normalizeBackoff(
  value: number | readonly number[] | undefined,
): number | readonly number[] | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value === 'number') {
    return normalizeOptionalInteger(value, 'Job backoff', { minimum: 0 })
  }

  if (!Array.isArray(value)) {
    throw new Error('[Holo Queue] Job backoff must be a number or an array of integers.')
  }

  const normalized = value.map((entry, index) => {
    if (!Number.isInteger(entry)) {
      throw new Error(`[Holo Queue] Job backoff entry at index ${index} must be an integer.`)
    }

    if (entry < 0) {
      throw new Error(`[Holo Queue] Job backoff entry at index ${index} must be greater than or equal to 0.`)
    }

    return entry
  })

  return Object.freeze(normalized)
}

function normalizeOptionalHook<THandler extends (...args: never[]) => unknown>(
  value: THandler | undefined,
  label: string,
): THandler | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value !== 'function') {
    throw new Error(`[Holo Queue] ${label} must be a function when provided.`)
  }

  return value
}

export interface QueueJobContext {
  readonly jobId: string
  readonly jobName: string
  readonly connection: string
  readonly queue: string
  readonly attempt: number
  readonly maxAttempts: number
  release(delaySeconds?: number): Promise<void>
  fail(error: Error): Promise<void>
}

export interface QueueJobCompletedHook<
  TPayload extends QueueJsonValue = QueueJsonValue,
  TResult = unknown,
> {
  (
    payload: TPayload,
    result: TResult,
    context: QueueJobContext,
  ): void | Promise<void>
}

export interface QueueJobFailedHook<TPayload extends QueueJsonValue = QueueJsonValue> {
  (
    payload: TPayload,
    error: Error,
    context: QueueJobContext,
  ): void | Promise<void>
}

export interface QueueJobDefinition<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown> {
  readonly connection?: string
  readonly queue?: string
  readonly tries?: number
  readonly backoff?: number | readonly number[]
  readonly timeout?: number
  readonly onCompleted?: QueueJobCompletedHook<TPayload, TResult>
  readonly onFailed?: QueueJobFailedHook<TPayload>
  handle(payload: TPayload, context: QueueJobContext): Promise<TResult> | TResult
}

export interface DefinedQueueJobDefinition<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown> extends QueueJobDefinition<TPayload, TResult> {
  dispatch(payload: TPayload): QueuePendingDispatch<TPayload>
  dispatchSync(payload: TPayload): Promise<TResult>
}

export interface QueueJobEnvelope<TPayload extends QueueJsonValue = QueueJsonValue> {
  readonly id: string
  readonly name: string
  readonly connection: string
  readonly queue: string
  readonly payload: TPayload
  readonly attempts: number
  readonly maxAttempts: number
  readonly availableAt?: number
  readonly createdAt: number
}

export type QueueDelayValue = number | Date

export interface QueueDispatchOptions {
  readonly connection?: string
  readonly queue?: string
  readonly delay?: QueueDelayValue
}

export interface QueueDispatchResult {
  readonly jobId: string
  readonly connection: string
  readonly queue: string
  readonly synchronous: boolean
}

export interface QueueDispatchCompletedHook {
  (
    result: QueueDispatchResult,
  ): void | Promise<void>
}

export interface QueueDispatchFailedHook {
  (
    error: unknown,
  ): void | Promise<void>
}

export interface QueueDriverDispatchResult<TResult = unknown> {
  readonly jobId: string
  readonly synchronous: boolean
  readonly result?: TResult
}

export interface QueueRegisteredJob<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown> {
  readonly name: string
  readonly sourcePath?: string
  readonly definition: QueueJobDefinition<TPayload, TResult>
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloQueueJobRegistry {}

type KnownQueueJobName = Extract<keyof HoloQueueJobRegistry, string>

type DynamicQueueJobName<TJobName extends string>
  = [KnownQueueJobName] extends [never]
    ? TJobName
    : TJobName extends KnownQueueJobName
      ? never
      : KnownQueueJobName extends TJobName
        ? never
        : TJobName

type ResolveRegisteredQueueJobDefinition<TJobName extends string>
  = TJobName extends KnownQueueJobName
    ? HoloQueueJobRegistry[TJobName] extends QueueJobDefinition<infer TPayload, infer TResult>
      ? QueueJobDefinition<TPayload, TResult>
      : QueueJobDefinition
    : QueueJobDefinition

export type ExportedQueueJobDefinition<TValue>
  = TValue extends QueueJobDefinition<infer TPayload, infer TResult>
    ? QueueJobDefinition<TPayload, TResult>
    : QueueJobDefinition

export type QueuePayloadFor<TJobName extends string>
  = ResolveRegisteredQueueJobDefinition<TJobName> extends QueueJobDefinition<infer TPayload, infer _TResult>
    ? TPayload
    : QueueJsonValue

export type QueueResultFor<TJobName extends string>
  = ResolveRegisteredQueueJobDefinition<TJobName> extends QueueJobDefinition<infer _TPayload, infer TResult>
    ? TResult
    : unknown

export interface RegisterQueueJobOptions {
  readonly name?: string
  readonly sourcePath?: string
  readonly replaceExisting?: boolean
}

export type RegisterableQueueJobDefinition<
  TPayload extends QueueJsonValue = QueueJsonValue,
  TResult = unknown,
> = QueueJobDefinition<TPayload, TResult>

export interface QueuePendingDispatch<TPayload extends QueueJsonValue = QueueJsonValue> extends PromiseLike<QueueDispatchResult> {
  onConnection(name: string): QueuePendingDispatch<TPayload>
  onQueue(name: string): QueuePendingDispatch<TPayload>
  delay(value: QueueDelayValue): QueuePendingDispatch<TPayload>
  onComplete(callback: QueueDispatchCompletedHook): QueuePendingDispatch<TPayload>
  onFailed(callback: QueueDispatchFailedHook): QueuePendingDispatch<TPayload>
  then<TResult1 = QueueDispatchResult, TResult2 = never>(
    onfulfilled?: ((value: QueueDispatchResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<QueueDispatchResult | TResult>
  finally(onfinally?: (() => void) | null): Promise<QueueDispatchResult>
  dispatch(): Promise<QueueDispatchResult>
}

export interface QueueConnectionFacade {
  readonly name: string
  dispatch<TJobName extends KnownQueueJobName>(
    jobName: TJobName,
    payload: QueuePayloadFor<TJobName>,
    options?: QueueDispatchOptions,
  ): QueuePendingDispatch<QueuePayloadFor<TJobName>>
  dispatch<TPayload extends QueueJsonValue = QueueJsonValue, const TJobName extends string = string>(
    jobName: TJobName & DynamicQueueJobName<TJobName>,
    payload: TPayload,
    options?: QueueDispatchOptions,
  ): QueuePendingDispatch<TPayload>
  dispatchSync<TJobName extends KnownQueueJobName>(
    jobName: TJobName,
    payload: QueuePayloadFor<TJobName>,
  ): Promise<QueueResultFor<TJobName>>
  dispatchSync<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown, const TJobName extends string = string>(
    jobName: TJobName & DynamicQueueJobName<TJobName>,
    payload: TPayload,
  ): Promise<TResult>
}

export interface QueueEnqueueResult {
  readonly jobId: string
}

export interface QueueReserveInput {
  readonly queueNames: readonly string[]
  readonly workerId: string
}

export interface QueueReservedJob<TPayload extends QueueJsonValue = QueueJsonValue> {
  readonly reservationId: string
  readonly envelope: QueueJobEnvelope<TPayload>
  readonly reservedAt: number
}

export interface QueueReleaseOptions {
  readonly delaySeconds?: number
}

export interface QueueClearInput {
  readonly queueNames?: readonly string[]
}

export interface QueueJobContextOverrides {
  readonly maxAttempts?: number
  shouldSkipLifecycleHooks?(): boolean
  release?(delaySeconds?: number): Promise<void>
  fail?(error: Error): Promise<void>
}

export interface QueueDriverFactoryContext {
  execute<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(job: QueueJobEnvelope<TPayload>): Promise<TResult>
}

export interface QueueDriverBase {
  readonly name: string
  readonly driver: NormalizedQueueConnectionConfig['driver']
  readonly mode: 'sync' | 'async'
  dispatch<TPayload extends QueueJsonValue = QueueJsonValue, TResult = unknown>(job: QueueJobEnvelope<TPayload>): Promise<QueueDriverDispatchResult<TResult>>
  clear(input?: QueueClearInput): Promise<number>
  close(): Promise<void>
}

export interface QueueAsyncDriver extends QueueDriverBase {
  readonly mode: 'async'
  reserve<TPayload extends QueueJsonValue = QueueJsonValue>(input: QueueReserveInput): Promise<QueueReservedJob<TPayload> | null>
  acknowledge(job: QueueReservedJob): Promise<void>
  release(job: QueueReservedJob, options?: QueueReleaseOptions): Promise<void>
  delete(job: QueueReservedJob): Promise<void>
}

export interface QueueSyncDriver extends QueueDriverBase {
  readonly mode: 'sync'
}

export type QueueDriver = QueueSyncDriver | QueueAsyncDriver

export interface QueueDriverFactory<TConfig extends NormalizedQueueConnectionConfig = NormalizedQueueConnectionConfig> {
  readonly driver: TConfig['driver']
  create(connection: TConfig, context: QueueDriverFactoryContext): QueueDriver
}

export interface QueueRuntimeBinding {
  readonly config: NormalizedHoloQueueConfig
  readonly drivers: ReadonlyMap<string, QueueDriver>
}

export interface QueueWorkerOptions {
  readonly connection?: string
  readonly queueNames?: readonly string[]
  readonly once?: boolean
  readonly stopWhenEmpty?: boolean
  readonly sleep?: number
  readonly tries?: number
  readonly timeout?: number
  readonly maxJobs?: number
  readonly maxTime?: number
  readonly workerId?: string
  readonly shouldStop?: () => boolean | Promise<boolean>
  readonly sleepFn?: (milliseconds: number) => Promise<void>
}

export interface QueueWorkerJobEvent {
  readonly jobId: string
  readonly jobName: string
  readonly connection: string
  readonly queue: string
  readonly attempt: number
  readonly maxAttempts: number
}

export interface QueueWorkerHooks {
  onJobProcessed?(event: QueueWorkerJobEvent): void | Promise<void>
  onJobReleased?(event: QueueWorkerJobEvent & { readonly delaySeconds?: number, readonly error?: Error }): void | Promise<void>
  onJobFailed?(event: QueueWorkerJobEvent & { readonly error: Error }): void | Promise<void>
  onIdle?(): void | Promise<void>
}

export interface QueueWorkerRunOptions extends QueueWorkerOptions, QueueWorkerHooks {}

export interface QueueWorkerResult {
  readonly processed: number
  readonly released: number
  readonly failed: number
  readonly stoppedBecause: 'once' | 'empty' | 'max-jobs' | 'max-time' | 'signal'
}

export interface QueueFailedJobRecord<TPayload extends QueueJsonValue = QueueJsonValue> {
  readonly id: string
  readonly jobId: string
  readonly job: QueueJobEnvelope<TPayload>
  readonly exception: string
  readonly failedAt: number
}

export interface QueueFailedJobStore {
  persistFailedJob(reserved: QueueReservedJob, error: Error): Promise<QueueFailedJobRecord | null>
  listFailedJobs(): Promise<readonly QueueFailedJobRecord[]>
  retryFailedJobs(
    identifier: 'all' | string,
    retry: (record: QueueFailedJobRecord) => Promise<void>,
  ): Promise<number>
  forgetFailedJob(id: string): Promise<boolean>
  flushFailedJobs(): Promise<number>
}

export function isQueueJobDefinition(value: unknown): value is QueueJobDefinition {
  return value !== null
    && typeof value === 'object'
    && 'handle' in value
    && typeof (value as QueueJobDefinition).handle === 'function'
}

export function normalizeQueueJobDefinition<
  TPayload extends QueueJsonValue,
  TResult,
  TJob extends QueueJobDefinition<TPayload, TResult>,
>(job: TJob): TJob {
  if (!isQueueJobDefinition(job)) {
    throw new Error('[Holo Queue] Jobs must define a "handle" function.')
  }

  return {
    ...job,
    ...(typeof job.connection === 'undefined' ? {} : { connection: normalizeOptionalString(job.connection, 'Job connection') }),
    ...(typeof job.queue === 'undefined' ? {} : { queue: normalizeOptionalString(job.queue, 'Job queue') }),
    ...(typeof job.tries === 'undefined' ? {} : { tries: normalizeOptionalInteger(job.tries, 'Job tries', { minimum: 1 }) }),
    ...(typeof job.timeout === 'undefined' ? {} : { timeout: normalizeOptionalInteger(job.timeout, 'Job timeout', { minimum: 0 }) }),
    ...(typeof job.backoff === 'undefined' ? {} : { backoff: normalizeBackoff(job.backoff) }),
    ...(typeof job.onCompleted === 'undefined' ? {} : { onCompleted: normalizeOptionalHook(job.onCompleted, 'Job onCompleted hook') }),
    ...(typeof job.onFailed === 'undefined' ? {} : { onFailed: normalizeOptionalHook(job.onFailed, 'Job onFailed hook') }),
  } as TJob
}

export function defineJob<TPayload extends QueueJsonValue, TResult = unknown>(
  job: QueueJobDefinition<TPayload, TResult>,
): DefinedQueueJobDefinition<TPayload, TResult> {
  const normalized = normalizeQueueJobDefinition<TPayload, TResult, QueueJobDefinition<TPayload, TResult>>(job) as DefinedQueueJobDefinition<TPayload, TResult>
  Object.defineProperty(normalized, 'dispatch', {
    value(payload: TPayload): QueuePendingDispatch<TPayload> {
      return dispatchDefinedQueueJob(normalized, payload)
    },
    enumerable: false,
  })
  Object.defineProperty(normalized, 'dispatchSync', {
    value(payload: TPayload): Promise<TResult> {
      return dispatchDefinedQueueJobSync<TPayload, TResult>(normalized, payload)
    },
    enumerable: false,
  })
  return Object.freeze(normalized)
}

export interface QueueFailedStoreConfig {
  readonly driver?: 'database'
  readonly connection?: string
  readonly table?: string
}

export interface QueueRedisConnectionConfig {
  readonly driver: 'redis'
  readonly connection?: string
  readonly queue?: string
  readonly retryAfter?: number | string
  readonly blockFor?: number | string
  readonly redis?: {
    readonly url?: string
    readonly clusters?: readonly {
      readonly url?: string
      readonly host?: string
      readonly port?: number | string
    }[]
    readonly host?: string
    readonly port?: number | string
    readonly password?: string
    readonly username?: string
    readonly db?: number | string
  }
}

export interface QueueDatabaseConnectionConfig {
  readonly driver: 'database'
  readonly queue?: string
  readonly retryAfter?: number | string
  readonly sleep?: number | string
  readonly connection?: string
  readonly table?: string
}

export interface QueueSyncConnectionConfig {
  readonly driver: 'sync'
  readonly queue?: string
}

export interface QueuePluginConnectionConfig {
  readonly driver: string
  readonly queue?: string
  readonly [key: string]: unknown
}

export type QueueConnectionConfig
  = QueueSyncConnectionConfig
  | QueueRedisConnectionConfig
  | QueueDatabaseConnectionConfig
  | QueuePluginConnectionConfig

export interface HoloQueueConfig {
  readonly default?: string
  readonly failed?: false | QueueFailedStoreConfig
  readonly connections?: Readonly<Record<string, QueueConnectionConfig>>
}

export interface NormalizedQueueFailedStoreConfig {
  readonly driver: 'database'
  readonly connection: string
  readonly table: string
}

export interface NormalizedQueueSyncConnectionConfig {
  readonly name: string
  readonly driver: 'sync'
  readonly queue: string
}

export interface NormalizedQueueRedisConnectionConfig {
  readonly name: string
  readonly driver: 'redis'
  readonly connection: string
  readonly queue: string
  readonly retryAfter: number
  readonly blockFor: number
  readonly redis: {
    readonly url?: string
    readonly clusters?: readonly {
      readonly url?: string
      readonly host: string
      readonly port: number
    }[]
    readonly host: string
    readonly port: number
    readonly password?: string
    readonly username?: string
    readonly db: number
  }
}

export interface QueueSharedRedisConnectionConfig {
  readonly name: string
  readonly url?: string
  readonly clusters?: readonly {
    readonly url?: string
    readonly host: string
    readonly port: number
  }[]
  readonly host: string
  readonly port: number
  readonly password?: string
  readonly username?: string
  readonly db: number
}

export interface QueueSharedRedisConfig {
  readonly default: string
  readonly connections: Readonly<Record<string, QueueSharedRedisConnectionConfig>>
}

export interface NormalizedQueueDatabaseConnectionConfig {
  readonly name: string
  readonly driver: 'database'
  readonly queue: string
  readonly retryAfter: number
  readonly sleep: number
  readonly connection: string
  readonly table: string
}

export interface NormalizedQueuePluginConnectionConfig {
  readonly name: string
  readonly driver: string
  readonly queue: string
  readonly [key: string]: unknown
}

export type NormalizedQueueConnectionConfig
  = NormalizedQueueSyncConnectionConfig
  | NormalizedQueueRedisConnectionConfig
  | NormalizedQueueDatabaseConnectionConfig
  | NormalizedQueuePluginConnectionConfig

export interface NormalizedHoloQueueConfig {
  readonly default: string
  readonly failed: false | NormalizedQueueFailedStoreConfig
  readonly connections: Readonly<Record<string, NormalizedQueueConnectionConfig>>
}

export const queueJobInternals = {
  clearQueueJobDefinitionNames,
  deleteQueueJobDefinitionName,
  dispatchDefinedQueueJob,
  dispatchDefinedQueueJobSync,
  normalizeQueueJobDefinition,
  normalizeBackoff,
  normalizeOptionalHook,
  normalizeOptionalInteger,
  normalizeOptionalString,
  resolveQueueJobDefinitionName,
  setQueueJobDefinitionName,
  setQueueJobDispatcher,
  setQueueJobSyncDispatcher,
}
