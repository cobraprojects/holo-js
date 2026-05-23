import { onDestroy } from 'svelte'
import { readable, writable, type Readable } from 'svelte/store'
import {
  getFluxClient,
  type FluxClient,
  type FluxConnectionStatus,
  type FluxListenerControls,
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
  TMember,
> = ReturnType<FluxClient<TManifest>['presence']> & {
  readonly members: readonly TMember[]
}

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
  const subscription = resolveClient(options).presence(channel) as unknown as FluxPresenceSubscriptionWithChange<TManifest, TResolvedMember>
  const members = writable<readonly TResolvedMember[]>(subscription.members)
  let active = true
  const updateMembers = (nextMembers: readonly TResolvedMember[]) => {
    if (!active) {
      return
    }

    callbacks.onHere?.(nextMembers)
    members.set(nextMembers)
  }
  subscription.here((nextMembers) => {
    updateMembers(nextMembers as readonly TResolvedMember[])
  }).joining((member) => {
    if (!active) {
      return
    }

    let nextMembers: readonly TResolvedMember[] = []
    members.update((currentMembers) => {
      nextMembers = appendPresenceMember(currentMembers, member as TResolvedMember)
      return nextMembers
    })
    callbacks.onHere?.(nextMembers)
  }).leaving((member) => {
    if (!active) {
      return
    }

    let nextMembers: readonly TResolvedMember[] = []
    members.update((currentMembers) => {
      nextMembers = removePresenceMember(currentMembers, member as TResolvedMember)
      return nextMembers
    })
    callbacks.onHere?.(nextMembers)
  })

  registerCleanup(options, () => {
    active = false
    subscription.leaveChannel()
  })

  const controls = controlsFromSubscription(subscription)
  const state: FluxPresenceHelperState<TResolvedMember> = Object.freeze({
    leave: () => {
      active = false
      controls.leave()
    },
    leaveChannel: () => {
      active = false
      controls.leaveChannel()
    },
    listen: () => {
      active = true
      controls.listen()
      updateMembers(subscription.members)
      return state
    },
    stopListening: () => {
      active = false
      controls.stopListening()
    },
    members: {
      subscribe: members.subscribe,
    },
  })
  return state
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
  let unsubscribe: (() => void) | undefined
  const cleanup = () => {
    unsubscribe?.()
    unsubscribe = undefined
  }

  registerCleanup(options, cleanup)
  return readable(client.getStatus(), (set) => {
    set(client.getStatus())
    cleanup()
    unsubscribe = client.onStatusChange((nextStatus) => {
      options.onChange?.(nextStatus)
      set(nextStatus)
    })

    return cleanup
  })
}
