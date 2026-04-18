import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  holoMailDefaults,
  normalizeAppEnv,
  type HoloAppEnv,
  type NormalizedHoloMailConfig,
} from '@holo-js/config'
import {
  createAttachmentMetadata,
  createAttachmentResolutionPlans,
  type MailAddress,
  type MailAttachmentResolutionPlan,
  type MailDefinition,
  type MailDefinitionInput,
  type MailDelayValue,
  type MailDriver,
  type MailDriverExecutionContext,
  type MailJsonObject,
  type MailOverrideInput,
  type MailPreviewFormat,
  type MailPreviewPolicy,
  type MailPreviewResult,
  type MailRenderSource,
  type ResolvedMailAttachment,
  type ResolvedMail,
  type MailRuntimeBindings,
  type MailSendInput,
  type MailSendResult,
  type MailViewRenderInput,
  type PendingMailSend,
  mergeMailDefinitionInputs,
  normalizeMailDefinition,
} from './contracts'
import { getRegisteredMailDriver } from './registry'

const HOLO_MAIL_DELIVER_JOB = 'holo.mail.deliver'

type RuntimeState = {
  bindings?: MailRuntimeBindings
  fakeSent?: FakeSentMail[]
  previewArtifacts?: MailPreviewArtifact[]
  loadQueueModule?: () => Promise<QueueModule>
  loadDbModule?: () => Promise<DbModule | null>
  loadNodemailerModule?: () => Promise<NodemailerModule>
  loadStorageModule?: () => Promise<StorageModule>
}

type MutableSendOptions = {
  mailer?: string
  connection?: string
  queue?: string
  delay?: MailDelayValue
  afterCommit?: boolean
}

type ResolvedEnvelope = {
  readonly config: NormalizedHoloMailConfig
  readonly mailer: string
  readonly from: MailAddress
  readonly replyTo: MailAddress
  readonly to: readonly MailAddress[]
  readonly cc: readonly MailAddress[]
  readonly bcc: readonly MailAddress[]
}

type RenderedContent = {
  readonly kind: 'text' | 'html' | 'markdown' | 'render'
  readonly html?: string
  readonly text?: string
  readonly source: Readonly<{
    readonly kind: 'text' | 'html' | 'markdown' | 'render'
    readonly markdown?: string
    readonly rawHtml?: string
    readonly render?: Readonly<MailRenderSource>
  }>
}

type PreviewComputation = ResolvedEnvelope & {
  readonly preview: MailPreviewResult
}

type SendPreparation = {
  readonly attachments: readonly ResolvedMailAttachment[]
}

type ResolvedDriver = {
  readonly mailer: string
  readonly driver: string
  readonly implementation: MailDriver
}

type ResolvedQueuePlan = {
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly delay?: MailDelayValue
  readonly afterCommit: boolean
}

type QueueDispatchChain = {
  onConnection(name: string): QueueDispatchChain
  onQueue(name: string): QueueDispatchChain
  delay(value: number | Date): QueueDispatchChain
  dispatch(): Promise<unknown>
}

type QueueModule = {
  defineJob(definition: { handle(payload: QueuedMailDeliveryPayload): Promise<unknown> | unknown }): unknown
  dispatch(jobName: string, payload: QueuedMailDeliveryPayload): QueueDispatchChain
  getRegisteredQueueJob(name: string): unknown
  registerQueueJob(definition: unknown, options: { name: string }): void
}

type DbModule = {
  connectionAsyncContext: {
    getActive(): { connection: { getScope(): { kind: string }, afterCommit(callback: () => Promise<void>): void } } | undefined
  }
}

type NodemailerAddress = {
  readonly address: string
  readonly name?: string
}

type NodemailerAttachment = {
  readonly filename: string
  readonly contentType?: string
  readonly contentDisposition?: string
  readonly cid?: string
  readonly path?: string
  readonly content?: string | Uint8Array
}

type NodemailerMailMessage = {
  readonly messageId: string
  readonly from: NodemailerAddress
  readonly replyTo: NodemailerAddress
  readonly to: readonly NodemailerAddress[]
  readonly cc?: readonly NodemailerAddress[]
  readonly bcc?: readonly NodemailerAddress[]
  readonly subject: string
  readonly html?: string
  readonly text?: string
  readonly attachments?: readonly NodemailerAttachment[]
  readonly headers?: Readonly<Record<string, string>>
}

type NodemailerSendResult = {
  readonly messageId?: string
  readonly response?: string
}

type NodemailerTransport = {
  sendMail(message: NodemailerMailMessage): Promise<NodemailerSendResult>
}

type NodemailerModule = {
  createTransport(options: Record<string, unknown>): NodemailerTransport
}

type StorageDisk = {
  readonly driver: string
  path(path: string): string
  getBytes(path: string): Promise<Uint8Array | null>
}

type StorageModule = {
  Storage: {
    disk(diskName?: string): StorageDisk
  }
}

type SerializedQueuedAttachment = Readonly<{
  readonly source: ResolvedMailAttachment['source']
  readonly name: string
  readonly contentType?: string
  readonly disposition: ResolvedMailAttachment['disposition']
  readonly contentId?: string
  readonly path?: string
  readonly storage?: {
    readonly path: string
    readonly disk?: string
  }
  readonly content?: string | Readonly<{
    readonly encoding: 'base64'
    readonly value: string
  }>
}>

type QueuedResolvedMailPayload = Readonly<Omit<ResolvedMail, 'attachments'> & {
  readonly attachments: readonly SerializedQueuedAttachment[]
}>

type QueuedMailDeliveryPayload = Readonly<{
  readonly messageId: string
  readonly mailer: string
  readonly driver: string
  readonly queued: true
  readonly deferred?: boolean
  readonly mail: QueuedResolvedMailPayload
}>

type SendExecutionOptions = {
  readonly allowAfterCommitDeferral?: boolean
}

export interface FakeSentMail {
  readonly messageId: string
  readonly createdAt: Date
  readonly mail: Readonly<ResolvedMail>
  readonly context: Readonly<MailDriverExecutionContext>
  readonly result: Readonly<MailSendResult>
}

export interface MailPreviewArtifact {
  readonly messageId: string
  readonly createdAt: Date
  readonly mail: Readonly<ResolvedMail>
  readonly context: Readonly<MailDriverExecutionContext>
  readonly result: Readonly<MailSendResult>
}

export class MailError extends Error {
  readonly code: string

  constructor(message: string, code = 'MAIL_ERROR', options?: ErrorOptions) {
    super(message, options)
    this.name = 'MailError'
    this.code = code
  }
}

export class MailPreviewDisabledError extends MailError {
  readonly policy: MailPreviewPolicy

