import { createSubscriber } from 'svelte/reactivity'
import {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  createBroadcastRealtimeTransport,
  getRealtimeQueryStore,
} from '@holo-js/realtime/client'
import {
  mutation as createRealtimeMutation,
  query as createRealtimeQuery,
} from '@holo-js/realtime'
import type {
  RealtimeArgsFor,
  RealtimeQueryDefinition,
  RealtimeResultFor,
} from '@holo-js/realtime'
import { normalizeSvelteKitClientHttpError, renderSvelteKitClientHttpErrorPage } from './client-errors'
import { createReactiveView } from './reactive-view'

function emitRealtimeError(error: unknown): void {
  const httpError = normalizeSvelteKitClientHttpError(error)

  if (httpError) {
    renderSvelteKitClientHttpErrorPage(httpError)
  }
}

export const query = createRealtimeQuery

export const mutation = createRealtimeMutation

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isReactiveObject(value: unknown): value is object {
  return Array.isArray(value) || isPlainObject(value)
}

function createRealtimeReactiveValue<TValue>(value: TValue, subscribe: () => void): TValue {
  if (value === undefined) {
    return createReactiveView([], subscribe, new WeakMap<object, object>(), {
      preserveArrayLengthDescriptor: true,
      shouldWrapValue: isReactiveObject,
    }) as TValue
  }

  if (Array.isArray(value)) {
    return createReactiveView([...value], subscribe, new WeakMap<object, object>(), {
      preserveArrayLengthDescriptor: true,
      shouldWrapValue: isReactiveObject,
    }) as TValue
  }

  if (isPlainObject(value)) {
    return createReactiveView({ ...value }, subscribe, new WeakMap<object, object>(), {
      preserveArrayLengthDescriptor: true,
      shouldWrapValue: isReactiveObject,
    }) as TValue
  }

  return value
}

function replaceRealtimeReactiveValue<TValue>(target: TValue, value: TValue): TValue {
  if (Array.isArray(target) && Array.isArray(value)) {
    target.splice(0, target.length, ...value)
    return target
  }

  if (Array.isArray(target) && isPlainObject(value)) {
    target.splice(0, target.length)
    for (const key of Object.keys(target)) {
      if (!(key in value)) {
        delete (target as Record<string, unknown>)[key]
      }
    }

    Object.assign(target, value)
    return target
  }

  if (isPlainObject(target) && isPlainObject(value)) {
    for (const key of Object.keys(target)) {
      if (!(key in value)) {
        delete target[key]
      }
    }

    Object.assign(target, value)
    return target
  }

  return value
}

function connectRealtimeStoreInBrowser(store: { connect(): void }, browser: boolean): void {
  if (browser) {
    store.connect()
  }
}

function useReactiveRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> {
  const store = getRealtimeQueryStore(definition, args)
  const subscribe = createSubscriber((update) => {
    const unsubscribe = store.subscribe(() => {
      const nextData = store.snapshot?.data
      if (typeof nextData !== 'undefined') {
        current = replaceRealtimeReactiveValue(current, nextData)
      }
      update()
    })
    return unsubscribe
  })
  let current = createRealtimeReactiveValue(
    store.snapshot?.data as RealtimeResultFor<TDefinition>,
    subscribe,
  )
  connectRealtimeStoreInBrowser(store, 'window' in globalThis)
  return current
}

configureRealtimeClientRuntime({
  handleError: emitRealtimeError,
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createBroadcastRealtimeTransport())

export const svelteRealtimeInternals = {
  createRealtimeReactiveValue,
  connectRealtimeStoreInBrowser,
  emitRealtimeError,
  isPlainObject,
  isReactiveObject,
  replaceRealtimeReactiveValue,
}

export {}
