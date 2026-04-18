import { randomUUID } from 'node:crypto'
import { holoBroadcastDefaults } from '@holo-js/config'
import {
  type BroadcastDefinition,
  type BroadcastDefinitionInput,
  type BroadcastDelayValue,
  type BroadcastDispatchOptions,
  type BroadcastDriver,
  type BroadcastDriverExecutionContext,
  type BroadcastJsonObject,
  type BroadcastRuntimeBindings,
  type BroadcastRuntimeFacade,
  type BroadcastSendInput,
  type BroadcastSendResult,
  type PendingBroadcastDispatch,
  type RawBroadcastSendInput,
  type ResolvedRawBroadcastSendInput,
  isBroadcastDefinition,
  formatChannelPattern,
  normalizeBroadcastDefinition,
} from './contracts'
import { getRegisteredBroadcastDriver } from './registry'

const HOLO_BROADCAST_DELIVER_JOB = 'holo.broadcast.deliver'

type RuntimeState = {
  bindings?: BroadcastRuntimeBindings
  loadQueueModule?: () => Promise<QueueModule>
  loadDbModule?: () => Promise<DbModule | null>
  queueJobRegistration?: Promise<QueueModule>
}

type MutableDispatchOptions = {
  broadcaster?: string
  connection?: string
  queue?: string
  delay?: BroadcastDelayValue
  afterCommit?: boolean
}

type ResolvedQueuePlan = {
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly delay?: BroadcastDelayValue
  readonly afterCommit: boolean
}

type ResolvedBroadcastConnection = {
  readonly name: string
  readonly driver: string
}

type ResolvedDriver = {
  readonly connection: ResolvedBroadcastConnection
  readonly driver: string
  readonly implementation: BroadcastDriver
}

type QueueDispatchChain = {
  onConnection(name: string): QueueDispatchChain
  onQueue(name: string): QueueDispatchChain
  delay(value: number | Date): QueueDispatchChain
  dispatch(): Promise<unknown>
}

type QueueModule = {
  defineJob(definition: { handle(payload: QueuedBroadcastPayload): Promise<unknown> | unknown }): unknown
  dispatch(jobName: string, payload: QueuedBroadcastPayload): QueueDispatchChain
  getRegisteredQueueJob(name: string): unknown
  registerQueueJob(definition: unknown, options: { name: string }): void
}

type DbModule = {
  connectionAsyncContext: {
    getActive(): { connection: { getScope(): { kind: string }, afterCommit(callback: () => Promise<void>): void } } | undefined
  }
}

type QueuedBroadcastPayload = Readonly<{
  readonly messageId: string
  readonly raw: ResolvedRawBroadcastSendInput
  readonly context: Readonly<{
    readonly connection: string
    readonly driver: string
  }>
}>

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoBroadcastRuntime__?: RuntimeState
  }

  runtime.__holoBroadcastRuntime__ ??= {}
  return runtime.__holoBroadcastRuntime__
}

function getRuntimeBindings(): BroadcastRuntimeBindings {
  return getRuntimeState().bindings ?? {}
}

function dynamicImport<TModule>(specifier: string): Promise<TModule> {
  return import(specifier as string) as Promise<TModule>
}

async function loadQueueModule(): Promise<QueueModule> {
  const override = getRuntimeState().loadQueueModule
  if (override) {
    try {
      return await override()
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        throw new Error('[@holo-js/broadcast] Queued or delayed broadcasts require @holo-js/queue to be installed.')
      }

      throw error
    }
  }

  try {
    return await dynamicImport<QueueModule>('@holo-js/queue')
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new Error('[@holo-js/broadcast] Queued or delayed broadcasts require @holo-js/queue to be installed.')
    }

    throw error
  }
}

