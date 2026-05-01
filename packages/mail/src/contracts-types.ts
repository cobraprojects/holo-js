import { defineMailConfig, type HoloAppEnv, type NormalizedHoloMailConfig } from '@holo-js/config'

export const HOLO_MAIL_DEFINITION_MARKER = Symbol.for('holo-js.mail.definition')
export const BUILT_IN_MAIL_DRIVERS = ['preview', 'log', 'fake', 'smtp'] as const
export const MAIL_PRIORITY_VALUES = ['high', 'normal', 'low'] as const
export const MAIL_ATTACHMENT_DISPOSITIONS = ['attachment', 'inline'] as const

type MailJsonPrimitive = string | number | boolean | null
export type MailJsonValue
  = MailJsonPrimitive
  | readonly MailJsonValue[]
  | { readonly [key: string]: MailJsonValue }

export interface MailJsonObject {
  readonly [key: string]: MailJsonValue
}

export type MailPriority = (typeof MAIL_PRIORITY_VALUES)[number]
export type MailDelayValue = number | Date
export type MailAttachmentDisposition = (typeof MAIL_ATTACHMENT_DISPOSITIONS)[number]
export type MailPreviewFormat = 'html' | 'json' | 'text'
export type MailContentSourceKind = 'text' | 'html' | 'markdown' | 'render'

export interface MailAddress {
  readonly email: string
  readonly name?: string
}

export type MailAddressInput
  = string
  | {
      readonly email: string
      readonly name?: string
    }

export type MailRecipientsInput = MailAddressInput | readonly MailAddressInput[]

export interface MailRenderSource {
  readonly view: string
  readonly props?: MailJsonObject
}

export interface MailViewRenderInput {
  readonly view: string
  readonly props?: MailJsonObject
}

export interface MailQueueOptions {
  readonly queued?: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit?: boolean
}

export type MailAttachmentContent = string | Uint8Array

export interface MailAttachmentBase {
  readonly name?: string
  readonly contentType?: string
  readonly disposition?: MailAttachmentDisposition
  readonly contentId?: string
}

export interface MailPathAttachment extends MailAttachmentBase {
  readonly path: string
}

export interface MailStorageAttachment extends MailAttachmentBase {
  readonly storage: {
    readonly path: string
    readonly disk?: string
  }
}

export interface MailContentAttachment extends MailAttachmentBase {
  readonly content: MailAttachmentContent
  readonly name: string
}

export interface MailResolvedAttachmentPayload extends MailAttachmentBase {
  readonly path?: string
  readonly storage?: {
    readonly path: string
    readonly disk?: string
  }
  readonly content?: MailAttachmentContent
  readonly name?: string
}

export interface MailResolvableAttachment extends MailAttachmentBase {
  readonly resolve: () => MailResolvedAttachmentPayload | Promise<MailResolvedAttachmentPayload>
}

export type MailAttachmentInput
  = MailPathAttachment
  | MailStorageAttachment
  | MailContentAttachment
  | MailResolvableAttachment

export interface MailAttachmentHelperOptions extends MailAttachmentBase {
  readonly disposition?: MailAttachmentDisposition
}

export interface MailStorageAttachmentHelperOptions extends MailAttachmentHelperOptions {
  readonly disk?: string
}

export interface MailContentAttachmentHelperOptions extends MailAttachmentHelperOptions {
  readonly name: string
}

export interface MailDefinitionInput {
  readonly mailer?: string
  readonly from?: MailAddressInput
  readonly replyTo?: MailAddressInput
  readonly to: MailRecipientsInput
  readonly cc?: MailRecipientsInput
  readonly bcc?: MailRecipientsInput
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly markdown?: string
  readonly render?: MailRenderSource
  readonly markdownWrapper?: string
  readonly attachments?: readonly MailAttachmentInput[]
  readonly headers?: Readonly<Record<string, string>>
  readonly tags?: readonly string[]
  readonly metadata?: MailJsonObject
  readonly priority?: MailPriority
  readonly queue?: boolean | MailQueueOptions
  readonly delay?: MailDelayValue
}

export type MailOverrideInput = Readonly<Partial<MailDefinitionInput>>

export interface MailDefinition {
  readonly mailer?: string
  readonly from?: MailAddress
  readonly replyTo?: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc: readonly MailAddress[]
  readonly bcc: readonly MailAddress[]
  readonly subject: string
  readonly text?: string
  readonly html?: string
  readonly markdown?: string
  readonly render?: Readonly<MailRenderSource>
  readonly markdownWrapper?: string
  readonly attachments: readonly MailAttachmentInput[]
  readonly headers: Readonly<Record<string, string>>
  readonly tags: readonly string[]
  readonly metadata?: MailJsonObject
  readonly priority?: MailPriority
  readonly queue?: boolean | Readonly<MailQueueOptions>
  readonly delay?: MailDelayValue
}

