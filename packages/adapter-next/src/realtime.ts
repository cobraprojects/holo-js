'use client'

import { cache, createElement, use, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useServerInsertedHTML } from 'next/navigation'
import {
  type RealtimeClientTransport,
  configureRealtimeClientRuntime,
  configureRealtimeClientTransport,
  createBroadcastRealtimeTransport,
  getRealtimeQueryStore,
  hydrateRealtimeQuery,
  realtimeClientInternals,
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

function isBrowserRuntime(): boolean {
  return 'window' in globalThis
}

function createHydrationElementId(definitionName: string, serializedArgs: string): string {
  let hash = 2166136261
  const value = `${definitionName}:${serializedArgs}`
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `__holo_realtime_${(hash >>> 0).toString(36)}`
}

function serializeHydrationData(value: unknown): string {
  return JSON.stringify({ data: value }).replace(/</g, '\\u003c')
}

function hydrateRealtimeQueryFromDocument(
  definition: RealtimeQueryDefinition,
  args: Record<string, unknown>,
  elementId: string,
): void {
  const runtime = globalThis as typeof globalThis & {
    readonly document?: {
      getElementById(id: string): { readonly textContent?: string | null } | null
    }
  }
  const element = runtime.document?.getElementById(elementId)
  if (!element?.textContent) return

  const parsed = JSON.parse(element.textContent) as { readonly data?: unknown }
  hydrateRealtimeQuery(definition, args as never, {
    name: definition.name,
    data: parsed.data as never,
    dependencies: [],
    version: 0,
  })
}

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

const resolveServerRealtimeQuery = cache(async (
  definition: RealtimeQueryDefinition,
  serializedArgs: string,
): Promise<unknown> => {
  const args = JSON.parse(serializedArgs) as Record<string, unknown>
  return await Promise.resolve(Reflect.apply(definition, undefined, [args]))
})

export const query: typeof createRealtimeQuery = ((input) => {
  const definition = createRealtimeQuery(input)
  const wrappedDefinition = ((...args: unknown[]) => {
    const normalizedArgs = args[0] ?? {}
    const serializedArgs = realtimeClientInternals.stableStringify(normalizedArgs)
    const hydrationElementId = createHydrationElementId(definition.name, serializedArgs)
    const hydration: { result: unknown, hasResult: boolean, inserted: boolean } = {
      result: undefined,
      hasResult: false,
      inserted: false,
    }

    useServerInsertedHTML(() => {
      if (!hydration.hasResult || hydration.inserted) return null
      hydration.inserted = true
      return createElement('script', {
        id: hydrationElementId,
        type: 'application/json',
        dangerouslySetInnerHTML: { __html: serializeHydrationData(hydration.result) },
      })
    })

    if (isBrowserRuntime()) {
      hydrateRealtimeQueryFromDocument(
        definition as unknown as RealtimeQueryDefinition,
        normalizedArgs as Record<string, unknown>,
        hydrationElementId,
      )
      return Reflect.apply(definition, undefined, args) as ReturnType<typeof definition>
    }

    const result = use(resolveServerRealtimeQuery(
      definition as unknown as RealtimeQueryDefinition,
      serializedArgs,
    ))
    hydration.result = result
    hydration.hasResult = true
    return result as ReturnType<typeof definition>
  }) as unknown as typeof definition

  Object.defineProperties(wrappedDefinition, Object.getOwnPropertyDescriptors(definition))
  return wrappedDefinition
}) as typeof createRealtimeQuery

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
): RealtimeResultFor<TDefinition> {
  const pendingRealtimeError = getRealtimeErrorSnapshot()
  if (pendingRealtimeError) {
    consumeRealtimeError()
    throw pendingRealtimeError
  }

  const serializedArgs = realtimeClientInternals.stableStringify(args)
  const store = useMemo(
    () => getRealtimeQueryStore(definition, args),
    [definition, serializedArgs],
  )
  const realtimeError = useSyncExternalStore(
    subscribeRealtimeError,
    getRealtimeErrorSnapshot,
    getRealtimeErrorSnapshot,
  )

  if (realtimeError) {
    consumeRealtimeError()
    throw realtimeError
  }

  useEffect(() => {
    store.connect()
  }, [store])
  const getSnapshot = () => store.snapshot
  const snapshot = useSyncExternalStore(
    store.subscribe,
    getSnapshot,
    getSnapshot,
  )

  if (!snapshot) {
    return use(store.load()).data
  }

  return snapshot.data
}

if (isBrowserRuntime()) {
  configureRealtimeClientRuntime({
    handleError: emitRealtimeError,
    useQuery: useReactiveRealtimeQuery,
  })
  configureRealtimeClientTransport(createErrorHandlingRealtimeTransport(createBroadcastRealtimeTransport()))
}

export const adapterNextRealtimeInternals = {
  subscribeRealtimeError,
  emitRealtimeError,
  getRealtimeErrorSnapshot,
  consumeRealtimeError,
  createErrorHandlingRealtimeTransport,
}

export {}
