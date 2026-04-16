import { onDestroy } from 'svelte'
import { readable, writable, type Readable } from 'svelte/store'
import { getFluxClient, type FluxClient, type FluxConnectionStatus, type FluxListenerControls } from '@holo-js/flux'
import type { BroadcastJsonObject, BroadcastPayloadFor } from '@holo-js/broadcast'

export interface FluxHelperOptions<TClient extends FluxClient = FluxClient> {
  readonly client?: TClient
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusHelperOptions<TClient extends FluxClient = FluxClient> extends FluxHelperOptions<TClient> {
  readonly onChange?: (status: FluxConnectionStatus) => void
}

export interface FluxPresenceHelperCallbacks<TMember = unknown> {
  readonly onHere?: (members: readonly TMember[]) => void
}

export type FluxPresenceHelperState<TMember = unknown> = FluxListenerControls & {
  readonly members: Readable<readonly TMember[]>
}

type AnyFluxSubscription = ReturnType<FluxClient['channel']>
type AnyFluxPresenceSubscription = ReturnType<FluxClient['presence']> & {
  __onPresenceChange?(callback: (members: readonly BroadcastJsonObject[]) => void): () => void
}

function resolveClient<TClient extends FluxClient = FluxClient>(options: FluxHelperOptions<TClient>): TClient {
  return (options.client ?? getFluxClient()) as TClient
}

function registerCleanup(options: FluxHelperOptions, cleanup: () => void): void {
  const runCleanup = () => {
    cleanup()
  }
  let registered = false

  try {
    onDestroy(runCleanup)
    registered = true
  } catch {
    registered = false
  }

  if (!registered) {
    options.onUnmount?.(runCleanup)
  }
}

function controlsFromSubscription(subscription: AnyFluxSubscription): FluxListenerControls {
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
  options: FluxHelperOptions = {},
): FluxListenerControls {
  const subscription = subscribeWithEvents(
    resolveClient(options).private(channel),
    events,
    callback,
  )
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return controlsFromSubscription(subscription)
}

export function useFluxPublic<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions = {},
): FluxListenerControls {
  const subscription = subscribeWithEvents(
    resolveClient(options).channel(channel),
    events,
    callback,
  )
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return controlsFromSubscription(subscription)
}

export function useFluxPrivate<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<TMember = unknown>(
  channel: string,
  callbacks: FluxPresenceHelperCallbacks<TMember> = {},
  options: FluxHelperOptions = {},
): FluxPresenceHelperState<TMember> {
  const subscription = resolveClient(options).presence(channel) as AnyFluxPresenceSubscription
  callbacks.onHere?.(subscription.members as readonly TMember[])
  const members = writable(subscription.members as readonly TMember[])
  const stop = subscription.__onPresenceChange?.((nextMembers) => {
    const typedMembers = nextMembers as readonly TMember[]
    callbacks.onHere?.(typedMembers)
    members.set(typedMembers)
  })

  registerCleanup(options, () => {
    stop?.()
    subscription.leaveChannel()
  })

  return Object.freeze({
    ...controlsFromSubscription(subscription),
    members,
  })
}

export function useFluxNotification(
  channel: string,
  callback: (payload: unknown) => void,
  options: FluxHelperOptions = {},
): FluxListenerControls {
  const subscription = resolveClient(options).private(channel).notification(callback as (payload: { readonly [key: string]: unknown }) => void) as AnyFluxSubscription
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return controlsFromSubscription(subscription)
}

export function useFluxModel<TEvent extends string>(
  channel: string,
  events: TEvent | readonly TEvent[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions = {},
): FluxListenerControls {
  return useFluxPrivate(channel, events, callback, options)
}

export function useFluxConnectionStatus(
  options: FluxConnectionStatusHelperOptions = {},
): Readable<FluxConnectionStatus> {
  const client = resolveClient(options)
  const status = writable(client.getStatus())
  const unsubscribe = client.onStatusChange((nextStatus) => {
    options.onChange?.(nextStatus)
    status.set(nextStatus)
  })

  registerCleanup(options, unsubscribe)
  return readable(client.getStatus(), (set) => {
    const stop = status.subscribe(set)
    return () => {
      stop()
    }
  })
}
