import type {
  EventDefinition,
  EventReference,
  EventReferenceInput,
  ListenerDefinition,
  RegisteredEvent,
  RegisteredListener,
  RegisterEventOptions,
  RegisterListenerOptions,
} from './contracts'
import {
  eventInternals,
  isEventDefinition,
  isListenerDefinition,
  normalizeEventDefinition,
  normalizeListenerDefinition,
} from './contracts'

type ListenerRegistrationState = {
  readonly listener: RegisteredListener
  readonly order: number
}

type EventRegistryState = {
  events: Map<string, RegisteredEvent>
  listeners: Map<string, ListenerRegistrationState>
  listenersByEvent: Map<string, ListenerRegistrationState[]>
  nextListenerOrder: number
}

function getEventRegistryState(): EventRegistryState {
  const runtime = globalThis as typeof globalThis & {
    __holoEventRegistry__?: EventRegistryState
  }

  runtime.__holoEventRegistry__ ??= {
    events: new Map<string, RegisteredEvent>(),
    listeners: new Map<string, ListenerRegistrationState>(),
    listenersByEvent: new Map<string, ListenerRegistrationState[]>(),
    nextListenerOrder: 0,
  }

  return runtime.__holoEventRegistry__
}

function deriveListenerIdFromSourcePath(sourcePath: string): string {
  const normalized = eventInternals.toPosixPath(sourcePath).replace(/\.[^.]+$/, '')
  const listenerRootIndex = normalized.lastIndexOf('/listeners/')
  const relevant = listenerRootIndex >= 0
    ? normalized.slice(listenerRootIndex + '/listeners/'.length)
    : normalized

  const derived = relevant
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .join('.')

  if (!derived) {
    throw new Error('[Holo Events] Derived listener identifiers require a non-empty source path.')
  }

  return derived
}

function resolveRegisteredEventName(
  definition: EventDefinition,
  options: RegisterEventOptions = {},
): string {
  const explicitOption = options.name?.trim()
  if (explicitOption) {
    return explicitOption
  }

  const explicitDefinition = definition.name?.trim()
  if (explicitDefinition) {
    return explicitDefinition
  }

  const sourcePath = options.sourcePath?.trim()
  if (sourcePath) {
    return eventInternals.deriveEventNameFromSourcePath(sourcePath)
  }

  throw new Error('[Holo Events] Registered events require an explicit name or a sourcePath-derived name.')
}

function resolveRegisteredListenerId(
  definition: ListenerDefinition,
  options: RegisterListenerOptions = {},
): string {
  const explicitOption = options.id?.trim()
  if (explicitOption) {
    return explicitOption
  }

  const explicitDefinition = definition.name?.trim()
  if (explicitDefinition) {
    return explicitDefinition
  }

  const sourcePath = options.sourcePath?.trim()
  if (sourcePath) {
    return deriveListenerIdFromSourcePath(sourcePath)
  }

  throw new Error('[Holo Events] Registered listeners require an explicit id, listener name, or a sourcePath-derived id.')
}

function resolveListenerEventName(reference: EventReference): string {
  if (typeof reference === 'string') {
    return reference
  }

  const explicitName = reference.name?.trim()
  if (explicitName) {
    return explicitName
  }

  throw new Error('[Holo Events] Listener event references must resolve to explicit event names before registration.')
}

function resolveListenerEventNames(
  definition: ListenerDefinition,
  state: EventRegistryState,
): readonly string[] {
  const names = [...new Set(definition.listensTo.map(resolveListenerEventName))]
  for (const name of names) {
    if (!state.events.has(name)) {
      throw new Error(`[Holo Events] Listener target event "${name}" is not registered.`)
    }
  }

  return Object.freeze(names)
}

function removeListenerFromIndexes(
  state: EventRegistryState,
  entry: ListenerRegistrationState,
): void {
  for (const eventName of entry.listener.eventNames) {
    const indexed = state.listenersByEvent.get(eventName)
    if (!indexed) {
      continue
    }

    const filtered = indexed.filter(candidate => candidate.listener.id !== entry.listener.id)
    if (filtered.length === 0) {
      state.listenersByEvent.delete(eventName)
      continue
    }

    state.listenersByEvent.set(eventName, filtered)
  }
}

function insertListenerIntoIndexes(
  state: EventRegistryState,
  entry: ListenerRegistrationState,
): void {
  for (const eventName of entry.listener.eventNames) {
    const indexed = state.listenersByEvent.get(eventName) ?? []
    state.listenersByEvent.set(eventName, [...indexed, entry].sort((left, right) => left.order - right.order))
  }
}

