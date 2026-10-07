import { createRequire } from 'node:module'
import type { QueueJobDefinition, QueueJsonValue, QueueRegisteredJob } from '@holo-js/queue'
import type { EventQueuedListenerDispatch, EventEnvelope, RegisteredListener } from './contracts'
import { getRegisteredListener } from './registry'

export const EVENTS_INVOKE_LISTENER_JOB = 'holo.events.invoke-listener'

export type EventsInvokeListenerPayload = Readonly<Record<string, QueueJsonValue>> & Readonly<{
  readonly listenerId: string
  readonly eventName: string
  readonly occurredAt: number
  readonly payload: QueueJsonValue
}>

declare module '@holo-js/queue' {
  interface HoloQueueJobRegistry {
    'holo.events.invoke-listener': QueueJobDefinition<EventsInvokeListenerPayload, void>
  }
}

type QueueModule = {
  defineJob(definition: QueueJobDefinition<EventsInvokeListenerPayload, void>): QueueJobDefinition<EventsInvokeListenerPayload, void>
  dispatch(
    jobName: string,
    payload: EventsInvokeListenerPayload,
  ): QueuePendingDispatchChain
  getRegisteredQueueJob(name: string): QueueRegisteredJob | undefined
  registerQueueJob(
    definition: QueueJobDefinition<EventsInvokeListenerPayload, void>,
    options: { name: string },
  ): void
}

type QueuePendingDispatchChain = {
  onConnection(name: string): QueuePendingDispatchChain
  onQueue(name: string): QueuePendingDispatchChain
  delay(value: number | Date): QueuePendingDispatchChain
  dispatch(): Promise<unknown>
}

const require = createRequire(import.meta.url)
const queueSpecifier = '@holo-js/queue'

function rethrowQueueLoadError(error: unknown): never {
  if (
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
  ) {
    throw new Error('[@holo-js/events] Queued listeners require @holo-js/queue to be installed.')
  }

  throw error
}

function loadQueueModuleSync(): QueueModule {
  try {
    return require(queueSpecifier) as QueueModule
  } catch (error) {
    return rethrowQueueLoadError(error)
  }
}

async function loadQueueModule(): Promise<QueueModule> {
  try {
    return await import(queueSpecifier) as QueueModule
  } catch (error) {
    return rethrowQueueLoadError(error)
  }
}

function createQueuedListenerEventEnvelope(
  payload: EventsInvokeListenerPayload,
): EventEnvelope<string, QueueJsonValue> {
  return Object.freeze({
    name: payload.eventName,
    payload: payload.payload,
    occurredAt: payload.occurredAt,
  })
}

function requireQueuedListener(listenerId: string): RegisteredListener {
  const listener = getRegisteredListener(listenerId)
  if (!listener) {
    throw new Error(`[Holo Events] Queued listener "${listenerId}" is not registered.`)
  }

  return listener
}

function assertQueuedListenerMatchesEvent(
  listener: RegisteredListener,
  eventName: string,
): void {
  if (!listener.eventNames.includes(eventName)) {
    throw new Error(
      `[Holo Events] Queued listener "${listener.id}" is not registered for event "${eventName}".`,
    )
  }
}

export async function runQueuedListenerInvocation(
  payload: EventsInvokeListenerPayload,
): Promise<void> {
  const listener = requireQueuedListener(payload.listenerId)
  assertQueuedListenerMatchesEvent(listener, payload.eventName)
  await listener.definition.handle(createQueuedListenerEventEnvelope(payload))
}

function registerEventsQueueJob(queue: QueueModule): void {
  if (queue.getRegisteredQueueJob(EVENTS_INVOKE_LISTENER_JOB)) {
    return
  }

  queue.registerQueueJob({
    handle: runQueuedListenerInvocation,
  }, { name: EVENTS_INVOKE_LISTENER_JOB })
}

export function ensureEventsQueueJobRegistered(): void {
  registerEventsQueueJob(loadQueueModuleSync())
}

export async function ensureEventsQueueJobRegisteredAsync(): Promise<void> {
  registerEventsQueueJob(await loadQueueModule())
}

export async function dispatchQueuedListenerViaQueue(
  dispatch: EventQueuedListenerDispatch,
): Promise<void> {
  const queueModule = await loadQueueModule()
  registerEventsQueueJob(queueModule)

  let pending = queueModule.dispatch(EVENTS_INVOKE_LISTENER_JOB, {
    listenerId: dispatch.listenerId,
    eventName: dispatch.event.name,
    occurredAt: dispatch.event.occurredAt,
    payload: dispatch.event.payload as QueueJsonValue,
  })

  if (typeof dispatch.connection !== 'undefined') {
    pending = pending.onConnection(dispatch.connection)
  }

  if (typeof dispatch.queueName !== 'undefined') {
    pending = pending.onQueue(dispatch.queueName)
  }

  if (typeof dispatch.delay !== 'undefined') {
    pending = pending.delay(dispatch.delay)
  }

  await pending.dispatch()
}

export const eventQueueInternals = {
  assertQueuedListenerMatchesEvent,
  createQueuedListenerEventEnvelope,
  loadQueueModule,
  requireQueuedListener,
}
