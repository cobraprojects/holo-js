import { getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref, type ShallowRef } from 'vue'
import { fluxInternals, getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxManifestTypes, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor, GeneratedBroadcastManifest } from '@holo-js/broadcast'

type ManifestComposableChannel<TManifest extends GeneratedBroadcastManifest>
  = FluxManifestTypes<TManifest>['channelPattern']
type ManifestComposableEvent<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TEvent extends string,
> = TEvent & FluxManifestTypes<TManifest, TChannel>['adapterEvent']
type ManifestComposablePresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = FluxManifestTypes<TManifest, TChannel, TMember>['adapterPresenceMember']

export interface FluxComposableOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> {
  readonly client?: FluxClient<TManifest>
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusComposableOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> extends FluxComposableOptions<TManifest> {
  readonly onChange?: (status: FluxConnectionStatus) => void
}

export interface FluxPresenceComposableCallbacks<TMember = BroadcastJsonObject> {
  readonly onHere?: (members: readonly TMember[]) => void
}

export type FluxPresenceComposableState<TMember = BroadcastJsonObject> = FluxListenerControls & FluxPresenceState<TMember>

interface FluxPresenceState<TMember = BroadcastJsonObject> {
  readonly members: readonly TMember[]
}

type AnyFluxSubscription = ReturnType<FluxClient['channel']>
type AnyFluxPresenceSubscription = ReturnType<FluxClient['presence']>

function resolveClient<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxComposableOptions<TManifest>,
): FluxClient<TManifest> {
  return (options.client ?? getFluxClient()) as FluxClient<TManifest>
}

function registerCleanup<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxComposableOptions<TManifest>,
  cleanup: () => void,
): void {
  if (getCurrentScope()) {
    onScopeDispose(cleanup)
    return
  }

  options.onUnmount?.(cleanup)
}

function createControls(subscription: AnyFluxSubscription): FluxListenerControls {
  const controls: FluxListenerControls = {
    leave: () => {
      subscription.leave()
    },
    leaveChannel: () => {
      subscription.leaveChannel()
    },
    listen: () => {
      subscription.listen()
      return controls
    },
    stopListening: () => {
      subscription.stopListening()
    },
  }
  return Object.freeze(controls)
}

function subscribeWithEvents<TEvent extends string>(
  subscription: AnyFluxSubscription,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
): AnyFluxSubscription {
  return subscription.listen(
    events,
    callback as unknown as (payload: unknown) => void,
  ) as AnyFluxSubscription
}

export function useFlux<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestComposableEvent<TManifest, TChannel, TEvent> | readonly ManifestComposableEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  const subscription = subscribeWithEvents(
    resolveClient(options).private(channel),
    events,
    callback,
  )
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return createControls(subscription)
}

export function useFluxPublic<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestComposableEvent<TManifest, TChannel, TEvent> | readonly ManifestComposableEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  const subscription = subscribeWithEvents(
    resolveClient(options).channel(channel),
    events,
    callback,
  )
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return createControls(subscription)
}

export function useFluxPrivate<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestComposableEvent<TManifest, TChannel, TEvent> | readonly ManifestComposableEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<
  TMember = unknown,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  callbacks: FluxPresenceComposableCallbacks<ManifestComposablePresenceMember<TMember, TManifest, TChannel>> = {},
  options: FluxComposableOptions<TManifest> = {},
): FluxPresenceComposableState<ManifestComposablePresenceMember<TMember, TManifest, TChannel>> {
  const subscription = resolveClient(options).presence(channel) as unknown as AnyFluxPresenceSubscription
  type TResolvedMember = ManifestComposablePresenceMember<TMember, TManifest, TChannel>
  const members = shallowRef(subscription.members as readonly TResolvedMember[])
  let active = true

  const updateMembers = (nextMembers: readonly TResolvedMember[]) => {
    if (!active) {
      return
    }

    members.value = nextMembers as readonly TResolvedMember[]
    callbacks.onHere?.(members.value)
  }
  subscription.here((nextMembers) => {
    updateMembers(nextMembers as readonly TResolvedMember[])
  }).joining((member) => {
    updateMembers(fluxInternals.appendPresenceMember(members.value, member as TResolvedMember))
  }).leaving((member) => {
    updateMembers(fluxInternals.removePresenceMember(members.value, member as TResolvedMember))
  })

  registerCleanup(options, () => {
    active = false
    subscription.leaveChannel()
  })

  return Object.freeze({
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
      return subscription
    },
    stopListening: () => {
      active = false
      subscription.stopListening()
    },
    get members() {
      return members.value
    },
  })
}

export function useFluxNotification<
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  callback: (payload: BroadcastJsonObject) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  const subscription = resolveClient(options).private(channel).notification(callback) as AnyFluxSubscription
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return createControls(subscription)
}

export function useFluxModel<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestComposableChannel<TManifest> = ManifestComposableChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestComposableEvent<TManifest, TChannel, TEvent> | readonly ManifestComposableEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  return useFluxPrivate(channel, events, callback, options)
}

export function useFluxConnectionStatus<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxConnectionStatusComposableOptions<TManifest> = {},
): Readonly<Ref<FluxConnectionStatus>> {
  const client = resolveClient(options)
  const status = shallowRef(client.getStatus())
  const unsubscribe = client.onStatusChange((nextStatus) => {
    status.value = nextStatus
    options.onChange?.(nextStatus)
  })

  registerCleanup(options, unsubscribe)
  return readonly(status) as Readonly<Ref<FluxConnectionStatus>>
}

export type {
  ShallowRef,
}