  constructor(policy: MailPreviewPolicy) {
    super(
      `[@holo-js/mail] Mail preview is disabled for the "${policy.environment}" environment.`,
      'MAIL_PREVIEW_DISABLED',
    )
    this.name = 'MailPreviewDisabledError'
    this.policy = policy
  }
}

export class MailPreviewFormatUnavailableError extends MailError {
  readonly format: MailPreviewFormat

  constructor(format: MailPreviewFormat) {
    super(
      `[@holo-js/mail] Mail ${format} preview is unavailable for this message.`,
      'MAIL_PREVIEW_FORMAT_UNAVAILABLE',
    )
    this.name = 'MailPreviewFormatUnavailableError'
    this.format = format
  }
}

export class MailSendError extends MailError {
  readonly messageId: string
  readonly mailer: string
  readonly driver: string

  constructor(
    details: {
      readonly messageId: string
      readonly mailer: string
      readonly driver: string
      readonly message?: string
    },
    options?: ErrorOptions,
  ) {
    super(
      details.message
        ?? `[@holo-js/mail] Mail delivery failed for mailer "${details.mailer}" using driver "${details.driver}".`,
      'MAIL_SEND_FAILED',
      options,
    )
    this.name = 'MailSendError'
    this.messageId = details.messageId
    this.mailer = details.mailer
    this.driver = details.driver
  }
}

function getRuntimeState(): RuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoMailRuntime__?: RuntimeState
  }

  runtime.__holoMailRuntime__ ??= {}
  return runtime.__holoMailRuntime__
}

function getRuntimeBindings(): MailRuntimeBindings {
  return getRuntimeState().bindings ?? {}
}

function dynamicImport<TModule>(specifier: string): Promise<TModule> {
  return import(specifier as string) as Promise<TModule>
}

async function loadQueueModule(): Promise<QueueModule> {
  const override = getRuntimeState().loadQueueModule
  if (override) {
    try {
      return await override()
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        throw new MailError(
          '[@holo-js/mail] Queued or delayed mail delivery requires @holo-js/queue to be installed.',
          'MAIL_QUEUE_MODULE_MISSING',
        )
      }

      throw error
    }
  }

  try {
    return await dynamicImport<QueueModule>('@holo-js/queue')
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new MailError(
        '[@holo-js/mail] Queued or delayed mail delivery requires @holo-js/queue to be installed.',
        'MAIL_QUEUE_MODULE_MISSING',
      )
    }

    throw error
  }
}

async function loadDbModule(): Promise<DbModule | null> {
  const override = getRuntimeState().loadDbModule
  if (override) {
    try {
      return await override()
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        return null
      }

      throw error
    }
  }

  try {
    return await dynamicImport<DbModule>('@holo-js/db')
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return null
    }

    throw error
  }
}

function resolveNodemailerModule(module: unknown): NodemailerModule {
  if (
    module
    && typeof module === 'object'
    && 'createTransport' in module
    && typeof (module as { createTransport?: unknown }).createTransport === 'function'
  ) {
    return module as NodemailerModule
  }

  if (
    module
    && typeof module === 'object'
    && 'default' in module
    && (module as { default?: unknown }).default
    && typeof (module as { default?: { createTransport?: unknown } }).default?.createTransport === 'function'
  ) {
    return (module as { default: NodemailerModule }).default
  }

  throw new MailError(
    '[@holo-js/mail] Nodemailer could not be loaded for SMTP delivery.',
    'MAIL_SMTP_MODULE_INVALID',
  )
}

async function loadNodemailerModule(): Promise<NodemailerModule> {
  const override = getRuntimeState().loadNodemailerModule
  if (override) {
    try {
      return resolveNodemailerModule(await override())
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        throw new MailError(
          '[@holo-js/mail] SMTP delivery requires nodemailer to be installed.',
          'MAIL_SMTP_MODULE_MISSING',
          { cause: error },
        )
      }

      throw error
    }
  }

  try {
    return resolveNodemailerModule(await dynamicImport<unknown>('nodemailer'))
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new MailError(
        '[@holo-js/mail] SMTP delivery requires nodemailer to be installed.',
        'MAIL_SMTP_MODULE_MISSING',
        { cause: error },
      )
    }

    throw error
  }
}

function resolveStorageModule(module: unknown): StorageModule {
  if (
    module
    && typeof module === 'object'
    && 'Storage' in module
    && (module as { Storage?: unknown }).Storage
    && typeof (module as { Storage?: { disk?: unknown } }).Storage?.disk === 'function'
  ) {
    return module as StorageModule
  }

  throw new MailError(
    '[@holo-js/mail] The storage runtime could not be loaded for storage-backed attachments.',
    'MAIL_STORAGE_MODULE_INVALID',
  )
}

async function loadStorageModule(): Promise<StorageModule> {
  const override = getRuntimeState().loadStorageModule
  if (override) {
    try {
      return resolveStorageModule(await override())
    } catch (error) {
      if (
        error
        && typeof error === 'object'
        && 'code' in error
        && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
      ) {
        throw new MailError(
          '[@holo-js/mail] Storage-backed attachments require @holo-js/storage to be installed.',
          'MAIL_STORAGE_MODULE_MISSING',
          { cause: error },
        )
      }

      throw error
    }
  }

  try {
    return resolveStorageModule(await dynamicImport<unknown>('@holo-js/storage'))
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      throw new MailError(
        '[@holo-js/mail] Storage-backed attachments require @holo-js/storage to be installed.',
        'MAIL_STORAGE_MODULE_MISSING',
        { cause: error },
      )
    }

    throw error
  }
}

function getFakeSentState(): FakeSentMail[] {
  const state = getRuntimeState()
  state.fakeSent ??= []
  return state.fakeSent
}

function getPreviewArtifactState(): MailPreviewArtifact[] {
  const state = getRuntimeState()
  state.previewArtifacts ??= []
  return state.previewArtifacts
}

function normalizeExecutionString(
  value: string,
  label: string,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/mail] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeExecutionDelay(value: MailDelayValue): MailDelayValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('[@holo-js/mail] Mail delays must be finite numbers greater than or equal to 0.')
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error('[@holo-js/mail] Mail delays must use valid Date instances.')
  }

  return value
}

function getResolvedConfig(): NormalizedHoloMailConfig {
  return getRuntimeBindings().config ?? holoMailDefaults
}

function resolveCurrentEnvironment(): HoloAppEnv {
  return normalizeAppEnv(process.env.APP_ENV ?? process.env.NODE_ENV)
}

function createPreviewPolicy(config: NormalizedHoloMailConfig = getResolvedConfig()): MailPreviewPolicy {
  return Object.freeze({
    environment: resolveCurrentEnvironment(),
    allowedEnvironments: config.preview.allowedEnvironments,
  })
}

