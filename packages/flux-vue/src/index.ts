import { getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref, type ShallowRef } from 'vue'
import { getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor } from '@holo-js/broadcast'

export interface FluxComposableOptions<TClient extends FluxClient = FluxClient> {
  readonly client?: TClient
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusComposableOptions<TClient extends FluxClient = FluxClient> extends FluxComposableOptions<TClient> {
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

function resolveClient<TClient extends FluxClient = FluxClient>(options: FluxComposableOptions<TClient>): TClient {
  return (options.client ?? getFluxClient()) as TClient
}

function registerCleanup(options: FluxComposableOptions, cleanup: () => void): void {
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

export function useFlux<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions = {},
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

export function useFluxPublic<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions = {},
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

export function useFluxPrivate<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<TMember = unknown>(
  channel: string,
  callbacks: FluxPresenceComposableCallbacks<TMember> = {},
  options: FluxComposableOptions = {},
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

export function useFluxNotification(
  channel: string,
  callback: (payload: unknown) => void,
  options: FluxComposableOptions = {},
): FluxListenerControls {
  const subscription = resolveClient(options).private(channel).notification(callback as (payload: { readonly [key: string]: unknown }) => void) as AnyFluxSubscription
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return createControls(subscription)
}

export function useFluxModel<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxComposableOptions = {},
): FluxListenerControls {
  return useFluxPrivate(channel, events, callback, options)
}

export function useFluxConnectionStatus(
  options: FluxConnectionStatusComposableOptions = {},
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
