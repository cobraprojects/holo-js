'use client'

import { useEffect, useSyncExternalStore } from 'react'
import {
  type RealtimeClientTransport,
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
import { createNextRenderableError, normalizeNextClientHttpError, renderNextClientHttpErrorPage } from './client-errors'

let currentRealtimeError: Error | undefined
const realtimeErrorListeners = new Set<() => void>()

function subscribeRealtimeError(listener: () => void): () => void {
  realtimeErrorListeners.add(listener)
  return () => {
    realtimeErrorListeners.delete(listener)
  }
}

function emitRealtimeError(error: unknown): void {
  const httpError = normalizeNextClientHttpError(error)

  if (!httpError) {
    return
  }

  currentRealtimeError = createNextRenderableError(httpError)
  renderNextClientHttpErrorPage(httpError)
  for (const listener of realtimeErrorListeners) {
    listener()
  }
}

function getRealtimeErrorSnapshot(): Error | undefined {
  return currentRealtimeError
}

function consumeRealtimeError(): Error | undefined {
  const error = currentRealtimeError
  currentRealtimeError = undefined
  return error
}

function createErrorHandlingRealtimeTransport(transport: RealtimeClientTransport): RealtimeClientTransport {
  return {
    async query(name, args) {
      try {
        return await transport.query(name, args)
      } catch (error) {
        emitRealtimeError(error)
        throw error
      }
    },
    async mutate(name, args) {
      try {
        return await transport.mutate(name, args)
      } catch (error) {
        emitRealtimeError(error)
        throw error
      }
    },
    subscribe(name, args, listener, onError) {
      return transport.subscribe(name, args, listener, (error) => {
        emitRealtimeError(error)
        onError(error)
      })
    },
  }
}

export const query = createRealtimeQuery

export const mutation: typeof createRealtimeMutation = ((input) => {
  const definition = createRealtimeMutation(input)
  const wrappedDefinition = ((...args: unknown[]) => {
    const result = Reflect.apply(definition, undefined, args) as ReturnType<typeof definition>
    void result.catch(emitRealtimeError)
    return result
  }) as unknown as typeof definition

  Object.defineProperties(wrappedDefinition, Object.getOwnPropertyDescriptors(definition))
  return wrappedDefinition
}) as typeof createRealtimeMutation

function useReactiveRealtimeQuery<TDefinition extends RealtimeQueryDefinition>(
  definition: TDefinition,
  args: RealtimeArgsFor<TDefinition>,
): RealtimeResultFor<TDefinition> | undefined {
  const realtimeError = useSyncExternalStore(
    subscribeRealtimeError,
    getRealtimeErrorSnapshot,
    getRealtimeErrorSnapshot,
  )

  if (realtimeError) {
    consumeRealtimeError()
    throw realtimeError
  }

  const store = getRealtimeQueryStore(definition, args)
  useEffect(() => {
    store.connect()
  }, [store])
  const snapshot = useSyncExternalStore(
    store.subscribe,
    () => store.snapshot,
    () => store.snapshot,
  )

  return snapshot?.data
}

configureRealtimeClientRuntime({
  handleError: emitRealtimeError,
  useQuery: useReactiveRealtimeQuery,
})
configureRealtimeClientTransport(createErrorHandlingRealtimeTransport(createBroadcastRealtimeTransport()))

export {}