async function loadDbModule(): Promise<DbModule | null> {
  const override = getRuntimeState().loadDbModule
  if (override) {
    try {
      return await override()
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        return null
      }

      throw error
    }
  }

  try {
    return await dynamicImport<DbModule>('@holo-js/db')
  } catch (error) {
    /* v8 ignore start -- environment-specific optional dependency fallback */
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return null
    }

    throw error
    /* v8 ignore stop */
  }
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
    throw new Error(`[@holo-js/broadcast] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeRequiredString(
  value: string,
  label: string,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/broadcast] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeDelayValue(value: BroadcastDelayValue, label: string): BroadcastDelayValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[@holo-js/broadcast] ${label} must be a finite number greater than or equal to 0.`)
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`[@holo-js/broadcast] ${label} dates must be valid Date instances.`)
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function normalizeJsonValue(value: unknown, path: string): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => normalizeJsonValue(entry, `${path}[${index}]`)))
  }

  if (!isRecord(value)) {
    throw new Error(`[@holo-js/broadcast] ${path} must be JSON-serializable.`)
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeJsonValue(entry, `${path}.${key}`)]),
  ))
}

function normalizePayload(payload: unknown): Readonly<BroadcastJsonObject> {
  if (!isRecord(payload)) {
    throw new Error('[@holo-js/broadcast] Broadcast payload must be a plain object.')
  }

  return normalizeJsonValue(payload, 'Broadcast payload') as Readonly<BroadcastJsonObject>
}

function normalizeRawChannels(channels: readonly string[]): readonly string[] {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new Error('[@holo-js/broadcast] Raw broadcasts must target at least one channel.')
  }

  const normalized = channels.map((channel) => normalizeRequiredString(channel, 'Broadcast channel'))
  return Object.freeze(normalized)
}

function resolveBroadcastDefinition(
  definition: BroadcastDefinition | BroadcastDefinitionInput,
): BroadcastDefinition {
  return isBroadcastDefinition(definition)
    ? definition
    : normalizeBroadcastDefinition(definition)
}

function resolveBroadcastConnection(
  selectedConnection: string | undefined,
): ResolvedBroadcastConnection {
  const config = getRuntimeBindings().config ?? holoBroadcastDefaults
  const connectionName = normalizeOptionalString(selectedConnection, 'Broadcast connection') ?? config.default
  const connection = config.connections[connectionName]

  if (!connection) {
    throw new Error(`[@holo-js/broadcast] Broadcast connection "${connectionName}" is not configured.`)
  }

  return Object.freeze({
    name: connection.name,
    driver: connection.driver,
    ...('options' in connection ? { options: connection.options } : {}),
  })
}

function normalizeRawBroadcastInput(
  input: RawBroadcastSendInput,
  selectedConnection?: string,
): Readonly<ResolvedRawBroadcastSendInput> {
  const connection = resolveBroadcastConnection(selectedConnection ?? input.connection)
  const event = normalizeRequiredString(input.event, 'Broadcast event')
  const socketId = normalizeOptionalString(input.socketId, 'Broadcast socket id')

  return Object.freeze({
    connection: connection.name,
    event,
    channels: normalizeRawChannels(input.channels),
    payload: normalizePayload(input.payload),
    ...(typeof socketId === 'undefined' ? {} : { socketId }),
  })
}

function createRawInputFromDefinition(
  definition: BroadcastDefinition,
  selectedConnection?: string,
): Readonly<ResolvedRawBroadcastSendInput> {
  if (typeof definition.name !== 'string' || !definition.name.trim()) {
    throw new Error('[@holo-js/broadcast] Broadcast definitions must resolve a public event name before dispatch.')
  }

  return normalizeRawBroadcastInput({
    connection: selectedConnection,
    event: definition.name,
    channels: definition.channels.map((channel) => {
      const resolved = formatChannelPattern(
        channel.pattern,
        channel.params as Parameters<typeof formatChannelPattern>[1],
      )
      if (channel.type === 'private') {
        return `private-${resolved}`
      }

      if (channel.type === 'presence') {
        return `presence-${resolved}`
      }

      return resolved
    }),
    payload: definition.payload,
  })
}

function resolveQueuePlan(
  definition: BroadcastDefinition | null,
  options: Readonly<MutableDispatchOptions>,
): ResolvedQueuePlan {
  const queueDefaults = definition?.queue
  const queued = queueDefaults?.queued === true
    || typeof options.connection !== 'undefined'
    || typeof options.queue !== 'undefined'
    || typeof options.delay !== 'undefined'
    || typeof definition?.delay !== 'undefined'

  return Object.freeze({
    queued,
    connection: options.connection ?? queueDefaults?.connection,
    queue: options.queue ?? queueDefaults?.queue,
    delay: options.delay ?? definition?.delay,
    afterCommit: options.afterCommit ?? queueDefaults?.afterCommit ?? false,
  })
}

