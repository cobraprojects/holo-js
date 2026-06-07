import { createSubscriber } from 'svelte/reactivity'
import {
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  createBroadcastRealtimeTransport,
  getRealtimeQueryStore,
} from '@holo-js/realtime/client'
import type { RealtimeArgsFor, RealtimeQueryDefinition, RealtimeResultFor } from '@holo-js/realtime'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function createReactiveView<TValue extends object>(
  target: TValue,
  subscribe: () => void,
  cache: WeakMap<object, object>,
): TValue {
  const cached = cache.get(target)
  if (cached) {
    return cached as TValue
  }

  const proxy = new Proxy(Array.isArray(target) ? [] : {}, {
    get(_shell, key) {
      subscribe()
      const value = Reflect.get(target, key, target)
      if (!value || typeof value !== 'object' || value instanceof Date || value instanceof Blob) {
        return value
      }

      return createReactiveView(value as object, subscribe, cache)
    },
    set(_shell, key, value) {
      return Reflect.set(target, key, value)
    },
    ownKeys() {
      subscribe()
      return Reflect.ownKeys(target)
    },
    getOwnPropertyDescriptor(_shell, key) {
      subscribe()
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)

      if (!descriptor) {
        return undefined
      }

      if (Array.isArray(target) && key === 'length') {
        return descriptor
      }

      return {
        ...descriptor,
        configurable: true,
      }
    },
    has(_shell, key) {
      subscribe()
      return Reflect.has(target, key)
    },
  })

  cache.set(target, proxy)
  return proxy as TValue
}

function createRealtimeReactiveValue<TValue>(value: TValue, subscribe: () => void): TValue {
  if (value === undefined) {
    return createReactiveView([], subscribe, new WeakMap<object, object>()) as TValue
  }

  if (Array.isArray(value)) {
    return createReactiveView([...value], subscribe, new WeakMap<object, object>()) as TValue
  }

  if (isPlainObject(value)) {
    return createReactiveView({ ...value }, subscribe, new WeakMap<object, object>()) as TValue
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

function useReactiveRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> {
  const store = getRealtimeQueryStore(definition, args)
  const subscribe = createSubscriber((update) => {
    const unsubscribe = store.subscribe(() => {
      current = replaceRealtimeReactiveValue(current, store.snapshot?.data as RealtimeResultFor<TDefinition>)
      update()
    })
    return unsubscribe
  })
  let current = createRealtimeReactiveValue(
    store.snapshot?.data as RealtimeResultFor<TDefinition>,
    subscribe,
  )
  if ('window' in globalThis) {
    store.connect()
  }
  return current
}

configureRealtimeClientRuntime({
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createBroadcastRealtimeTransport())

export {}
