import type {
  EventDefinition,
  EventDelayValue,
  EventDispatchResult,
  EventEnvelope,
  EventFacade,
  EventPayloadFor,
  EventPendingDispatch,
  EventQueuedListenerDispatch,
  EventRuntimeBinding,
  EventRuntimeHooks,
  ListenerDefinition,
  RegisteredEvent,
  RegisteredListener,
  HoloEventRegistry,
} from './contracts'
import { eventInternals, isEventDefinition } from './contracts'
import { deferEventDispatchToDatabaseCommit } from './db'
import { dispatchQueuedListenerViaQueue } from './queue'
import { getRegisteredEvent, listRegisteredListenersForEvent } from './registry'

type PendingOptions = {
  readonly afterCommit?: true
  readonly connection?: string
  readonly queueName?: string
  readonly delay?: EventDelayValue
}

type EventPayloadValidationState = {
  readonly seen: Set<unknown>
}

type RuntimeState = {
  hooks: EventRuntimeHooks
}

type ListenerExecutionGroups = {
  readonly immediateSyncListeners: readonly RegisteredListener[]
  readonly immediateQueuedListeners: readonly RegisteredListener[]
  readonly deferredSyncListeners: readonly RegisteredListener[]
  readonly deferredQueuedListeners: readonly RegisteredListener[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertEventJsonValue(
  value: unknown,
  path: string,
  state: EventPayloadValidationState,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`[Holo Events] Event payload at "${path}" must be JSON-serializable for queued listeners.`)
    }

    return
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new TypeError(`[Holo Events] Event payload at "${path}" must be JSON-serializable for queued listeners.`)
  }

  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      throw new TypeError(`[Holo Events] Event payload at "${path}" contains a circular reference.`)
    }

    state.seen.add(value)
    for (let index = 0; index < value.length; index += 1) {
      assertEventJsonValue(value[index], `${path}[${index}]`, state)
    }
    state.seen.delete(value)
    return
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`[Holo Events] Event payload at "${path}" must be a plain JSON object, array, or primitive for queued listeners.`)
  }

  if (state.seen.has(value)) {
    throw new TypeError(`[Holo Events] Event payload at "${path}" contains a circular reference.`)
  }

  state.seen.add(value)
  for (const [key, nested] of Object.entries(value)) {
    assertEventJsonValue(nested, `${path}.${key}`, state)
  }
  state.seen.delete(value)
}

function validateQueuedEventPayload<TPayload>(payload: TPayload): void {
  assertEventJsonValue(payload, 'payload', { seen: new Set<unknown>() })
}

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoEventsRuntime__?: RuntimeState
  }

  runtime.__holoEventsRuntime__ ??= {
    hooks: {},
  }

  return runtime.__holoEventsRuntime__
}

function createRuntimeBinding(state: RuntimeState): EventRuntimeBinding {
  return Object.freeze({
    hooks: Object.freeze({
      ...state.hooks,
    }),
  })
}

function normalizeEventName(name: string): string {
  const normalized = name.trim()
  if (!normalized) {
    throw new Error('[Holo Events] Event names must be non-empty strings.')
  }

  return normalized
}

function resolveDispatchedEventName<TPayload>(
  event: string | EventDefinition<TPayload, string | undefined>,
): string {
  if (typeof event === 'string') {
    return normalizeEventName(event)
  }

  if (!isEventDefinition(event)) {
    throw new Error('[Holo Events] Events must be plain objects.')
  }

  const explicitName = event.name?.trim()
  if (!explicitName) {
    throw new Error('[Holo Events] Dispatching an event definition requires an explicit event name.')
  }

  return explicitName
}

function requireRegisteredEvent(name: string): RegisteredEvent {
  const registered = getRegisteredEvent(name)
  if (!registered) {
    throw new Error(`[Holo Events] Event "${name}" is not registered.`)
  }

  return registered
}

function createEventEnvelope<TPayload>(
  eventName: string,
  payload: TPayload,
  occurredAt = Date.now(),
): EventEnvelope<string, TPayload> {
  return Object.freeze({
    name: eventName,
    payload,
    occurredAt,
  })
}

function splitRegisteredListeners(
  listeners: readonly RegisteredListener[],
): {
  readonly syncListeners: readonly RegisteredListener[]
  readonly queuedListeners: readonly RegisteredListener[]
} {
  const syncListeners: RegisteredListener[] = []
  const queuedListeners: RegisteredListener[] = []

  for (const listener of listeners) {
    if (listener.definition.queue === true) {
      queuedListeners.push(listener)
      continue
    }

    syncListeners.push(listener)
  }

  return Object.freeze({
    syncListeners: Object.freeze(syncListeners),
    queuedListeners: Object.freeze(queuedListeners),
  })
}