function normalizeDispatchOptions(options: Readonly<MutableDispatchOptions>): Readonly<BroadcastDispatchOptions> {
  return Object.freeze({
    broadcaster: options.broadcaster,
    connection: options.connection,
    queue: options.queue,
    delay: options.delay,
    afterCommit: options.afterCommit,
  })
}

function createExecutionContext(
  messageId: string,
  driver: ResolvedDriver,
  queued: boolean,
  deferred = false,
): Readonly<BroadcastDriverExecutionContext & { readonly messageId: string }> {
  return Object.freeze({
    connection: driver.connection.name,
    driver: driver.driver,
    queued,
    delayed: deferred,
    messageId,
  })
}

function createBaseResult(
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
  channels: readonly string[],
): Readonly<BroadcastSendResult> {
  return Object.freeze({
    connection: context.connection,
    driver: context.driver,
    queued: context.queued,
    publishedChannels: Object.freeze([...channels]),
    messageId: context.messageId,
  })
}

function normalizeDriverResult(
  result: BroadcastSendResult,
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
  channels: readonly string[],
): Readonly<BroadcastSendResult> {
  const publishedChannels = Array.isArray(result.publishedChannels)
    ? Object.freeze(result.publishedChannels.map(channel => normalizeRequiredString(channel, 'Published channel')))
    : Object.freeze([...channels])

  const provider = result.provider && isRecord(result.provider)
    ? Object.freeze({ ...result.provider })
    : undefined

  return Object.freeze({
    connection: normalizeOptionalString(result.connection, 'Broadcast result connection') ?? context.connection,
    driver: normalizeOptionalString(result.driver, 'Broadcast result driver') ?? context.driver,
    queued: typeof result.queued === 'boolean' ? result.queued : context.queued,
    publishedChannels,
    messageId: normalizeOptionalString(result.messageId, 'Broadcast result messageId') ?? context.messageId,
    ...(provider ? { provider } : {}),
  })
}

function createTransportDriver(driverName: 'holo' | 'pusher' | 'ably'): BroadcastDriver {
  return {
    async send(input, context) {
      const publish = getRuntimeBindings().publish
      if (!publish) {
        throw new Error(`[@holo-js/broadcast] The "${driverName}" driver requires a publish runtime binding.`)
      }

      return await publish(input, context)
    },
  }
}

const builtInDrivers = Object.freeze({
  holo: createTransportDriver('holo'),
  pusher: createTransportDriver('pusher'),
  ably: createTransportDriver('ably'),
  log: {
    send(input, context) {
      console.warn('[@holo-js/broadcast]', {
        connection: context.connection,
        driver: context.driver,
        event: input.event,
        channels: input.channels,
        hasSocketId: typeof input.socketId === 'string',
      })

      return createBaseResult({ ...context, messageId: randomUUID() }, input.channels)
    },
  } satisfies BroadcastDriver,
  null: {
    send(input, context) {
      return createBaseResult({ ...context, messageId: randomUUID() }, input.channels)
    },
  } satisfies BroadcastDriver,
})

function resolveDriver(connectionName: string): ResolvedDriver {
  const connection = resolveBroadcastConnection(connectionName)
  const implementation = getRegisteredBroadcastDriver(connection.driver)
    ?? builtInDrivers[connection.driver as keyof typeof builtInDrivers]

  if (!implementation) {
    throw new Error(`[@holo-js/broadcast] Broadcast driver "${connection.driver}" is not registered.`)
  }

  return Object.freeze({
    connection,
    driver: connection.driver,
    implementation,
  })
}

async function runQueuedBroadcastDelivery(payload: QueuedBroadcastPayload): Promise<Readonly<BroadcastSendResult>> {
  const driver = resolveDriver(payload.context.connection)
  const context = createExecutionContext(payload.messageId, driver, true)
  return await deliverResolvedRawBroadcast(payload.raw, driver, context)
}