function assertPreviewEnabled(config: NormalizedHoloMailConfig = getResolvedConfig()): void {
  const policy = createPreviewPolicy(config)
  if (!policy.allowedEnvironments.includes(policy.environment)) {
    throw new MailPreviewDisabledError(policy)
  }
}

function createPreviewHtml(preview: MailPreviewResult): string {
  const header = [
    `<h1>${escapeHtml(preview.subject)}</h1>`,
    `<p><strong>From:</strong> ${formatAddress(preview.from)}</p>`,
    `<p><strong>Reply-To:</strong> ${formatAddress(preview.replyTo)}</p>`,
    `<p><strong>To:</strong> ${preview.to.map(formatAddress).join(', ')}</p>`,
    preview.cc.length > 0 ? `<p><strong>Cc:</strong> ${preview.cc.map(formatAddress).join(', ')}</p>` : '',
    preview.bcc.length > 0 ? `<p><strong>Bcc:</strong> ${preview.bcc.map(formatAddress).join(', ')}</p>` : '',
  ].filter(Boolean).join('')

  const body = preview.html
    ? preview.html
    : preview.text
      ? `<pre>${escapeHtml(preview.text)}</pre>`
      : '<p>No rendered content is available.</p>'

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(preview.subject)}</title></head><body>${header}${body}</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function formatAddress(address: { readonly email: string, readonly name?: string }): string {
  return address.name
    ? `${escapeHtml(address.name)} &lt;${escapeHtml(address.email)}&gt;`
    : escapeHtml(address.email)
}

function renderPreviewResponse(
  preview: MailPreviewResult,
  format: MailPreviewFormat,
): Response {
  if (format === 'json') {
    return new Response(JSON.stringify(preview, null, 2), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
      },
    })
  }

  if (format === 'text') {
    if (typeof preview.text !== 'string') {
      throw new MailPreviewFormatUnavailableError(format)
    }

    return new Response(preview.text, {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
      },
    })
  }

  return new Response(createPreviewHtml(preview), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  })
}

function getMailerConfig(mailer: string, config: NormalizedHoloMailConfig = getResolvedConfig()) {
  const mailerConfig = config.mailers[mailer]
  if (!mailerConfig) {
    throw new MailError(
      `[@holo-js/mail] Mailer "${mailer}" is not configured. Available mailers: ${Object.keys(config.mailers).join(', ')}`,
      'MAILER_NOT_CONFIGURED',
    )
  }

  return mailerConfig
}

function isPreviewMailerConfig(
  config: ReturnType<typeof getMailerConfig>,
): config is ReturnType<typeof getMailerConfig> & {
  readonly driver: 'preview'
  readonly path: string
} {
  return config.driver === 'preview'
    && typeof (config as { path?: unknown }).path === 'string'
}

function isSmtpMailerConfig(
  config: ReturnType<typeof getMailerConfig>,
): config is ReturnType<typeof getMailerConfig> & {
  readonly driver: 'smtp'
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string
  readonly password?: string
} {
  return config.driver === 'smtp'
    && typeof (config as { host?: unknown }).host === 'string'
    && typeof (config as { port?: unknown }).port === 'number'
    && typeof (config as { secure?: unknown }).secure === 'boolean'
}

function isQueueRequested(
  mail: MailDefinition,
  mailer: string,
  options: MutableSendOptions | Readonly<MutableSendOptions>,
  config: NormalizedHoloMailConfig = getResolvedConfig(),
): boolean {
  const mailerConfig = getMailerConfig(mailer, config)
  const mailQueue = mail.queue

  if (
    typeof options.connection === 'string'
    || typeof options.queue === 'string'
    || typeof options.delay !== 'undefined'
  ) {
    return true
  }

  if (mailQueue === true) {
    return true
  }

  if (mailQueue === false) {
    return false
  }

  if (typeof mailQueue === 'object' && mailQueue !== null) {
    if (typeof mailQueue.connection === 'string' || typeof mailQueue.queue === 'string') {
      return true
    }

    if (typeof mailQueue.queued === 'boolean') {
      return mailQueue.queued
    }
  }

  return mailerConfig.queue.queued === true
    || typeof mailerConfig.queue.connection === 'string'
    || typeof mailerConfig.queue.queue === 'string'
    || config.queue.queued === true
    || typeof config.queue.connection === 'string'
    || typeof config.queue.queue === 'string'
}

function resolveQueuePlan(
  mail: MailDefinition,
  options: MutableSendOptions | Readonly<MutableSendOptions>,
  mailer: string,
  config: NormalizedHoloMailConfig = getResolvedConfig(),
): ResolvedQueuePlan {
  const mailerConfig = getMailerConfig(mailer, config)
  const mailQueue = typeof mail.queue === 'object' && mail.queue !== null ? mail.queue : undefined
  const queued = isQueueRequested(mail, mailer, options, config)

  return Object.freeze({
    queued,
    connection: queued
      ? options.connection ?? mailQueue?.connection ?? mailerConfig.queue.connection ?? config.queue.connection
      : undefined,
    queue: queued
      ? options.queue ?? mailQueue?.queue ?? mailerConfig.queue.queue ?? config.queue.queue
      : undefined,
    delay: queued
      ? options.delay ?? mail.delay
      : undefined,
    afterCommit: options.afterCommit
      ?? mailQueue?.afterCommit
      ?? mailerConfig.queue.afterCommit
      ?? config.queue.afterCommit,
  })
}

async function prepareMailSend(
  mail: MailDefinition,
  queued: boolean,
): Promise<SendPreparation> {
  const plans = createAttachmentResolutionPlans(mail.attachments, { queued })
  const attachments = Object.freeze(await Promise.all(plans.map((plan: MailAttachmentResolutionPlan) => plan.resolve())))
  return Object.freeze({
    attachments,
  })
}

function createResolvedMail(
  preview: MailPreviewResult,
  attachments: readonly ResolvedMailAttachment[],
): ResolvedMail {
  return Object.freeze({
    from: preview.from,
    replyTo: preview.replyTo,
    to: preview.to,
    cc: preview.cc,
    bcc: preview.bcc,
    subject: preview.subject,
    ...(typeof preview.html === 'string' ? { html: preview.html } : {}),
    ...(typeof preview.text === 'string' ? { text: preview.text } : {}),
    attachments,
    headers: preview.headers,
    tags: preview.tags,
    ...(preview.metadata ? { metadata: preview.metadata } : {}),
    ...(preview.priority ? { priority: preview.priority } : {}),
  })
}

