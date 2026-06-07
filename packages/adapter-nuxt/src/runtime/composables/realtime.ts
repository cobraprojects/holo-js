import { onScopeDispose, reactive } from 'vue'
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

function replaceReactiveObject(target: Record<string, unknown>, value: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in value)) {
      delete target[key]
    }
  }

  Object.assign(target, value)
}

function replaceReactiveArray(target: unknown[], value: readonly unknown[]): void {
  target.splice(0, target.length, ...value)
}

function replaceReactiveArrayObject(target: unknown[], value: Record<string, unknown>): void {
  target.splice(0, target.length)
  for (const key of Object.keys(target)) {
    if (!(key in value)) {
      delete (target as unknown as Record<string, unknown>)[key]
    }
  }

  Object.assign(target, value)
}

function createRealtimeReactiveValue<TValue>(value: TValue): TValue {
  if (value === undefined) {
    return reactive([]) as TValue
  }

  if (Array.isArray(value)) {
    return reactive([...value]) as TValue
  }

  if (isPlainObject(value)) {
    return reactive({ ...value }) as TValue
  }

  return value
}

function replaceRealtimeReactiveValue<TValue>(target: TValue, value: TValue): TValue {
  if (Array.isArray(target) && Array.isArray(value)) {
    replaceReactiveArray(target, value)
    return target
  }

  if (Array.isArray(target) && isPlainObject(value)) {
    replaceReactiveArrayObject(target, value)
    return target
  }

  if (isPlainObject(target) && isPlainObject(value)) {
    replaceReactiveObject(target, value)
    return target
  }

  return value
}

function useReactiveRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> {
  const store = getRealtimeQueryStore(definition, args)
  let current = createRealtimeReactiveValue(store.snapshot?.data) as RealtimeResultFor<TDefinition>
  const unsubscribe = store.subscribe(() => {
    const nextData = store.snapshot?.data
    if (typeof nextData !== 'undefined') {
      current = replaceRealtimeReactiveValue(current, nextData)
    }
  })
  if ('window' in globalThis) {
    store.connect()
  }
  onScopeDispose(unsubscribe)
  return current
}

configureRealtimeClientRuntime({
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createBroadcastRealtimeTransport())

export {}
