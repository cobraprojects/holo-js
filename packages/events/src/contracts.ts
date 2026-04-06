export type EventDelayValue = number | Date

const HOLO_EVENT_DEFINITION_MARKER = Symbol.for('holo-js.events.definition')
const HOLO_LISTENER_DEFINITION_MARKER = Symbol.for('holo-js.events.listener')

function normalizeOptionalString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Events] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeOptionalBoolean(
  value: boolean | undefined,
  label: string,
): boolean | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value !== 'boolean') {
    throw new Error(`[Holo Events] ${label} must be a boolean when provided.`)
  }

  return value
}

function normalizeOptionalDelay(
  value: EventDelayValue | undefined,
): EventDelayValue | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('[Holo Events] Listener delay must be a finite number greater than or equal to 0.')
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('[Holo Events] Listener delay dates must be valid Date instances.')
  }

  return value
}

function toPosixPath(value: string): string {
  return value.replaceAll('\\', '/')
}

function deriveEventNameFromSourcePath(sourcePath: string): string {
  const normalized = toPosixPath(sourcePath).replace(/\.[^.]+$/, '')
  const eventRootIndex = normalized.lastIndexOf('/events/')
  const relevant = eventRootIndex >= 0
    ? normalized.slice(eventRootIndex + '/events/'.length)
    : normalized

  const derived = relevant
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived event names require a non-empty source path.')
  }

  return derived
}

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function hasEventDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_EVENT_DEFINITION_MARKER in value
}

function hasListenerDefinitionMarker(value: unknown): boolean {
  return !!value && typeof value === 'object' && HOLO_LISTENER_DEFINITION_MARKER in value
}

export interface EventDefinition<
  TPayload = unknown,
  TName extends string | undefined = string | undefined,
> {
  readonly name?: TName
  readonly __payloadType?: TPayload
}

export interface RegisteredEvent<
  TPayload = unknown,
  TName extends string = string,
> {
  readonly name: TName
  readonly sourcePath?: string
  readonly definition: EventDefinition<TPayload, TName>
}

export interface EventEnvelope<
  TName extends string = string,
  TPayload = unknown,