async function ensureBroadcastQueueJobRegistered(queueModule?: QueueModule): Promise<QueueModule> {
  const state = getRuntimeState()
  if (queueModule?.getRegisteredQueueJob(HOLO_BROADCAST_DELIVER_JOB)) {
    return queueModule
  }

  if (state.queueJobRegistration) {
    return await state.queueJobRegistration
  }

  const registration = (async () => {
    const resolvedQueueModule = queueModule ?? await loadQueueModule()
    if (!resolvedQueueModule.getRegisteredQueueJob(HOLO_BROADCAST_DELIVER_JOB)) {
      resolvedQueueModule.registerQueueJob(
        resolvedQueueModule.defineJob({
          async handle(payload: QueuedBroadcastPayload) {
            return await runQueuedBroadcastDelivery(payload)
          },
        }),
        { name: HOLO_BROADCAST_DELIVER_JOB },
      )
    }

    return resolvedQueueModule
  })()

  state.queueJobRegistration = registration
  try {
    return await registration
  } finally {
    if (state.queueJobRegistration === registration) {
      state.queueJobRegistration = undefined
    }
  }
}

function createQueuedPayload(
  input: ResolvedRawBroadcastSendInput,
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
): QueuedBroadcastPayload {
  return Object.freeze({
    messageId: context.messageId,
    raw: input,
    context: Object.freeze({
      connection: context.connection,
      driver: context.driver,
    }),
  })
}

async function dispatchQueuedBroadcast(
  input: ResolvedRawBroadcastSendInput,
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
  plan: ResolvedQueuePlan,
): Promise<Readonly<BroadcastSendResult>> {
  const queueModule = await ensureBroadcastQueueJobRegistered()
  let pending = queueModule.dispatch(
    HOLO_BROADCAST_DELIVER_JOB,
    createQueuedPayload(input, context),
  )

  if (typeof plan.connection !== 'undefined') {
    pending = pending.onConnection(plan.connection)
  }

  if (typeof plan.queue !== 'undefined') {
    pending = pending.onQueue(plan.queue)
  }

  if (typeof plan.delay !== 'undefined') {
    pending = pending.delay(plan.delay)
  }

  await pending.dispatch()
  return createBaseResult(context, input.channels)
}

async function deferDispatchUntilCommit(
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
  channels: readonly string[],
  callback: () => Promise<Readonly<BroadcastSendResult>>,
): Promise<Readonly<BroadcastSendResult> | null> {
  const dbModule = await loadDbModule()
  const active = dbModule?.connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return null
  }

  active.afterCommit(async () => {
    await callback()
  })

  return createBaseResult(context, channels)
}

async function deliverResolvedRawBroadcast(
  input: ResolvedRawBroadcastSendInput,
  driver: ResolvedDriver,
  context: BroadcastDriverExecutionContext & { readonly messageId: string },
): Promise<Readonly<BroadcastSendResult>> {
  const frozenInput = Object.freeze({
    connection: input.connection,
    event: input.event,
    channels: Object.freeze([...input.channels]),
    payload: input.payload,
    ...(typeof input.socketId === 'undefined' ? {} : { socketId: input.socketId }),
  }) satisfies ResolvedRawBroadcastSendInput
  const result = await driver.implementation.send(frozenInput, context)
  return normalizeDriverResult(result, context, frozenInput.channels)
}

async function executeResolvedRawBroadcast(
  input: ResolvedRawBroadcastSendInput,
  definition: BroadcastDefinition | null,
  options: Readonly<MutableDispatchOptions>,
): Promise<Readonly<BroadcastSendResult>> {
  const driver = resolveDriver(input.connection)
  const plan = resolveQueuePlan(definition, options)
  const context = createExecutionContext(randomUUID(), driver, plan.queued)

  if (plan.afterCommit) {
    const deferred = await deferDispatchUntilCommit(
      createExecutionContext(context.messageId, driver, plan.queued, true),
      input.channels,
      async () => {
        if (plan.queued) {
          return await dispatchQueuedBroadcast(
            input,
            createExecutionContext(context.messageId, driver, true),
            plan,
          )
        }

        return await deliverResolvedRawBroadcast(
          input,
          driver,
          createExecutionContext(context.messageId, driver, false),
        )
      },
    )

    if (deferred) {
      return deferred
    }
  }

  if (plan.queued) {
    return await dispatchQueuedBroadcast(
      input,
      createExecutionContext(context.messageId, driver, true),
      plan,
    )
  }

  return await deliverResolvedRawBroadcast(
    input,
    driver,
    createExecutionContext(context.messageId, driver, false),
  )
}