async function executeSyncListeners<TPayload>(
  listeners: readonly RegisteredListener[],
  event: EventEnvelope<string, TPayload>,
): Promise<number> {
  for (const listener of listeners) {
    await executeListener(listener, event)
  }

  return listeners.length
}

async function executeListenerGroups<TPayload>(
  syncListeners: readonly RegisteredListener[],
  queuedListeners: readonly RegisteredListener[],
  event: EventEnvelope<string, TPayload>,
  options: PendingOptions,
): Promise<{
  readonly syncCount: number
  readonly queuedCount: number
}> {
  const syncCount = await executeSyncListeners(syncListeners, event)
  const queuedCount = await dispatchQueuedListeners(queuedListeners, event, options)

  return Object.freeze({
    syncCount,
    queuedCount,
  })
}

async function executeListener<TPayload>(
  listener: RegisteredListener,
  event: EventEnvelope<string, TPayload>,
): Promise<void> {
  await (listener.definition as ListenerDefinition).handle(event)
}

function createQueuedListenerDispatch(
  listener: RegisteredListener,
  event: EventEnvelope,
  options: PendingOptions,
): EventQueuedListenerDispatch {
  return Object.freeze({
    listenerId: listener.id,
    event,
    ...(typeof (options.connection ?? listener.definition.connection) === 'undefined'
      ? {}
      : { connection: options.connection ?? listener.definition.connection }),
    ...(typeof (options.queueName ?? listener.definition.queueName) === 'undefined'
      ? {}
      : { queueName: options.queueName ?? listener.definition.queueName }),
    ...(typeof (options.delay ?? listener.definition.delay) === 'undefined'
      ? {}
      : { delay: options.delay ?? listener.definition.delay }),
  })
}

async function dispatchQueuedListeners<TPayload>(
  listeners: readonly RegisteredListener[],
  event: EventEnvelope<string, TPayload>,
  options: PendingOptions,
): Promise<number> {
  if (listeners.length === 0) {
    return 0
  }

  validateQueuedEventPayload(event.payload)
  const dispatcher = getRuntimeState().hooks.dispatchQueuedListener ?? dispatchQueuedListenerViaQueue

  for (const listener of listeners) {
    await dispatcher(createQueuedListenerDispatch(listener, event, options))
  }

  return listeners.length
}

function splitListenersForExecution(
  listeners: readonly RegisteredListener[],
  forceAfterCommit: boolean,
): ListenerExecutionGroups {
  const immediateSyncListeners: RegisteredListener[] = []
  const immediateQueuedListeners: RegisteredListener[] = []
  const deferredSyncListeners: RegisteredListener[] = []
  const deferredQueuedListeners: RegisteredListener[] = []

  for (const listener of listeners) {
    const shouldDefer = forceAfterCommit || listener.definition.afterCommit === true
    if (shouldDefer) {
      if (listener.definition.queue === true) {
        deferredQueuedListeners.push(listener)
        continue
      }

      deferredSyncListeners.push(listener)
      continue
    }

    if (listener.definition.queue === true) {
      immediateQueuedListeners.push(listener)
      continue
    }

    immediateSyncListeners.push(listener)
  }

  return Object.freeze({
    immediateSyncListeners: Object.freeze(immediateSyncListeners),
    immediateQueuedListeners: Object.freeze(immediateQueuedListeners),
    deferredSyncListeners: Object.freeze(deferredSyncListeners),
    deferredQueuedListeners: Object.freeze(deferredQueuedListeners),
  })
}

function scheduleDeferredDispatch(
  callback: () => Promise<void>,
  eventName: string,
): boolean {
  const defer = getRuntimeState().hooks.defer ?? deferEventDispatchToDatabaseCommit
  return defer(callback, {
    eventName,
    afterCommit: true,
  })
}

