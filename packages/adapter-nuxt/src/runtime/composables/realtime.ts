import { onScopeDispose, reactive } from 'vue'
import { normalizeHoloHttpError } from '@holo-js/adapter-shared'
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
import { renderNuxtClientHttpErrorPage } from './client-errors'
import { isPlainObject } from './object'

function emitRealtimeError(error: unknown): void {
  const httpError = normalizeHoloHttpError(error)

  if (httpError) {
    renderNuxtClientHttpErrorPage(httpError)
  }
}

export const query = createRealtimeQuery

export const mutation = createRealtimeMutation

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

function connectRealtimeStoreInBrowser(store: { connect(): unknown }): void {
  if ('window' in globalThis) {
    store.connect()
  }
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
  connectRealtimeStoreInBrowser(store)
  onScopeDispose(unsubscribe)
  return current as RealtimeResultFor<TDefinition>
}

configureRealtimeClientRuntime({
  handleError: emitRealtimeError,
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createBroadcastRealtimeTransport())

export const nuxtRealtimeInternals = {
  emitRealtimeError,
  replaceReactiveObject,
  replaceReactiveArray,
  createRealtimeReactiveValue,
  replaceRealtimeReactiveValue,
  connectRealtimeStoreInBrowser,
}

export {}
