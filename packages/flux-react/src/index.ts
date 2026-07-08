import { useEffect, useMemo, useReducer, useRef, useSyncExternalStore } from 'react'
import { getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor, GeneratedBroadcastManifest } from '@holo-js/broadcast'

type ManifestEventName<TManifest extends GeneratedBroadcastManifest>
  = TManifest['events'][number]['name'] & string
type ManifestChannelPattern<TManifest extends GeneratedBroadcastManifest>
  = TManifest['channels'][number]['pattern'] & string
type ManifestChannelEntryByPattern<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = Extract<TManifest['channels'][number], { pattern: TPattern }>
type ManifestPresenceMember<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = Extract<ManifestChannelEntryByPattern<TManifest, TPattern>, { member: unknown }> extends { member: infer TMember }
  ? TMember
  : BroadcastJsonObject
type ManifestEventNamesForPattern<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = TManifest['events'][number] extends infer TEvent
  ? TEvent extends {
    readonly name: infer TName
    readonly channels: readonly { readonly pattern: infer TEventPattern }[]
  }
    ? TPattern extends TEventPattern & string
      ? TName & string
      : never
    : never
  : never
type ManifestSubscriptionEventName<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = string extends ManifestEventName<TManifest>
  ? string
  : TChannel extends ManifestChannelPattern<TManifest>
    ? ManifestEventNamesForPattern<TManifest, TChannel>
    : never
type ManifestHookChannel<TManifest extends GeneratedBroadcastManifest>
  = string extends ManifestChannelPattern<TManifest>
    ? string
    : ManifestChannelPattern<TManifest>
type ManifestHookEvent<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TEvent extends string,
> = TEvent & ManifestSubscriptionEventName<TManifest, TChannel>
type ManifestHookPresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = unknown extends TMember
  ? string extends ManifestChannelPattern<TManifest>
    ? BroadcastJsonObject
    : ManifestPresenceMember<TManifest, TChannel>
  : TMember

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

function memberKey<TMember>(member: TMember): string {
  /* v8 ignore next -- supported presence members are JSON-compatible, but keep a defensive fallback */
  return JSON.stringify(member) ?? String(member)
}

function appendPresenceMember<TMember>(
  members: readonly TMember[],
  member: TMember,
): readonly TMember[] {
  return Object.freeze([...members, member])
}

function removePresenceMember<TMember>(
  members: readonly TMember[],
  member: TMember,
): readonly TMember[] {
  const key = memberKey(member)
  const index = members.findIndex(candidate => Object.is(candidate, member) || memberKey(candidate) === key)
  if (index < 0) {
    return members
  }

  return Object.freeze(members.filter((_, candidateIndex) => candidateIndex !== index))
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
        updateMembers(appendPresenceMember(membersRef.current, member as TResolvedMember))
      }
    }).leaving((member) => {
      if (active) {
        updateMembers(removePresenceMember(membersRef.current, member as TResolvedMember))
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