export function registerEvent<TPayload, TName extends string | undefined = string | undefined>(
  definition: EventDefinition<TPayload, TName>,
  options: RegisterEventOptions = {},
): RegisteredEvent<TPayload, Extract<TName, string> extends never ? string : Extract<TName, string>> {
  if (!isEventDefinition(definition)) {
    throw new Error('[Holo Events] Events must be plain objects.')
  }

  const normalizedDefinition = normalizeEventDefinition(definition)
  const name = resolveRegisteredEventName(normalizedDefinition, options)
  const state = getEventRegistryState()

  if (state.events.has(name) && options.replaceExisting !== true) {
    throw new Error(`[Holo Events] Event "${name}" is already registered.`)
  }

  const entry = Object.freeze({
    name,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    definition: Object.freeze({
      ...normalizedDefinition,
      name,
    }),
  }) as RegisteredEvent<TPayload, Extract<TName, string> extends never ? string : Extract<TName, string>>

  state.events.set(name, entry as RegisteredEvent)
  return entry
}

export function registerEvents(
  definitions: ReadonlyArray<{
    readonly definition: EventDefinition
    readonly options?: RegisterEventOptions
  }>,
): readonly RegisteredEvent[] {
  return Object.freeze(definitions.map((entry) => {
    return registerEvent(entry.definition as EventDefinition<unknown, string>, entry.options)
  }))
}

export function getRegisteredEvent(name: string): RegisteredEvent | undefined {
  return getEventRegistryState().events.get(name)
}

export function listRegisteredEvents(): readonly RegisteredEvent[] {
  return Object.freeze([...getEventRegistryState().events.values()].sort((left, right) => left.name.localeCompare(right.name)))
}

export function unregisterEvent(name: string): boolean {
  const state = getEventRegistryState()
  const listeners = state.listenersByEvent.get(name)
  if (listeners && listeners.length > 0) {
    throw new Error(`[Holo Events] Event "${name}" cannot be unregistered while listeners are registered for it.`)
  }

  return state.events.delete(name)
}

export function registerListener<TInput extends EventReference | readonly EventReference[], TResult>(
  definition: ListenerDefinition<TInput, TResult>,
  options?: RegisterListenerOptions,
): RegisteredListener<TInput, TResult>
export function registerListener(
  definition: ListenerDefinition,
  options: RegisterListenerOptions = {},
): RegisteredListener {
  if (!isListenerDefinition(definition)) {
    throw new Error('[Holo Events] Listeners must define "listensTo" and a "handle" function.')
  }

  const normalizedDefinition = normalizeListenerDefinition(definition)
  const id = resolveRegisteredListenerId(normalizedDefinition, options)
  const state = getEventRegistryState()

  if (state.listeners.has(id) && options.replaceExisting !== true) {
    throw new Error(`[Holo Events] Listener "${id}" is already registered.`)
  }

  const eventNames = resolveListenerEventNames(normalizedDefinition, state)
  const existing = state.listeners.get(id)
  if (existing) {
    removeListenerFromIndexes(state, existing)
  }

  const listener = Object.freeze({
    id,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    eventNames,
    definition: Object.freeze({
      ...normalizedDefinition,
      ...(typeof normalizedDefinition.name === 'undefined' ? {} : { name: normalizedDefinition.name }),
    }),
  }) as RegisteredListener

  const registration: ListenerRegistrationState = {
    listener,
    order: state.nextListenerOrder,
  }
  state.nextListenerOrder += 1
  state.listeners.set(id, registration)
  insertListenerIntoIndexes(state, registration)
  return listener
}

export function registerListeners(
  definitions: ReadonlyArray<{
    readonly definition: ListenerDefinition
    readonly options?: RegisterListenerOptions
  }>,
): readonly RegisteredListener[] {
  return Object.freeze(definitions.map((entry) => {
    return registerListener(entry.definition as ListenerDefinition<EventReferenceInput>, entry.options)
  }))
}

export function getRegisteredListener(id: string): RegisteredListener | undefined {
  return getEventRegistryState().listeners.get(id)?.listener
}

export function listRegisteredListeners(): readonly RegisteredListener[] {
  return Object.freeze(
    [...getEventRegistryState().listeners.values()]
      .sort((left, right) => left.listener.id.localeCompare(right.listener.id))
      .map(entry => entry.listener),
  )
}

/**
 * Listener order for an event is deterministic and follows listener registration order.
 */
export function listRegisteredListenersForEvent(eventName: string): readonly RegisteredListener[] {
  const indexed = getEventRegistryState().listenersByEvent.get(eventName) ?? []
  return Object.freeze(indexed.map(entry => entry.listener))
}

export function unregisterListener(id: string): boolean {
  const state = getEventRegistryState()
  const existing = state.listeners.get(id)
  if (!existing) {
    return false
  }

  removeListenerFromIndexes(state, existing)
  return state.listeners.delete(id)
}

export function resetEventRegistry(): void {
  const state = getEventRegistryState()
  state.events.clear()
  state.listeners.clear()
  state.listenersByEvent.clear()
  state.nextListenerOrder = 0
}

export function resetListenerRegistry(): void {
  const state = getEventRegistryState()
  state.listeners.clear()
  state.listenersByEvent.clear()
  state.nextListenerOrder = 0
}

export function resetEventsRegistry(): void {
  resetEventRegistry()
}

export const eventRegistryInternals = {
  deriveListenerIdFromSourcePath,
  getEventRegistryState,
  resolveListenerEventNames,
  resolveRegisteredEventName,
  resolveRegisteredListenerId,
}