> {
  readonly name: TName
  readonly payload: TPayload
  readonly occurredAt: number
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloEventRegistry {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloListenerRegistry {}

type KnownEventName = Extract<keyof HoloEventRegistry, string>

type ResolveRegisteredEventDefinition<TEventName extends string>
  = TEventName extends KnownEventName
    ? Extract<HoloEventRegistry[TEventName], EventDefinition> extends never
      ? EventDefinition<unknown, TEventName>
      : Extract<HoloEventRegistry[TEventName], EventDefinition>
    : EventDefinition<unknown, TEventName>

export type EventPayloadFor<TEventName extends string>
  = ResolveRegisteredEventDefinition<TEventName> extends EventDefinition<infer TPayload, string | undefined>
    ? TPayload
    : unknown

export type ExportedEventDefinition<TValue>
  = Extract<TValue, EventDefinition> extends never
    ? EventDefinition
    : Extract<TValue, EventDefinition>

export type EventReference
  = string
  | EventDefinition<unknown, string | undefined>

export type EventReferenceInput
  = EventReference
  | readonly EventReference[]

type NormalizeEventReferenceInput<TInput extends EventReferenceInput>
  = TInput extends readonly EventReference[]
    ? TInput
    : readonly [TInput]

export type EventEnvelopeFor<TReference>
  = TReference extends EventDefinition<infer TPayload, infer TName>
    ? EventEnvelope<Extract<TName, string> extends never ? string : Extract<TName, string>, TPayload>
    : TReference extends string
      ? EventEnvelope<TReference, EventPayloadFor<TReference>>
      : never

export type ListenerHandledEvent<TInput extends EventReferenceInput>
  = EventEnvelopeFor<NormalizeEventReferenceInput<TInput>[number]>

export interface ListenerDefinition<
  TInput extends EventReferenceInput = EventReferenceInput,
  TResult = unknown,
> {
  readonly name?: string
  readonly listensTo: NormalizeEventReferenceInput<TInput>
  readonly queue?: boolean
  readonly connection?: string
  readonly queueName?: string
  readonly delay?: EventDelayValue
  readonly afterCommit?: boolean
  handle(event: ListenerHandledEvent<TInput>): TResult | Promise<TResult>
}

export interface RegisteredListener<
  TInput extends EventReferenceInput = EventReferenceInput,
  TResult = unknown,
> {
  readonly id: string
  readonly sourcePath?: string
  readonly eventNames: readonly string[]
  readonly definition: ListenerDefinition<TInput, TResult>
}

export interface EventDispatchResult {
  readonly eventName: string
  readonly occurredAt: number
  readonly deferred: boolean
  readonly syncListeners: number
  readonly queuedListeners: number
}

export interface RegisterEventOptions {
  readonly name?: string
  readonly sourcePath?: string
  readonly replaceExisting?: boolean
}

export interface RegisterListenerOptions {
  readonly id?: string
  readonly sourcePath?: string
  readonly replaceExisting?: boolean
}

export interface EventPendingDispatch<TPayload = unknown> extends PromiseLike<EventDispatchResult> {
  afterCommit(): EventPendingDispatch<TPayload>
  onConnection(name: string): EventPendingDispatch<TPayload>
  onQueue(name: string): EventPendingDispatch<TPayload>
  delay(value: EventDelayValue): EventPendingDispatch<TPayload>
  dispatch(): Promise<EventDispatchResult>
  then<TResult1 = EventDispatchResult, TResult2 = never>(
    onfulfilled?: ((value: EventDispatchResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<EventDispatchResult | TResult>
  finally(onfinally?: (() => void) | null): Promise<EventDispatchResult>
}

export interface EventQueuedListenerDispatch {
  readonly listenerId: string
  readonly event: EventEnvelope
  readonly connection?: string
  readonly queueName?: string
  readonly delay?: EventDelayValue
}

export interface EventDeferredDispatchContext {
  readonly eventName: string
  readonly afterCommit: boolean
}

export interface EventRuntimeHooks {
  dispatchQueuedListener?(dispatch: EventQueuedListenerDispatch): void | Promise<void>
  defer?(callback: () => Promise<void>, context: EventDeferredDispatchContext): boolean
}

export interface EventRuntimeBinding {
  readonly hooks: Readonly<EventRuntimeHooks>
}

export interface EventFacade {
  dispatch<TEventName extends KnownEventName>(
    event: TEventName,
    payload: EventPayloadFor<TEventName>,
  ): EventPendingDispatch<EventPayloadFor<TEventName>>
  dispatch<TPayload, TName extends string | undefined = string | undefined>(
    event: EventDefinition<TPayload, TName>,
    payload: TPayload,
  ): EventPendingDispatch<TPayload>
  dispatch<TPayload = unknown>(
    event: string,
    payload: TPayload,
  ): EventPendingDispatch<TPayload>
}

export function isEventDefinition(value: unknown): value is EventDefinition {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeEventDefinition<TEvent extends EventDefinition>(event: TEvent): TEvent {
  if (!isEventDefinition(event)) {
    throw new Error('[Holo Events] Events must be plain objects.')
  }

  return {
    ...event,
    ...(typeof event.name === 'undefined' ? {} : { name: normalizeOptionalString(event.name, 'Event name') }),
  } as TEvent
}

export function defineEvent<TPayload, TName extends string | undefined = string | undefined>(
  event: EventDefinition<TPayload, TName>,
): EventDefinition<TPayload, TName> {
  const normalized = { ...normalizeEventDefinition(event) }
  Object.defineProperty(normalized, HOLO_EVENT_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })
  return Object.freeze(normalized)
}

function normalizeEventReference(
  value: EventReference,
  index: number,
): EventReference {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) {
      throw new Error(`[Holo Events] Listener event reference at index ${index} must be a non-empty string.`)
    }

    return normalized
  }

  if (!isEventDefinition(value)) {
    throw new Error(`[Holo Events] Listener event reference at index ${index} must be an event definition or string.`)
  }

  return Object.freeze(normalizeEventDefinition(value))
}

function normalizeListensTo<TInput extends EventReferenceInput>(
  input: TInput,
): NormalizeEventReferenceInput<TInput> {
  const entries = isReadonlyArray(input) ? input : [input]
  if (entries.length === 0) {
    throw new Error('[Holo Events] Listeners must listen to at least one event.')
  }

  return Object.freeze(entries.map((entry, index) => normalizeEventReference(entry as EventReference, index))) as NormalizeEventReferenceInput<TInput>
}

export function isListenerDefinition(value: unknown): value is ListenerDefinition {
  return value !== null
    && typeof value === 'object'
    && 'listensTo' in value
    && 'handle' in value
    && typeof (value as { handle?: unknown }).handle === 'function'
}

export function normalizeListenerDefinition<
  TInput extends EventReferenceInput,
  TListener extends ListenerDefinition<TInput>,
>(listener: TListener): TListener {
  if (!isListenerDefinition(listener)) {
    throw new Error('[Holo Events] Listeners must define "listensTo" and a "handle" function.')
  }

  const queue = normalizeOptionalBoolean(listener.queue, 'Listener queue')
  const connection = normalizeOptionalString(listener.connection, 'Listener connection')
  const queueName = normalizeOptionalString(listener.queueName, 'Listener queue name')
  const delay = normalizeOptionalDelay(listener.delay)
  const afterCommit = normalizeOptionalBoolean(listener.afterCommit, 'Listener afterCommit')

  if (queue !== true && (connection || queueName || typeof delay !== 'undefined')) {
    throw new Error('[Holo Events] Listener queue metadata requires queue: true.')
  }

  return {
    ...listener,
    ...(typeof listener.name === 'undefined' ? {} : { name: normalizeOptionalString(listener.name, 'Listener name') }),
    listensTo: normalizeListensTo(listener.listensTo),
    ...(typeof queue === 'undefined' ? {} : { queue }),
    ...(typeof connection === 'undefined' ? {} : { connection }),
    ...(typeof queueName === 'undefined' ? {} : { queueName }),
    ...(typeof delay === 'undefined' ? {} : { delay }),
    ...(typeof afterCommit === 'undefined' ? {} : { afterCommit }),
  } as TListener
}

export function defineListener<
  TInput extends EventReferenceInput,
  TListener extends ListenerDefinition<TInput>,
>(listener: TListener): TListener {
  const normalized = normalizeListenerDefinition(listener)
  if (isReadonlyArray(normalized.listensTo)) {
    Object.freeze(normalized.listensTo)
  }
  const tagged = {
    ...normalized,
  }
  Object.defineProperty(tagged, HOLO_LISTENER_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })
  return Object.freeze(tagged)
}

export const eventInternals = {
  hasEventDefinitionMarker,
  hasListenerDefinitionMarker,
  isReadonlyArray,
  deriveEventNameFromSourcePath,
  normalizeEventDefinition,
  normalizeOptionalBoolean,
  normalizeOptionalDelay,
  normalizeOptionalString,
  normalizeListensTo,
  normalizeListenerDefinition,
  toPosixPath,
}
