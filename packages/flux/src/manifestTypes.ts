import type { BroadcastJsonObject, GeneratedBroadcastManifest } from '@holo-js/broadcast'

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
type ManifestWhisperName<
  TManifest extends GeneratedBroadcastManifest,
  TPattern extends string,
> = ManifestChannelEntryByPattern<TManifest, TPattern>['whispers'][number] & string
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
    : ManifestEventName<TManifest>

type ManifestAdapterEventName<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = string extends ManifestEventName<TManifest>
  ? string
  : TChannel extends ManifestChannelPattern<TManifest>
    ? ManifestEventNamesForPattern<TManifest, TChannel>
    : never
type ManifestAdapterPresenceMember<
  TMember,
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string,
> = unknown extends TMember
  ? string extends ManifestChannelPattern<TManifest>
    ? BroadcastJsonObject
    : ManifestPresenceMember<TManifest, TChannel>
  : TMember

export type FluxManifestTypes<
  TManifest extends GeneratedBroadcastManifest,
  TChannel extends string = string,
  TMember = unknown,
> = {
  readonly channelPattern: ManifestChannelPattern<TManifest>
  readonly subscriptionEvent: ManifestSubscriptionEventName<TManifest, TChannel>
  readonly adapterEvent: ManifestAdapterEventName<TManifest, TChannel>
  readonly presenceMember: ManifestPresenceMember<TManifest, TChannel>
  readonly adapterPresenceMember: ManifestAdapterPresenceMember<TMember, TManifest, TChannel>
  readonly whisperName: ManifestWhisperName<TManifest, TChannel>
}
