import {
  defineJob,
  dispatch as dispatchQueueJob,
  getRegisteredQueueJob,
  registerQueueJob,
  type QueueJobDefinition,
  type QueueJsonValue,
} from '@holo-js/queue'
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

export function ensureEventsQueueJobRegistered(): void {
  if (getRegisteredQueueJob(EVENTS_INVOKE_LISTENER_JOB)) {
    return
  }

  registerQueueJob(defineJob({
    async handle(payload: EventsInvokeListenerPayload) {
      await runQueuedListenerInvocation(payload)
    },
  }), {
    name: EVENTS_INVOKE_LISTENER_JOB,
  })
}

export async function dispatchQueuedListenerViaQueue(
  dispatch: EventQueuedListenerDispatch,
): Promise<void> {
  ensureEventsQueueJobRegistered()

  let pending = dispatchQueueJob(EVENTS_INVOKE_LISTENER_JOB, {
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
  requireQueuedListener,
}
