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

function createRealtimeReactiveValue<TValue>(value: TValue | undefined): TValue | undefined {
  if (value === undefined) {
    return undefined
  }

  if (Array.isArray(value)) {
    return reactive([...value]) as TValue
  }

  if (isPlainObject(value)) {
    return reactive({ ...value }) as TValue
  }

  return value
}

function replaceRealtimeReactiveValue<TValue>(target: TValue | undefined, value: TValue): TValue {
  if (typeof target === 'undefined') {
    return createRealtimeReactiveValue(value) as TValue
  }

  if (Array.isArray(target) && Array.isArray(value)) {
    replaceReactiveArray(target, value)
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
  const initialData = store.snapshot?.data
  let current = (
    typeof initialData === 'undefined'
      ? reactive({})
      : createRealtimeReactiveValue(initialData)
  ) as RealtimeResultFor<TDefinition>
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
  return current as RealtimeResultFor<TDefinition>
}

configureRealtimeClientRuntime({
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createBroadcastRealtimeTransport())

export {}