async function executeDispatch<TPayload>(
  event: string | EventDefinition<TPayload, string | undefined>,
  payload: TPayload,
  options: PendingOptions = {},
): Promise<EventDispatchResult> {
  const eventName = resolveDispatchedEventName(event)
  requireRegisteredEvent(eventName)
  const envelope = createEventEnvelope(eventName, payload)
  const listeners = listRegisteredListenersForEvent(eventName)
  const groups = splitListenersForExecution(listeners, options.afterCommit === true)

  if (options.afterCommit) {
    const scheduled = scheduleDeferredDispatch(async () => {
      await executeListenerGroups(
        [...groups.immediateSyncListeners, ...groups.deferredSyncListeners],
        [...groups.immediateQueuedListeners, ...groups.deferredQueuedListeners],
        envelope,
        options,
      )
    }, eventName)

    if (scheduled) {
      return Object.freeze({
        eventName,
        occurredAt: envelope.occurredAt,
        deferred: true,
        syncListeners: groups.immediateSyncListeners.length + groups.deferredSyncListeners.length,
        queuedListeners: groups.immediateQueuedListeners.length + groups.deferredQueuedListeners.length,
      })
    }
  }

  const immediate = await executeListenerGroups(
    groups.immediateSyncListeners,
    groups.immediateQueuedListeners,
    envelope,
    options,
  )

  let deferred = false
  if (groups.deferredSyncListeners.length > 0 || groups.deferredQueuedListeners.length > 0) {
    const scheduled = scheduleDeferredDispatch(async () => {
      await executeListenerGroups(
        groups.deferredSyncListeners,
        groups.deferredQueuedListeners,
        envelope,
        options,
      )
    }, eventName)

    if (scheduled) {
      deferred = true
    } else {
      await executeListenerGroups(
        groups.deferredSyncListeners,
        groups.deferredQueuedListeners,
        envelope,
        options,
      )
    }
  }

  return Object.freeze({
    eventName,
    occurredAt: envelope.occurredAt,
    deferred,
    syncListeners: immediate.syncCount + groups.deferredSyncListeners.length,
    queuedListeners: immediate.queuedCount + groups.deferredQueuedListeners.length,
  })
}

class PendingEventDispatch<TPayload> implements EventPendingDispatch<TPayload> {
  private readonly options: PendingOptions
  private executionPromise?: Promise<EventDispatchResult>

  constructor(
    private readonly event: string | EventDefinition<TPayload, string | undefined>,
    private readonly payload: TPayload,
    options: PendingOptions = {},
  ) {
    this.options = options
  }

  afterCommit(): EventPendingDispatch<TPayload> {
    return new PendingEventDispatch(this.event, this.payload, {
      ...this.options,
      afterCommit: true,
    })
  }

  onConnection(name: string): EventPendingDispatch<TPayload> {
    return new PendingEventDispatch(this.event, this.payload, {
      ...this.options,
      connection: eventInternals.normalizeOptionalString(name, 'Dispatch connection'),
    })
  }

  onQueue(name: string): EventPendingDispatch<TPayload> {
    return new PendingEventDispatch(this.event, this.payload, {
      ...this.options,
      queueName: eventInternals.normalizeOptionalString(name, 'Dispatch queue name'),
    })
  }

  delay(value: EventDelayValue): EventPendingDispatch<TPayload> {
    eventInternals.normalizeOptionalDelay(value)
    return new PendingEventDispatch(this.event, this.payload, {
      ...this.options,
      delay: value,
    })
  }

  async dispatch(): Promise<EventDispatchResult> {
    return this.execute()
  }

  then<TResult1 = EventDispatchResult, TResult2 = never>(
    onfulfilled?: ((value: EventDispatchResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<EventDispatchResult | TResult> {
    return this.execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<EventDispatchResult> {
    return this.execute().finally(onfinally ?? undefined)
  }

  private execute(): Promise<EventDispatchResult> {
    this.executionPromise ??= executeDispatch(this.event, this.payload, this.options)
    return this.executionPromise
  }
}

export function configureEventsRuntime(hooks: EventRuntimeHooks = {}): void {
  getRuntimeState().hooks = {
    ...hooks,
  }
}

export function getEventsRuntime(): EventRuntimeBinding {
  return createRuntimeBinding(getRuntimeState())
}

export function resetEventsRuntime(): void {
  getRuntimeState().hooks = {}
}

export function dispatchEvent<TEventName extends Extract<keyof HoloEventRegistry, string>>(
  event: TEventName,
  payload: EventPayloadFor<TEventName>,
): EventPendingDispatch<EventPayloadFor<TEventName>>
export function dispatchEvent<TPayload, TName extends string | undefined = string | undefined>(
  event: EventDefinition<TPayload, TName>,
  payload: TPayload,
): EventPendingDispatch<TPayload>
export function dispatchEvent<TPayload = unknown>(
  event: string,
  payload: TPayload,
): EventPendingDispatch<TPayload>
export function dispatchEvent<TPayload>(
  event: string | EventDefinition<TPayload, string | undefined>,
  payload: TPayload,
): EventPendingDispatch<TPayload> {
  return new PendingEventDispatch(event, payload)
}

export const Event: EventFacade = {
  dispatch: dispatchEvent,
}

export const eventRuntimeInternals = {
  assertEventJsonValue,
  createEventEnvelope,
  createQueuedListenerDispatch,
  createRuntimeBinding,
  dispatchQueuedListeners,
  executeListenerGroups,
  executeDispatch,
  executeListener,
  executeSyncListeners,
  getRuntimeState,
  isPlainObject,
  normalizeEventName,
  requireRegisteredEvent,
  resolveDispatchedEventName,
  scheduleDeferredDispatch,
  splitRegisteredListeners,
  splitListenersForExecution,
  validateQueuedEventPayload,
}
