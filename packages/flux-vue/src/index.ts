import { getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref, type ShallowRef } from 'vue'
import { getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor, GeneratedBroadcastManifest } from '@holo-js/broadcast'

export interface FluxComposableOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> {
  readonly client?: FluxClient<TManifest>
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusComposableOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> extends FluxComposableOptions<TManifest> {
  readonly onChange?: (status: FluxConnectionStatus) => void
}

export interface FluxPresenceComposableCallbacks<TMember = unknown> {
  readonly onHere?: (members: readonly TMember[]) => void
}

export type FluxPresenceComposableState<TMember = unknown> = FluxListenerControls & FluxPresenceState<TMember>

interface FluxPresenceState<TMember = unknown> {
  readonly members: readonly TMember[]
}

type AnyFluxSubscription = ReturnType<FluxClient['channel']>
type AnyFluxPresenceSubscription = ReturnType<FluxClient['presence']> & {
  __onPresenceChange?(callback: (members: readonly BroadcastJsonObject[]) => void): () => void
}

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

export function useFlux<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
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

export function useFluxPublic<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
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

export function useFluxPrivate<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<TMember = unknown, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  callbacks: FluxPresenceComposableCallbacks<TMember> = {},
  options: FluxComposableOptions<TManifest> = {},
): FluxPresenceComposableState<TMember> {
  const subscription = resolveClient(options).presence(channel) as AnyFluxPresenceSubscription
  const members = shallowRef(subscription.members as readonly TMember[])
  callbacks.onHere?.(members.value)

  const stop = subscription.__onPresenceChange?.((nextMembers) => {
    members.value = nextMembers as readonly TMember[]
    callbacks.onHere?.(members.value)
  })

  registerCleanup(options, () => {
    stop?.()
    subscription.leaveChannel()
  })

  return Object.freeze({
    ...createControls(subscription),
    get members() {
      return members.value
    },
  })
}

export function useFluxNotification<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  callback: (payload: unknown) => void,
  options: FluxComposableOptions<TManifest> = {},
): FluxListenerControls {
  const subscription = resolveClient(options).private(channel).notification(callback as (payload: { readonly [key: string]: unknown }) => void) as AnyFluxSubscription
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return createControls(subscription)
}

export function useFluxModel<TEvent extends string, TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  channel: string,
  events: TEvent | readonly TEvent[],
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
