import { onDestroy } from 'svelte'
import { readable, writable, type Readable } from 'svelte/store'
import {
  getFluxClient,
  type FluxClient,
  type FluxConnectionStatus,
  type FluxListenerControls,
  type FluxSubscription,
} from '@holo-js/flux'
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
type ManifestHelperChannel<TManifest extends GeneratedBroadcastManifest>
  = string extends ManifestChannelPattern<TManifest>
    ? string
    : ManifestChannelPattern<TManifest>
type ManifestHelperEvent<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TEvent extends string,
> = TEvent & ManifestSubscriptionEventName<TManifest, TChannel>
type ManifestHelperPresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = unknown extends TMember
  ? string extends ManifestChannelPattern<TManifest>
    ? BroadcastJsonObject
    : ManifestPresenceMember<TManifest, TChannel>
  : TMember

export interface FluxHelperOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> {
  readonly client?: FluxClient<TManifest>
  readonly onUnmount?: (cleanup: () => void) => void
}

export interface FluxConnectionStatusHelperOptions<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest> extends FluxHelperOptions<TManifest> {
  readonly onChange?: (status: FluxConnectionStatus) => void
}

export interface FluxPresenceHelperCallbacks<TMember = BroadcastJsonObject> {
  readonly onHere?: (members: readonly TMember[]) => void
}

export type FluxPresenceHelperState<TMember = BroadcastJsonObject> = FluxListenerControls & {
  readonly members: Readable<readonly TMember[]>
}

type AnyFluxSubscription = ReturnType<FluxClient['channel']>
type FluxPresenceSubscriptionWithChange<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TMember,
> = FluxSubscription<TManifest, TChannel> & {
  readonly members: readonly TMember[]
  __onPresenceChange?(callback: (members: readonly TMember[]) => void): () => void
}

function resolveClient<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxHelperOptions<TManifest>,
): FluxClient<TManifest> {
  return (options.client ?? getFluxClient()) as FluxClient<TManifest>
}

function registerCleanup<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxHelperOptions<TManifest>,
  cleanup: () => void,
): void {
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

export function useFlux<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestHelperEvent<TManifest, TChannel, TEvent> | readonly ManifestHelperEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions<TManifest> = {},
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

export function useFluxPublic<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestHelperEvent<TManifest, TChannel, TEvent> | readonly ManifestHelperEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions<TManifest> = {},
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

export function useFluxPrivate<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestHelperEvent<TManifest, TChannel, TEvent> | readonly ManifestHelperEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions<TManifest> = {},
): FluxListenerControls {
  return useFlux(channel, events, callback, options)
}

export function useFluxPresence<
  TMember = unknown,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  callbacks: FluxPresenceHelperCallbacks<ManifestHelperPresenceMember<TMember, TManifest, TChannel>> = {},
  options: FluxHelperOptions<TManifest> = {},
): FluxPresenceHelperState<ManifestHelperPresenceMember<TMember, TManifest, TChannel>> {
  type TResolvedMember = ManifestHelperPresenceMember<TMember, TManifest, TChannel>
  const subscription = resolveClient(options).presence(channel) as FluxPresenceSubscriptionWithChange<TManifest, TChannel, TResolvedMember>
  callbacks.onHere?.(subscription.members)
  const members = writable(subscription.members)
  const stop = subscription.__onPresenceChange?.((nextMembers) => {
    callbacks.onHere?.(nextMembers)
    members.set(nextMembers)
  })

  registerCleanup(options, () => {
    stop?.()
    subscription.leaveChannel()
  })

  return Object.freeze({
    ...controlsFromSubscription(subscription),
    members: {
      subscribe: members.subscribe,
    },
  })
}

export function useFluxNotification<
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  callback: (payload: BroadcastJsonObject) => void,
  options: FluxHelperOptions<TManifest> = {},
): FluxListenerControls {
  const subscription = resolveClient(options).private(channel).notification(callback) as AnyFluxSubscription
  registerCleanup(options, () => {
    subscription.leaveChannel()
  })
  return controlsFromSubscription(subscription)
}

export function useFluxModel<
  TEvent extends string,
  TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest,
  TChannel extends ManifestHelperChannel<TManifest> = ManifestHelperChannel<TManifest>,
>(
  channel: TChannel,
  events: ManifestHelperEvent<TManifest, TChannel, TEvent> | readonly ManifestHelperEvent<TManifest, TChannel, TEvent>[],
  callback: (payload: BroadcastPayloadFor<TEvent>) => void,
  options: FluxHelperOptions<TManifest> = {},
): FluxListenerControls {
  return useFluxPrivate(channel, events, callback, options)
}

export function useFluxConnectionStatus<TManifest extends GeneratedBroadcastManifest = GeneratedBroadcastManifest>(
  options: FluxConnectionStatusHelperOptions<TManifest> = {},
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
