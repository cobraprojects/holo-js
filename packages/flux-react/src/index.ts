import { useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor, GeneratedBroadcastManifest } from '@holo-js/broadcast'

export interface FluxHookOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> {
  readonly client?: FluxClient<TManifest>
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusHookOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> extends FluxHookOptions<TManifest> {
  readonly onChange?: (status: FluxConnectionStatus) => void
}

export interface FluxPresenceHookCallbacks<TMember = unknown> {
  readonly onHere?: (members: readonly TMember[]) => void
}

export type FluxPresenceHookState<TMember = unknown> = FluxListenerControls & {
  readonly members: readonly TMember[]
}

type AnyFluxSubscription = ReturnType<FluxClient['channel']>
type AnyFluxPresenceSubscription = ReturnType<FluxClient['presence']> & {
  __onPresenceChange?(callback: (members: readonly BroadcastJsonObject[]) => void): () => void
}

function resolveClient<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxHookOptions<TManifest>,
): FluxClient<TManifest> {
  return (options.client ?? getFluxClient()) as FluxClient<TManifest>
}

const noop = Function.prototype as () => void

function createNoopControls(): FluxListenerControls {
  const controls: FluxListenerControls = {
    leave: noop,
    leaveChannel: noop,
    /* v8 ignore next -- noop listen is only used as initial ref value before useEffect runs */
    listen: () => controls,
    stopListening: noop,
  }
  return Object.freeze(controls)
}

function useLatestRef<TValue>(value: TValue): { current: TValue } {
  const ref = useRef(value)
  ref.current = value
  return ref
}

function serializeEventDependency<TEvent extends string>(events: TEvent | readonly TEvent[]): string {
  return Array.isArray(events) ? events.map(String).join('\0') : String(events)
}

function useControls(
  createSubscription: () => AnyFluxSubscription,
  onUnmount?: (cleanup: () => void) => void,
  dependencies: readonly unknown[] = [],
): FluxListenerControls {
  const controlsRef = useRef<FluxListenerControls>(createNoopControls())
  const onUnmountRef = useLatestRef(onUnmount)

  useEffect(() => {
    const subscription = createSubscription()
    const cleanup = () => {
      subscription.leaveChannel()
    }

    controlsRef.current = Object.freeze({
      leave: () => {
        subscription.leave()
      },
      leaveChannel: () => {
        subscription.leaveChannel()
      },
      listen: () => {
        subscription.listen()
        return controlsRef.current
      },
      stopListening: () => {
        subscription.stopListening()
      },
    })

    onUnmountRef.current?.(cleanup)
    return cleanup
  }, dependencies)

  return useMemo(() => Object.freeze({
    leave: () => {
      controlsRef.current.leave()
    },
    leaveChannel: () => {
      controlsRef.current.leaveChannel()
    },
    listen: () => {
      return controlsRef.current.listen()
    },
    stopListening: () => {
      controlsRef.current.stopListening()
    },
  }), [])
}

function useEventSubscription<TEvent extends string>(
  buildSubscription: () => AnyFluxSubscription,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  onUnmount?: (cleanup: () => void) => void,
  dependencies: readonly unknown[] = [],
): FluxListenerControls {
  const callbackRef = useLatestRef(callback)
  return useControls(() => {
    return buildSubscription().listen(
      events,
      callbackRef.current as unknown as (payload: BroadcastJsonObject) => void,
    ) as AnyFluxSubscription
  }, onUnmount, dependencies)
}

export function useFlux<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  const client = resolveClient(options)
  return useEventSubscription(
    () => client.private(channel),
    events,
    callback,
    options.onUnmount,
    [client, channel, serializeEventDependency(events)],
  )
}

export function useFluxPublic<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  const client = resolveClient(options)
  return useEventSubscription(
    () => client.channel(channel),
    events,
    callback,
    options.onUnmount,
    [client, channel, serializeEventDependency(events)],
  )
}

export function useFluxPrivate<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<TMember = unknown, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  callbacks: FluxPresenceHookCallbacks<TMember> = {},
  options: FluxHookOptions<TManifest> = {},
): FluxPresenceHookState<TMember> {
  const client = resolveClient(options)
  const membersRef = useRef<readonly TMember[]>([])
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const controlsRef = useRef<FluxListenerControls>(createNoopControls())
  const callbacksRef = useLatestRef(callbacks)
  const onUnmountRef = useLatestRef(options.onUnmount)

  useEffect(() => {
    const subscription = client.presence(channel) as AnyFluxPresenceSubscription
    const updateMembers = (members: readonly BroadcastJsonObject[]) => {
      membersRef.current = members as readonly TMember[]
      callbacksRef.current.onHere?.(membersRef.current)
      rerender()
    }
    updateMembers(subscription.members as readonly BroadcastJsonObject[])
    const stop = subscription.__onPresenceChange?.(updateMembers)
    const cleanup = () => {
      stop?.()
      subscription.leaveChannel()
    }

    controlsRef.current = Object.freeze({
      leave: () => {
        subscription.leave()
      },
      leaveChannel: () => {
        subscription.leaveChannel()
      },
      listen: () => {
        subscription.listen()
        return controlsRef.current
      },
      stopListening: () => {
        subscription.stopListening()
      },
    })

    onUnmountRef.current?.(cleanup)
    return cleanup
  }, [channel, client, callbacksRef, onUnmountRef])

  const controls = useMemo(() => Object.freeze({
    leave: () => {
      controlsRef.current.leave()
    },
    leaveChannel: () => {
      controlsRef.current.leaveChannel()
    },
    listen: () => {
      return controlsRef.current.listen()
    },
    stopListening: () => {
      controlsRef.current.stopListening()
    },
  }), [])

  return Object.freeze({
    ...controls,
    get members() {
      return membersRef.current
    },
  })
}

export function useFluxNotification<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  callback: (payload: unknown) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  const client = resolveClient(options)
  const callbackRef = useLatestRef(callback)
  return useControls(() => {
    return client.private(channel).notification(
      callbackRef.current as (payload: { readonly [key: string]: unknown }) => void,
    ) as AnyFluxSubscription
  }, options.onUnmount, [client, channel])
}

export function useFluxModel<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  return useFluxPrivate(channel, events, callback, options)
}

export function useFluxConnectionStatus<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxConnectionStatusHookOptions<TManifest> = {},
): FluxConnectionStatus {
  const client = resolveClient(options)
  const onChangeRef = useLatestRef(options.onChange)
  const onUnmountRef = useLatestRef(options.onUnmount)

  useEffect(() => {
    if (!onChangeRef.current) {
      return
    }

    const unsubscribe = client.onStatusChange((status) => {
      onChangeRef.current?.(status)
    })
    onUnmountRef.current?.(unsubscribe)
    return unsubscribe
  }, [client, onChangeRef, onUnmountRef])

  return useSyncExternalStore(
    (notify) => {
      const unsubscribe = client.onStatusChange(() => {
        notify()
      })
      onUnmountRef.current?.(unsubscribe)
      return unsubscribe
    },
    () => client.getStatus(),
    () => client.getStatus(),
  )
}
