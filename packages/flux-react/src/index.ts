import { useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { fluxInternals, getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxManifestTypes, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor, GeneratedBroadcastManifest } from '@holo-js/broadcast'

type ManifestHookChannel<TManifest extends GeneratedBroadcastManifest>
  = FluxManifestTypes<TManifest>['channelPattern']
type ManifestHookEvent<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TEvent extends string,
> = TEvent & FluxManifestTypes<TManifest, TChannel>['adapterEvent']
type ManifestHookPresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = FluxManifestTypes<TManifest, TChannel, TMember>['adapterPresenceMember']

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

export function useFlux<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
  events: ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent> | readonly ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent>[],
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

export function useFluxPublic<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
  events: ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent> | readonly ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent>[],
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

export function useFluxPrivate<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
  events: ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent> | readonly ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHookOptions<TManifest> = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<
  TMember = unknown,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
  callbacks: FluxPresenceHookCallbacks<ManifestHookPresenceMember<TMember, TManifest, TChannel>> = {},
  options: FluxHookOptions<TManifest> = {},
): FluxPresenceHookState<ManifestHookPresenceMember<TMember, TManifest, TChannel>> {
  const client = resolveClient(options)
  type TResolvedMember = ManifestHookPresenceMember<TMember, TManifest, TChannel>
  const membersRef = useRef<readonly TResolvedMember[]>([])
  const [, rerender] = useReducer((count: number) => count + 1, 0)
  const controlsRef = useRef<FluxListenerControls>(createNoopControls())
  const callbacksRef = useLatestRef(callbacks)
  const onUnmountRef = useLatestRef(options.onUnmount)

  useEffect(() => {
    const subscription = client.presence(channel)
    let active = true
    const updateMembers = (members: readonly TResolvedMember[]) => {
      membersRef.current = members
      callbacksRef.current.onHere?.(membersRef.current)
      rerender()
    }
    const cleanup = () => {
      active = false
      subscription.leaveChannel()
    }

    controlsRef.current = Object.freeze({
      leave: () => {
        active = false
        subscription.leave()
      },
      leaveChannel: () => {
        active = false
        subscription.leaveChannel()
      },
      listen: () => {
        active = true
        subscription.listen()
        updateMembers(subscription.members as readonly TResolvedMember[])
        return controlsRef.current
      },
      stopListening: () => {
        active = false
        subscription.stopListening()
      },
    })

    subscription.here((members) => {
      if (active) {
        updateMembers(members as readonly TResolvedMember[])
      }
    }).joining((member) => {
      if (active) {
        updateMembers(fluxInternals.appendPresenceMember(membersRef.current, member as TResolvedMember))
      }
    }).leaving((member) => {
      if (active) {
        updateMembers(fluxInternals.removePresenceMember(membersRef.current, member as TResolvedMember))
      }
    }).listen()
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

export function useFluxNotification<
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
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

export function useFluxModel<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHookChannel<TManifest> = ManifestHookChannel<TManifest>,
>(
  channel: TChannel & ManifestHookChannel<NoInfer<TManifest>>,
  events: ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent> | readonly ManifestHookEvent<NoInfer<TManifest>, TChannel, TEvent>[],
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
