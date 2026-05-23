import { getCurrentScope, onScopeDispose, readonly, shallowRef, type Ref, type ShallowRef } from 'vue'
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
type ManifestComposableChannel<TManifest extends GeneratedBroadcastManifest>
  = string extends ManifestChannelPattern<TManifest>
    ? string
    : ManifestChannelPattern<TManifest>
type ManifestComposableEvent<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
  TEvent extends string,
> = TEvent & ManifestSubscriptionEventName<TManifest, TChannel>
type ManifestComposablePresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = unknown extends TMember
  ? string extends ManifestChannelPattern<TManifest>
    ? BroadcastJsonObject
    : ManifestPresenceMember<TManifest, TChannel>
  : TMember

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

function memberKey<TMember>(member: TMember): string {
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
    updateMembers(appendPresenceMember(members.value, member as TResolvedMember))
  }).leaving((member) => {
    updateMembers(removePresenceMember(members.value, member as TResolvedMember))
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