function createSendContext(
  messageId: string,
  resolvedDriver: ResolvedDriver,
  queued: boolean,
  deferred?: boolean,
): MailDriverExecutionContext {
  return Object.freeze({
    messageId,
    mailer: resolvedDriver.mailer,
    driver: resolvedDriver.driver,
    queued,
    ...(typeof deferred === 'boolean' ? { deferred } : {}),
  })
}

function freezeSendResult(result: MailSendResult): Readonly<MailSendResult> {
  return Object.freeze({
    ...result,
    ...(result.provider ? { provider: Object.freeze({ ...result.provider }) } : {}),
  })
}

function createBaseSendResult(
  context: MailDriverExecutionContext,
  overrides: Partial<MailSendResult> = {},
): Readonly<MailSendResult> {
  return freezeSendResult({
    messageId: context.messageId,
    mailer: context.mailer,
    driver: context.driver,
    queued: context.queued,
    ...(typeof context.deferred === 'boolean' ? { deferred: context.deferred } : {}),
    ...overrides,
  })
}

function normalizeDriverResult(
  result: MailSendResult | undefined,
  context: MailDriverExecutionContext,
): Readonly<MailSendResult> {
  if (!result) {
    return createBaseSendResult(context)
  }

  return freezeSendResult({
    messageId: result.messageId ?? context.messageId,
    mailer: result.mailer ?? context.mailer,
    driver: result.driver ?? context.driver,
    queued: typeof result.queued === 'boolean' ? result.queued : context.queued,
    ...(typeof result.deferred === 'boolean' ? { deferred: result.deferred } : {}),
    ...(typeof result.providerMessageId === 'string' ? { providerMessageId: result.providerMessageId } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
  })
}

function createMailRecord<TRecord extends FakeSentMail | MailPreviewArtifact>(
  context: MailDriverExecutionContext,
  mail: Readonly<ResolvedMail>,
  result: Readonly<MailSendResult>,
): TRecord {
  return Object.freeze({
    messageId: context.messageId,
    createdAt: new Date(),
    mail,
    context,
    result,
  }) as TRecord
}

async function persistPreviewArtifact(artifact: MailPreviewArtifact): Promise<void> {
  const mailer = getMailerConfig(artifact.context.mailer)
  if (!isPreviewMailerConfig(mailer)) {
    return
  }

  await mkdir(mailer.path, { recursive: true })
  await writeFile(
    join(mailer.path, `${artifact.messageId}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`,
    'utf8',
  )
}

function createSmtpAddress(address: MailAddress): NodemailerAddress {
  return Object.freeze({
    address: address.email,
    ...(typeof address.name === 'string' ? { name: address.name } : {}),
  })
}

function createSmtpHeaders(mail: Readonly<ResolvedMail>): Readonly<Record<string, string>> | undefined {
  const headers: Record<string, string> = { ...mail.headers }

  if (mail.tags.length > 0) {
    headers['X-Holo-Tags'] = mail.tags.join(', ')
  }

  if (mail.metadata) {
    headers['X-Holo-Metadata'] = JSON.stringify(mail.metadata)
  }

  if (mail.priority === 'high') {
    headers['X-Priority'] = '1'
    headers.Importance = 'high'
    headers.Priority = 'urgent'
  } else if (mail.priority === 'low') {
    headers['X-Priority'] = '5'
    headers.Importance = 'low'
    headers.Priority = 'non-urgent'
  } else if (mail.priority === 'normal') {
    headers['X-Priority'] = '3'
    headers.Importance = 'normal'
    headers.Priority = 'normal'
  }

  return Object.keys(headers).length > 0
    ? Object.freeze(headers)
    : undefined
}

async function createSmtpAttachment(
  attachment: ResolvedMailAttachment,
): Promise<NodemailerAttachment> {
  const base = {
    filename: attachment.name,
    ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
    contentDisposition: attachment.disposition,
    ...(typeof attachment.contentId === 'string' ? { cid: attachment.contentId } : {}),
  } satisfies Omit<NodemailerAttachment, 'path' | 'content'>

  if (typeof attachment.path === 'string') {
    return Object.freeze({
      ...base,
      path: attachment.path,
    })
  }

  if (attachment.storage) {
    const storageModule = await loadStorageModule()
    const disk = storageModule.Storage.disk(attachment.storage.disk)
    if (disk.driver !== 's3') {
      return Object.freeze({
        ...base,
        path: disk.path(attachment.storage.path),
      })
    }

    const bytes = await disk.getBytes(attachment.storage.path)
    if (!bytes) {
      throw new MailError(
        `[@holo-js/mail] Storage attachment "${attachment.storage.path}" could not be read for SMTP delivery.`,
        'MAIL_STORAGE_ATTACHMENT_MISSING',
      )
    }

    return Object.freeze({
      ...base,
      content: bytes,
    })
  }

  if (typeof attachment.content !== 'undefined') {
    return Object.freeze({
      ...base,
      content: attachment.content,
    })
  }

  throw new MailError(
    `[@holo-js/mail] Attachment "${attachment.name}" could not be translated for SMTP delivery.`,
    'MAIL_SMTP_ATTACHMENT_INVALID',
  )
}

async function createSmtpMessage(
  mail: Readonly<ResolvedMail>,
  context: Readonly<MailDriverExecutionContext>,
): Promise<NodemailerMailMessage> {
  const attachments = mail.attachments.length > 0
    ? Object.freeze(await Promise.all(mail.attachments.map(createSmtpAttachment)))
    : undefined
  const headers = createSmtpHeaders(mail)

  return Object.freeze({
    messageId: context.messageId,
    from: createSmtpAddress(mail.from),
    replyTo: createSmtpAddress(mail.replyTo),
    to: Object.freeze(mail.to.map(createSmtpAddress)),
    ...(mail.cc.length > 0 ? { cc: Object.freeze(mail.cc.map(createSmtpAddress)) } : {}),
    ...(mail.bcc.length > 0 ? { bcc: Object.freeze(mail.bcc.map(createSmtpAddress)) } : {}),
    subject: mail.subject,
    ...(typeof mail.html === 'string' ? { html: mail.html } : {}),
    ...(typeof mail.text === 'string' ? { text: mail.text } : {}),
    ...(attachments ? { attachments } : {}),
    ...(headers ? { headers } : {}),
  })
}

async function sendViaSmtp(
  mail: Readonly<ResolvedMail>,
  context: Readonly<MailDriverExecutionContext>,
): Promise<Readonly<MailSendResult>> {
  const nodemailer = await loadNodemailerModule()
  const mailerConfig = getMailerConfig(context.mailer)
  if (!isSmtpMailerConfig(mailerConfig)) {
    throw new MailError(
      `[@holo-js/mail] Mailer "${context.mailer}" is not configured for SMTP delivery.`,
      'MAIL_SMTP_MAILER_INVALID',
    )
  }

  const transporter = nodemailer.createTransport({
    host: mailerConfig.host,
    port: mailerConfig.port,
    secure: mailerConfig.secure,
    ...(typeof mailerConfig.user === 'string'
      ? {
          auth: {
            user: mailerConfig.user,
            ...(typeof mailerConfig.password === 'string' ? { pass: mailerConfig.password } : {}),
          },
        }
      : {}),
  })
  const smtpMessage = await createSmtpMessage(mail, context)
  const result = await transporter.sendMail(smtpMessage)

  return createBaseSendResult(context, {
    ...(typeof result.messageId === 'string' ? { providerMessageId: result.messageId } : {}),
    ...(typeof result.response === 'string'
      ? {
          provider: {
            response: result.response,
          },
        }
      : {}),
  })
}

const builtInDrivers: Readonly<Record<string, MailDriver>> = Object.freeze({
  preview: Object.freeze({
    async send(mail: Readonly<ResolvedMail>, context: Readonly<MailDriverExecutionContext>) {
      const result = createBaseSendResult(context)
      const artifact = createMailRecord<MailPreviewArtifact>(context, mail, result)
      getPreviewArtifactState().push(artifact)
      await persistPreviewArtifact(artifact)
      return result
    },
  }),
  fake: Object.freeze({
    send(mail: Readonly<ResolvedMail>, context: Readonly<MailDriverExecutionContext>) {
      const result = createBaseSendResult(context)
      getFakeSentState().push(createMailRecord<FakeSentMail>(context, mail, result))
      return result
    },
  }),
  log: Object.freeze({
    send(mail: Readonly<ResolvedMail>, context: Readonly<MailDriverExecutionContext>) {
      const mailerConfig = getMailerConfig(context.mailer)
      const verbose = mailerConfig.driver === 'log'
        ? (mailerConfig as typeof mailerConfig & { readonly logBodies: boolean }).logBodies
        : false

      const payload = {
        messageId: context.messageId,
        mailer: context.mailer,
        driver: context.driver,
        to: mail.to.map((address: MailAddress) => address.email),
        subject: mail.subject,
        hasHtml: typeof mail.html === 'string',
        hasText: typeof mail.text === 'string',
        attachments: mail.attachments.map((attachment: ResolvedMailAttachment) => ({
          name: attachment.name,
          source: attachment.source,
          disposition: attachment.disposition,
        })),
        ...(mail.tags.length > 0 ? { tags: [...mail.tags] } : {}),
        ...(mail.priority ? { priority: mail.priority } : {}),
        ...(verbose
          ? {
              html: mail.html,
              text: mail.text,
            }
          : {}),
      }

      console.warn('[@holo-js/mail] Logged mail send', payload)
      return createBaseSendResult(context)
    },
  }),
  smtp: Object.freeze({
    async send(mail: Readonly<ResolvedMail>, context: Readonly<MailDriverExecutionContext>) {
      return await sendViaSmtp(mail, context)
    },
  }),
})

function resolveDriver(
  mail: MailDefinition,
  options: MutableSendOptions | Readonly<MutableSendOptions>,
  config: NormalizedHoloMailConfig,
): ResolvedDriver {
  const selectedMailer = typeof options.mailer === 'string'
    ? options.mailer
    : resolveMailerName(mail, config)
  const mailerConfig = getMailerConfig(selectedMailer, config)
  const driverName = mailerConfig.driver
  const builtIn = builtInDrivers[driverName]
  if (builtIn) {
    return Object.freeze({
      mailer: selectedMailer,
      driver: driverName,
      implementation: builtIn,
    })
  }

  const registered = getRegisteredMailDriver(driverName)
  if (!registered) {
    throw new MailError(
      `[@holo-js/mail] Mail driver "${driverName}" is not registered.`,
      'MAIL_DRIVER_NOT_REGISTERED',
    )
  }

  return Object.freeze({
    mailer: selectedMailer,
    driver: driverName,
    implementation: registered.driver,
  })
}

function resolveDriverByName(
  mailer: string,
  driver: string,
): ResolvedDriver {
  const builtIn = builtInDrivers[driver]
  if (builtIn) {
    return Object.freeze({
      mailer,
      driver,
      implementation: builtIn,
    })
  }

  const registered = getRegisteredMailDriver(driver)
  if (!registered) {
    throw new MailError(
      `[@holo-js/mail] Mail driver "${driver}" is not registered.`,
      'MAIL_DRIVER_NOT_REGISTERED',
    )
  }

  return Object.freeze({
    mailer,
    driver,
    implementation: registered.driver,
  })
}

function serializeQueuedAttachment(
  attachment: ResolvedMailAttachment,
): SerializedQueuedAttachment {
  return Object.freeze({
    source: attachment.source,
    name: attachment.name,
    ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
    disposition: attachment.disposition,
    ...(typeof attachment.contentId === 'string' ? { contentId: attachment.contentId } : {}),
    ...(typeof attachment.path === 'string' ? { path: attachment.path } : {}),
    ...(attachment.storage ? { storage: attachment.storage } : {}),
    ...(typeof attachment.content === 'string'
      ? { content: attachment.content }
      : attachment.content instanceof Uint8Array
        ? {
            content: Object.freeze({
              encoding: 'base64' as const,
              value: Buffer.from(attachment.content).toString('base64'),
            }),
          }
        : {}),
  })
}

function deserializeQueuedAttachment(
  attachment: SerializedQueuedAttachment,
): ResolvedMailAttachment {
  return Object.freeze({
    source: attachment.source,
    name: attachment.name,
    ...(typeof attachment.contentType === 'string' ? { contentType: attachment.contentType } : {}),
    disposition: attachment.disposition,
    ...(typeof attachment.contentId === 'string' ? { contentId: attachment.contentId } : {}),
    ...(typeof attachment.path === 'string' ? { path: attachment.path } : {}),
    ...(attachment.storage ? { storage: attachment.storage } : {}),
    ...(typeof attachment.content === 'string'
      ? { content: attachment.content }
      : attachment.content
        ? { content: new Uint8Array(Buffer.from(attachment.content.value, 'base64')) }
        : {}),
  })
}

function createQueuedMailPayload(
  mail: ResolvedMail,
  context: MailDriverExecutionContext,
): QueuedMailDeliveryPayload {
  return Object.freeze({
    messageId: context.messageId,
    mailer: context.mailer,
    driver: context.driver,
    queued: true,
    ...(typeof context.deferred === 'boolean' ? { deferred: context.deferred } : {}),
    mail: Object.freeze({
      from: mail.from,
      replyTo: mail.replyTo,
      to: mail.to,
      cc: mail.cc,
      bcc: mail.bcc,
      subject: mail.subject,
      ...(typeof mail.html === 'string' ? { html: mail.html } : {}),
      ...(typeof mail.text === 'string' ? { text: mail.text } : {}),
      attachments: Object.freeze(mail.attachments.map(serializeQueuedAttachment)),
      headers: mail.headers,
      tags: mail.tags,
      ...(mail.metadata ? { metadata: mail.metadata } : {}),
      ...(mail.priority ? { priority: mail.priority } : {}),
    }),
  })
}

function createResolvedMailFromQueuedPayload(
  payload: QueuedMailDeliveryPayload,
): ResolvedMail {
  return Object.freeze({
    from: payload.mail.from,
    replyTo: payload.mail.replyTo,
    to: payload.mail.to,
    cc: payload.mail.cc,
    bcc: payload.mail.bcc,
    subject: payload.mail.subject,
    ...(typeof payload.mail.html === 'string' ? { html: payload.mail.html } : {}),
    ...(typeof payload.mail.text === 'string' ? { text: payload.mail.text } : {}),
    attachments: Object.freeze(payload.mail.attachments.map(deserializeQueuedAttachment)),
    headers: payload.mail.headers,
    tags: payload.mail.tags,
    ...(payload.mail.metadata ? { metadata: payload.mail.metadata } : {}),
    ...(payload.mail.priority ? { priority: payload.mail.priority } : {}),
  })
}

async function deliverResolvedMail(
  mail: ResolvedMail,
  resolvedDriver: ResolvedDriver,
  context: MailDriverExecutionContext,
): Promise<Readonly<MailSendResult>> {
  try {
    const result = await resolvedDriver.implementation.send(mail, context)
    return normalizeDriverResult(result, context)
  } catch (error) {
    throw new MailSendError({
      messageId: context.messageId,
      mailer: context.mailer,
      driver: context.driver,
    }, {
      cause: error,
    })
  }
}

async function runQueuedMailDelivery(
  payload: QueuedMailDeliveryPayload,
): Promise<Readonly<MailSendResult>> {
  const resolvedDriver = resolveDriverByName(payload.mailer, payload.driver)
  const context = Object.freeze({
    messageId: payload.messageId,
    mailer: payload.mailer,
    driver: payload.driver,
    queued: true,
    ...(typeof payload.deferred === 'boolean' ? { deferred: payload.deferred } : {}),
  }) satisfies MailDriverExecutionContext

  return await deliverResolvedMail(
    createResolvedMailFromQueuedPayload(payload),
    resolvedDriver,
    context,
  )
}

async function ensureMailQueueJobRegistered(queueModule?: QueueModule): Promise<QueueModule> {
  const resolvedQueueModule = queueModule ?? await loadQueueModule()
  if (resolvedQueueModule.getRegisteredQueueJob(HOLO_MAIL_DELIVER_JOB)) {
    return resolvedQueueModule
  }

  resolvedQueueModule.registerQueueJob(
    resolvedQueueModule.defineJob({
      async handle(payload: QueuedMailDeliveryPayload) {
        return await runQueuedMailDelivery(payload)
      },
    }),
    { name: HOLO_MAIL_DELIVER_JOB },
  )

  return resolvedQueueModule
}

async function dispatchQueuedMail(
  mail: ResolvedMail,
  context: MailDriverExecutionContext,
  plan: ResolvedQueuePlan,
): Promise<Readonly<MailSendResult>> {
  const queueModule = await ensureMailQueueJobRegistered()
  let pending = queueModule.dispatch(
    HOLO_MAIL_DELIVER_JOB,
    createQueuedMailPayload(mail, context),
  )

  if (typeof plan.connection !== 'undefined') {
    pending = pending.onConnection(plan.connection)
  }

  if (typeof plan.queue !== 'undefined') {
    pending = pending.onQueue(plan.queue)
  }

  if (typeof plan.delay !== 'undefined') {
    pending = pending.delay(plan.delay)
  }

  await pending.dispatch()
  return createBaseSendResult(context)
}

async function deferSendUntilCommit(
  context: MailDriverExecutionContext,
  callback: () => Promise<Readonly<MailSendResult>>,
): Promise<Readonly<MailSendResult> | null> {
  const dbModule = await loadDbModule()
  const active = dbModule?.connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return null
  }

  active.afterCommit(async () => {
    await callback()
  })

  return createBaseSendResult(context)
}

async function renderView(input: MailViewRenderInput): Promise<string> {
  const renderer = getRuntimeBindings().renderView
  if (!renderer) {
    throw new MailError(`[@holo-js/mail] Mail view rendering requires a renderView runtime binding for "${input.view}".`, 'MAIL_VIEW_RENDERER_MISSING')
  }

  const html = await renderer(input)
  if (typeof html !== 'string' || !html.trim()) {
    throw new MailError(`[@holo-js/mail] Mail view "${input.view}" must render a non-empty HTML string.`, 'MAIL_VIEW_RENDER_FAILED')
  }

  return html
}

function stripMarkdownSyntax(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .trim()
}

function renderMarkdownInline(markdown: string): string {
  return escapeHtml(markdown)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

function renderMarkdown(markdown: string): string {
  const blocks = markdown.trim().split(/\n\s*\n/g).map(block => block.trim()).filter(Boolean)
  return blocks.map((block) => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean)
    /* v8 ignore next 3 -- block normalization above already filters empty blocks */
    if (lines.length === 0) {
      return ''
    }

    if (lines.every(line => /^[-*]\s+/.test(line))) {
      return `<ul>${lines.map(line => `<li>${renderMarkdownInline(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`
    }

    const heading = lines.length === 1 ? lines[0]!.match(/^(#{1,6})\s+(.+)$/) : null
    if (heading) {
      const [, markers, title] = heading
      const level = markers!.length
      return `<h${level}>${renderMarkdownInline(title!)}</h${level}>`
    }

    return `<p>${lines.map(renderMarkdownInline).join('<br />')}</p>`
  }).join('\n')
}

function resolveSourceKind(mail: MailDefinition): RenderedContent['kind'] {
  if (mail.render) {
    return 'render'
  }

  if (typeof mail.markdown === 'string') {
    return 'markdown'
  }

  if (typeof mail.html === 'string') {
    return 'html'
  }

  return 'text'
}

function resolveMailerName(mail: MailDefinition, config: NormalizedHoloMailConfig): string {
  return mail.mailer ?? config.default
}

function resolveEnvelope(mail: MailDefinition): ResolvedEnvelope {
  const config = getResolvedConfig()
  const mailer = resolveMailerName(mail, config)
  const mailerConfig = getMailerConfig(mailer, config)
  const from = mail.from ?? mailerConfig.from ?? config.from
  if (!from) {
    throw new MailError('[@holo-js/mail] Mail preview requires a resolvable from address.', 'MAIL_FROM_MISSING')
  }

  const replyTo = mail.replyTo ?? mailerConfig.replyTo ?? config.replyTo ?? from

  return Object.freeze({
    config,
    mailer,
    from,
    replyTo,
    to: mail.to,
    cc: mail.cc,
    bcc: mail.bcc,
  })
}

function createMarkdownWrapperProps(
  mail: MailDefinition,
  envelope: ResolvedEnvelope,
  html: string,
  text: string,
): MailJsonObject {
  const serializeAddress = (address: MailAddress): MailJsonObject => Object.freeze({
    email: address.email,
    ...(address.name ? { name: address.name } : {}),
  })

  return Object.freeze({
    subject: mail.subject,
    html,
    markdown: mail.markdown!,
    text,
    from: serializeAddress(envelope.from),
    replyTo: serializeAddress(envelope.replyTo),
    to: Object.freeze(envelope.to.map(serializeAddress)),
    cc: Object.freeze(envelope.cc.map(serializeAddress)),
    bcc: Object.freeze(envelope.bcc.map(serializeAddress)),
    headers: Object.freeze({ ...mail.headers }),
    tags: Object.freeze([...mail.tags]),
    ...(mail.metadata ? { metadata: mail.metadata } : {}),
    ...(mail.priority ? { priority: mail.priority } : {}),
  })
}

async function renderContent(
  mail: MailDefinition,
  envelope: ResolvedEnvelope,
): Promise<RenderedContent> {
  if (mail.render) {
    const html = await renderView(mail.render)
    return Object.freeze({
      kind: 'render',
      html,
      ...(typeof mail.text === 'string' ? { text: mail.text } : {}),
      source: Object.freeze({
        kind: 'render' as const,
        render: mail.render,
      }),
    })
  }

  if (typeof mail.markdown === 'string') {
    const baseHtml = renderMarkdown(mail.markdown)
    const text = mail.text ?? stripMarkdownSyntax(mail.markdown)
    const wrapper = mail.markdownWrapper ?? envelope.config.markdown.wrapper
    const html = wrapper
      ? await renderView({
          view: wrapper,
          props: createMarkdownWrapperProps(mail, envelope, baseHtml, text),
        })
      : baseHtml

    return Object.freeze({
      kind: 'markdown',
      html,
      text,
      source: Object.freeze({
        kind: 'markdown' as const,
        markdown: mail.markdown,
      }),
    })
  }

  if (typeof mail.html === 'string') {
    return Object.freeze({
      kind: 'html',
      html: mail.html,
      ...(typeof mail.text === 'string' ? { text: mail.text } : {}),
      source: Object.freeze({
        kind: 'html' as const,
        rawHtml: mail.html,
      }),
    })
  }

  return Object.freeze({
    kind: 'text',
    text: mail.text!,
    source: Object.freeze({
      kind: 'text' as const,
    }),
  })
}

async function computePreview(
  mail: MailDefinition,
): Promise<PreviewComputation> {
  const envelope = resolveEnvelope(mail)
  const rendered = await renderContent(mail, envelope)
  const preview: MailPreviewResult = Object.freeze({
    from: envelope.from,
    replyTo: envelope.replyTo,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    subject: mail.subject,
    ...(typeof rendered.html === 'string' ? { html: rendered.html } : {}),
    ...(typeof rendered.text === 'string' ? { text: rendered.text } : {}),
    attachments: Object.freeze(mail.attachments.map(attachment => createAttachmentMetadata(attachment))),
    headers: mail.headers,
    tags: mail.tags,
    ...(mail.metadata ? { metadata: mail.metadata } : {}),
    ...(mail.priority ? { priority: mail.priority } : {}),
    source: rendered.source,
  })

  return Object.freeze({
    ...envelope,
    preview,
  })
}

class PendingSend implements PendingMailSend<MailSendResult> {
  readonly #mail: MailDefinition
  readonly #options: MutableSendOptions
  #promise?: Promise<MailSendResult>

  constructor(mail: MailDefinition, options: MutableSendOptions = {}) {
    this.#mail = mail
    this.#options = options
  }

  using(name: string): PendingSend {
    this.#options.mailer = normalizeExecutionString(name, 'Mail mailer')
    return this
  }

  onConnection(name: string): PendingSend {
    this.#options.connection = normalizeExecutionString(name, 'Mail queue connection')
    return this
  }

  onQueue(name: string): PendingSend {
    this.#options.queue = normalizeExecutionString(name, 'Mail queue name')
    return this
  }

  delay(value: MailDelayValue): PendingSend {
    this.#options.delay = normalizeExecutionDelay(value)
    return this
  }

  afterCommit(): PendingSend {
    this.#options.afterCommit = true
    return this
  }

  then<TResult1 = MailSendResult, TResult2 = never>(
    onfulfilled?: ((value: MailSendResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected)
  }

  catch<TResult1 = never>(
    onrejected?: ((reason: unknown) => TResult1 | PromiseLike<TResult1>) | null,
  ): Promise<MailSendResult | TResult1> {
    return this.execute().catch(onrejected)
  }

  finally(onfinally?: (() => void) | null): Promise<MailSendResult> {
    return this.execute().finally(onfinally)
  }

  private execute(): Promise<MailSendResult> {
    if (!this.#promise) {
      this.#promise = this.#execute()
    }

    return this.#promise
  }

  async #execute(
    execution: SendExecutionOptions = {},
  ): Promise<MailSendResult> {
    const options = Object.freeze({ ...this.#options })
    const config = getResolvedConfig()
    const resolvedDriver = resolveDriver(this.#mail, options, config)
    const plan = resolveQueuePlan(this.#mail, options, resolvedDriver.mailer, config)
    const messageId = randomUUID()

    const prepared = await prepareMailSend(this.#mail, plan.queued)
    const input: MailSendInput = Object.freeze({
      mail: this.#mail,
      attachments: prepared.attachments,
      options,
    })

    const sendOverride = getRuntimeBindings().send
    if (!plan.queued && plan.afterCommit !== true && sendOverride) {
      const context = createSendContext(messageId, resolvedDriver, false)
      return normalizeDriverResult(await sendOverride(input), context)
    }

    const { preview } = await computePreview(this.#mail)
    const resolvedMail = createResolvedMail(preview, prepared.attachments)
    const executionContext = createSendContext(
      messageId,
      resolvedDriver,
      plan.queued,
      plan.afterCommit ? true : undefined,
    )

    if (execution.allowAfterCommitDeferral !== false && plan.afterCommit) {
      const deferredResult = await deferSendUntilCommit(executionContext, async () => {
        if (plan.queued) {
          return await dispatchQueuedMail(resolvedMail, executionContext, plan)
        }

        return await deliverResolvedMail(resolvedMail, resolvedDriver, executionContext)
      })

      if (deferredResult) {
        return deferredResult
      }
    }

    if (plan.queued) {
      return await dispatchQueuedMail(
        resolvedMail,
        createSendContext(messageId, resolvedDriver, true),
        plan,
      )
    }

    return await deliverResolvedMail(
      resolvedMail,
      resolvedDriver,
      createSendContext(messageId, resolvedDriver, false),
    )
  }
}

export interface MailRuntimeFacade {
  sendMail(mail: MailDefinition | MailDefinitionInput, overrides?: MailOverrideInput): PendingMailSend<MailSendResult>
  previewMail(mail: MailDefinition | MailDefinitionInput, overrides?: MailOverrideInput): Promise<MailPreviewResult>
  renderMailPreview(
    mail: MailDefinition | MailDefinitionInput,
    overrides?: MailOverrideInput,
    format?: MailPreviewFormat,
  ): Promise<Response>
}

export function listFakeSentMails(): readonly FakeSentMail[] {
  return Object.freeze([...getFakeSentState()])
}

export function resetFakeSentMails(): void {
  getFakeSentState().length = 0
}

export function listPreviewMailArtifacts(): readonly MailPreviewArtifact[] {
  return Object.freeze([...getPreviewArtifactState()])
}

export function resetPreviewMailArtifacts(): void {
  getPreviewArtifactState().length = 0
}

function resolveMailInput(
  mail: MailDefinition | MailDefinitionInput,
  overrides?: MailOverrideInput,
): MailDefinition {
  if (!overrides || Object.keys(overrides).length === 0) {
    return normalizeMailDefinition(mail)
  }

  return normalizeMailDefinition(mergeMailDefinitionInputs(mail, overrides))
}

export function configureMailRuntime(bindings?: MailRuntimeBindings): void {
  getRuntimeState().bindings = bindings
}

export function getMailRuntimeBindings(): MailRuntimeBindings {
  return getRuntimeBindings()
}

export function resetMailRuntime(): void {
  const state = getRuntimeState()
  state.bindings = undefined
  state.fakeSent = undefined
  state.previewArtifacts = undefined
  state.loadQueueModule = undefined
  state.loadDbModule = undefined
  state.loadNodemailerModule = undefined
  state.loadStorageModule = undefined
}

export function sendMail(
  mail: MailDefinition | MailDefinitionInput,
  overrides?: MailOverrideInput,
): PendingMailSend<MailSendResult> {
  return new PendingSend(resolveMailInput(mail, overrides))
}

export async function previewMail(
  mail: MailDefinition | MailDefinitionInput,
  overrides?: MailOverrideInput,
): Promise<MailPreviewResult> {
  const normalizedMail = resolveMailInput(mail, overrides)
  const previewHandler = getRuntimeBindings().preview
  if (previewHandler) {
    return Promise.resolve(previewHandler({
      mail: normalizedMail,
    }))
  }

  return (await computePreview(normalizedMail)).preview
}

export async function renderMailPreview(
  mail: MailDefinition | MailDefinitionInput,
  overrides?: MailOverrideInput,
  format: MailPreviewFormat = 'html',
): Promise<Response> {
  const normalizedMail = resolveMailInput(mail, overrides)
  try {
    assertPreviewEnabled()
    const explicitRenderer = getRuntimeBindings().renderPreview
    if (explicitRenderer) {
      return Promise.resolve(explicitRenderer({
        mail: normalizedMail,
        format,
      }))
    }

    const preview = await previewMail(normalizedMail)
    return renderPreviewResponse(preview, format)
  } catch (error) {
    if (error instanceof MailPreviewDisabledError) {
      return new Response(error.message, {
        status: 403,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      })
    }

    if (error instanceof MailPreviewFormatUnavailableError) {
      return new Response(error.message, {
        status: 422,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
      })
    }

    throw error
  }
}

export function getMailRuntime(): MailRuntimeFacade {
  return Object.freeze({
    sendMail,
    previewMail,
    renderMailPreview,
  })
}

export const mailRuntimeInternals = {
  HOLO_MAIL_DELIVER_JOB,
  MailSendError,
  MailError,
  MailPreviewDisabledError,
  MailPreviewFormatUnavailableError,
  PendingSend,
  assertPreviewEnabled,
  builtInDrivers,
  createBaseSendResult,
  createMailRecord,
  createQueuedMailPayload,
  createResolvedMail,
  createSmtpAddress,
  createSmtpAttachment,
  createSmtpHeaders,
  createSmtpMessage,
  createSendContext,
  createResolvedMailFromQueuedPayload,
  computePreview,
  createMarkdownWrapperProps,
  createPreviewHtml,
  createPreviewPolicy,
  deferSendUntilCommit,
  deliverResolvedMail,
  deserializeQueuedAttachment,
  dispatchQueuedMail,
  dynamicImport,
  ensureMailQueueJobRegistered,
  escapeHtml,
  formatAddress,
  freezeSendResult,
  getFakeSentState,
  getMailerConfig,
  getPreviewArtifactState,
  getResolvedConfig,
  getRuntimeBindings,
  getRuntimeState,
  loadDbModule,
  loadNodemailerModule,
  loadQueueModule,
  loadStorageModule,
  isQueueRequested,
  normalizeExecutionDelay,
  normalizeExecutionString,
  normalizeDriverResult,
  persistPreviewArtifact,
  prepareMailSend,
  renderContent,
  renderMarkdown,
  renderMarkdownInline,
  renderPreviewResponse,
  renderView,
  resolveDriver,
  resolveDriverByName,
  resolveCurrentEnvironment,
  resolveEnvelope,
  resolveQueuePlan,
  resolveMailInput,
  resolveMailerName,
  resolveNodemailerModule,
  resolveSourceKind,
  resolveStorageModule,
  runQueuedMailDelivery,
  sendViaSmtp,
  serializeQueuedAttachment,
  setDbModuleLoader(loader: (() => Promise<DbModule | null>) | undefined) {
    getRuntimeState().loadDbModule = loader
  },
  setNodemailerModuleLoader(loader: (() => Promise<NodemailerModule>) | undefined) {
    getRuntimeState().loadNodemailerModule = loader
  },
  setQueueModuleLoader(loader: (() => Promise<QueueModule>) | undefined) {
    getRuntimeState().loadQueueModule = loader
  },
  setStorageModuleLoader(loader: (() => Promise<StorageModule>) | undefined) {
    getRuntimeState().loadStorageModule = loader
  },
  stripMarkdownSyntax,
}