class PendingDispatch implements PendingBroadcastDispatch<BroadcastSendResult> {
  #promise?: Promise<BroadcastSendResult>

  constructor(
    private readonly executor: (options: Readonly<MutableDispatchOptions>) => Promise<Readonly<BroadcastSendResult>>,
    private readonly options: MutableDispatchOptions = {},
  ) {}

  using(name: string): PendingDispatch {
    this.options.broadcaster = normalizeRequiredString(name, 'Broadcast connection')
    return this
  }

  onConnection(name: string): PendingDispatch {
    this.options.connection = normalizeRequiredString(name, 'Broadcast queue connection')
    return this
  }

  onQueue(name: string): PendingDispatch {
    this.options.queue = normalizeRequiredString(name, 'Broadcast queue name')
    return this
  }

  delay(value: BroadcastDelayValue): PendingDispatch {
    this.options.delay = normalizeDelayValue(value, 'Broadcast delay')
    return this
  }

  afterCommit(): PendingDispatch {
    this.options.afterCommit = true
    return this
  }

  then<TResult1 = BroadcastSendResult, TResult2 = never>(
    onfulfilled?: ((value: BroadcastSendResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<BroadcastSendResult | TResult1> {
    return this.execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<BroadcastSendResult> {
    return this.execute().finally(onfinally ?? undefined)
  }

  private execute(): Promise<BroadcastSendResult> {
    if (!this.#promise) {
      this.#promise = this.executor(normalizeDispatchOptions(this.options))
    }

    return this.#promise
  }
}

export function configureBroadcastRuntime(bindings?: BroadcastRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function getBroadcastRuntimeBindings(): BroadcastRuntimeBindings {
  return getRuntimeBindings()
}

export function resetBroadcastRuntime(): void {
  const state = getRuntimeState()
  state.bindings = undefined
  state.loadQueueModule = undefined
  state.loadDbModule = undefined
  state.queueJobRegistration = undefined
}

export function broadcast(
  definition: BroadcastDefinition | BroadcastDefinitionInput,
): PendingBroadcastDispatch<BroadcastSendResult> {
  return new PendingDispatch(async (options) => {
    const resolvedDefinition = resolveBroadcastDefinition(definition)
    const raw = createRawInputFromDefinition(resolvedDefinition, options.broadcaster)
    const input: BroadcastSendInput = Object.freeze({
      broadcast: resolvedDefinition,
      raw,
      options,
    })

    void input
    return await executeResolvedRawBroadcast(raw, resolvedDefinition, options)
  })
}

export function broadcastRaw(
  input: RawBroadcastSendInput,
): PendingBroadcastDispatch<BroadcastSendResult> {
  return new PendingDispatch(async (options) => {
    const resolvedInput = normalizeRawBroadcastInput(input, options.broadcaster)
    return await executeResolvedRawBroadcast(resolvedInput, null, options)
  })
}

export function getBroadcastRuntime(): BroadcastRuntimeFacade {
  return Object.freeze({
    broadcast,
    broadcastRaw,
  })
}

export const broadcastRuntimeInternals = {
  createRawInputFromDefinition,
  ensureBroadcastQueueJobRegistered,
  normalizeDelayValue,
  normalizeRawBroadcastInput,
  resolveBroadcastConnection,
  resolveDriver,
  resolveQueuePlan,
  resetBroadcastRuntime,
  async runQueuedBroadcastDelivery(payload: QueuedBroadcastPayload) {
    return await runQueuedBroadcastDelivery(payload)
  },
  setLoadDbModuleForTesting(loader?: () => Promise<DbModule | null>): void {
    getRuntimeState().loadDbModule = loader
  },
  setLoadQueueModuleForTesting(loader?: () => Promise<QueueModule>): void {
    getRuntimeState().loadQueueModule = loader
  },
}