export interface MailAttachmentMetadata {
  readonly source: 'path' | 'storage' | 'content' | 'resolve'
  readonly name?: string
  readonly contentType?: string
  readonly disposition: MailAttachmentDisposition
  readonly contentId?: string
}

export interface MailAttachmentResolutionContext {
  readonly queued: boolean
}

export interface ResolvedMailAttachment extends MailAttachmentMetadata {
  readonly name: string
  readonly path?: string
  readonly storage?: {
    readonly path: string
    readonly disk?: string
  }
  readonly content?: MailAttachmentContent
}

export interface MailAttachmentResolutionPlan extends MailAttachmentMetadata {
  readonly queuedSafe: boolean
  resolve(): Promise<ResolvedMailAttachment>
}

export interface ResolvedMail {
  readonly from: MailAddress
  readonly replyTo: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc: readonly MailAddress[]
  readonly bcc: readonly MailAddress[]
  readonly subject: string
  readonly html?: string
  readonly text?: string
  readonly attachments: readonly ResolvedMailAttachment[]
  readonly headers: Readonly<Record<string, string>>
  readonly tags: readonly string[]
  readonly metadata?: MailJsonObject
  readonly priority?: MailPriority
}

export interface MailPreviewResult extends Omit<ResolvedMail, 'attachments'> {
  readonly attachments: readonly MailAttachmentMetadata[]
  readonly source: Readonly<{
    readonly kind: MailContentSourceKind
    readonly markdown?: string
    readonly rawHtml?: string
    readonly render?: Readonly<MailRenderSource>
  }>
}

export interface MailSendResult {
  readonly messageId: string
  readonly mailer: string
  readonly driver: string
  readonly queued: boolean
  readonly deferred?: boolean
  readonly providerMessageId?: string
  readonly provider?: Readonly<Record<string, unknown>>
}

export interface MailDriverExecutionContext {
  readonly messageId: string
  readonly mailer: string
  readonly driver: string
  readonly queued: boolean
  readonly deferred?: boolean
}

export interface MailDriver<TResult extends MailSendResult = MailSendResult> {
  send(mail: Readonly<ResolvedMail>, context: Readonly<MailDriverExecutionContext>): TResult | Promise<TResult>
}

export interface BuiltInMailDriverRegistry {
  readonly preview: MailDriver
  readonly log: MailDriver
  readonly fake: MailDriver
  readonly smtp: MailDriver
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HoloMailDriverRegistry {}

export type MailDriverRegistry = BuiltInMailDriverRegistry & HoloMailDriverRegistry
export type MailDriverName = Extract<keyof MailDriverRegistry, string>

export interface MailSendOptions {
  readonly mailer?: string
  readonly connection?: string
  readonly queue?: string
  readonly delay?: MailDelayValue
  readonly afterCommit?: boolean
}

export interface MailSendInput {
  readonly mail: MailDefinition
  readonly attachments: readonly ResolvedMailAttachment[]
  readonly options: Readonly<MailSendOptions>
}

export interface MailPreviewInput {
  readonly mail: MailDefinition
}

export interface MailRenderPreviewInput extends MailPreviewInput {
  readonly format: MailPreviewFormat
}

export interface MailPreviewPolicy {
  readonly environment: HoloAppEnv
  readonly allowedEnvironments: readonly HoloAppEnv[]
}

export interface MailViewRenderer {
  (input: MailViewRenderInput): string | Promise<string>
}

export interface MailRuntimeBindings {
  readonly config?: NormalizedHoloMailConfig
  readonly renderView?: MailViewRenderer
  send?(input: MailSendInput): MailSendResult | Promise<MailSendResult>
  preview?(input: MailPreviewInput): MailPreviewResult | Promise<MailPreviewResult>
  renderPreview?(input: MailRenderPreviewInput): Response | Promise<Response>
}

export interface RegisterMailDriverOptions {
  readonly replaceExisting?: boolean
}

export interface RegisteredMailDriver<TDriver extends string = string> {
  readonly name: TDriver
  readonly driver: MailDriver
}

export interface PendingMailSend<TResult = MailSendResult> extends PromiseLike<TResult> {
  using(name: string): PendingMailSend<TResult>
  onConnection(name: string): PendingMailSend<TResult>
  onQueue(name: string): PendingMailSend<TResult>
  delay(value: MailDelayValue): PendingMailSend<TResult>
  afterCommit(): PendingMailSend<TResult>
  then<TResult1 = TResult, TResult2 = never>(
    onfulfilled?: ((value: TResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>
  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<TResult | TResult1>
  finally(onfinally?: (() => void) | null): Promise<TResult>
}

export { defineMailConfig }
