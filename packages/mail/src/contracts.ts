export {
  BUILT_IN_MAIL_DRIVERS,
  defineMailConfig,
  HOLO_MAIL_DEFINITION_MARKER,
  MAIL_ATTACHMENT_DISPOSITIONS,
  MAIL_PRIORITY_VALUES,
} from './contracts-types'
export type {
  BuiltInMailDriverRegistry,
  HoloMailDriverRegistry,
  MailAddress,
  MailAddressInput,
  MailAttachmentBase,
  MailAttachmentContent,
  MailAttachmentDisposition,
  MailAttachmentHelperOptions,
  MailAttachmentInput,
  MailAttachmentMetadata,
  MailAttachmentResolutionContext,
  MailAttachmentResolutionPlan,
  MailContentAttachment,
  MailContentAttachmentHelperOptions,
  MailContentSourceKind,
  MailDefinition,
  MailDefinitionInput,
  MailDelayValue,
  MailDriver,
  MailDriverExecutionContext,
  MailDriverName,
  MailDriverRegistry,
  MailJsonObject,
  MailJsonValue,
  MailOverrideInput,
  MailPathAttachment,
  MailPreviewFormat,
  MailPreviewInput,
  MailPreviewPolicy,
  MailPreviewResult,
  MailPriority,
  MailQueueOptions,
  MailRecipientsInput,
  MailRenderPreviewInput,
  MailRenderSource,
  MailResolvableAttachment,
  MailResolvedAttachmentPayload,
  MailRuntimeBindings,
  MailSendInput,
  MailSendOptions,
  MailSendResult,
  MailStorageAttachment,
  MailStorageAttachmentHelperOptions,
  MailViewRenderInput,
  MailViewRenderer,
  PendingMailSend,
  RegisterMailDriverOptions,
  RegisteredMailDriver,
  ResolvedMail,
  ResolvedMailAttachment,
} from './contracts-types'
import {
  BUILT_IN_MAIL_DRIVERS,
  HOLO_MAIL_DEFINITION_MARKER,
  MAIL_ATTACHMENT_DISPOSITIONS,
  MAIL_PRIORITY_VALUES,
  type MailAddress,
  type MailAddressInput,
  type MailAttachmentContent,
  type MailAttachmentDisposition,
  type MailAttachmentHelperOptions,
  type MailAttachmentInput,
  type MailAttachmentMetadata,
  type MailAttachmentResolutionContext,
  type MailAttachmentResolutionPlan,
  type MailContentAttachment,
  type MailContentAttachmentHelperOptions,
  type MailDefinition,
  type MailDefinitionInput,
  type MailDelayValue,
  type MailJsonObject,
  type MailJsonValue,
  type MailOverrideInput,
  type MailPathAttachment,
  type MailPriority,
  type MailQueueOptions,
  type MailRecipientsInput,
  type MailRenderSource,
  type MailStorageAttachment,
  type MailStorageAttachmentHelperOptions,
  type ResolvedMailAttachment,
} from './contracts-types'

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeOptionalString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/mail] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function normalizeRequiredString(
  value: string,
  label: string,
): string {
  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[@holo-js/mail] ${label} must be a non-empty string.`)
  }

  return normalized
}

function normalizeDelayValue(value: MailDelayValue, label: string): MailDelayValue {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`[@holo-js/mail] ${label} must be a finite number greater than or equal to 0.`)
    }

    return value
  }

  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`[@holo-js/mail] ${label} dates must be valid Date instances.`)
  }

  return value
}

function normalizeJsonValue(
  value: unknown,
  label: string,
): MailJsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry, index) => normalizeJsonValue(entry, `${label}[${index}]`)))
  }

  if (isObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      return [key, normalizeJsonValue(entry, `${label}.${key}`)]
    }))) as MailJsonObject
  }

  throw new Error(`[@holo-js/mail] ${label} must be JSON-serializable.`)
}

function normalizeHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!headers) {
    return Object.freeze({})
  }

  if (!isObject(headers)) {
    throw new Error('[@holo-js/mail] Mail headers must be a plain object when provided.')
  }

  return Object.freeze(Object.fromEntries(Object.entries(headers).map(([key, value]) => {
    const normalizedKey = normalizeRequiredString(key, 'Mail header name')
    if (typeof value !== 'string') {
      throw new Error(`[@holo-js/mail] Mail header "${normalizedKey}" must be a string.`)
    }

    return [normalizedKey, value]
  })))
}

function normalizeTags(tags: readonly string[] | undefined): readonly string[] {
  if (typeof tags === 'undefined') {
    return Object.freeze([])
  }

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    const value = normalizeRequiredString(tag, 'Mail tag')
    if (!seen.has(value)) {
      seen.add(value)
      normalized.push(value)
    }
  }

  return Object.freeze(normalized)
}

function normalizeViewIdentifier(
  value: string,
  label: string,
): string {
  const normalized = normalizeRequiredString(value, label)
  if (normalized.startsWith('/') || normalized.includes('\\')) {
    throw new Error(`[@holo-js/mail] ${label} must be a relative mail view identifier.`)
  }

  const segments = normalized.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !segment.trim())) {
    throw new Error(`[@holo-js/mail] ${label} must not include empty, "." or ".." path segments.`)
  }

  return normalized
}

function isValidEmail(value: string): boolean {
  if (value.includes(' ')) {
    return false
  }

  const parts = value.split('@')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

function normalizeAddress(
  input: MailAddressInput,
  label: string,
): MailAddress {
  const value = typeof input === 'string'
    ? { email: input }
    : input

  if (!isObject(value) || typeof value.email !== 'string') {
    throw new Error(`[@holo-js/mail] ${label} must be an email string or an object with email.`)
  }

  const email = normalizeRequiredString(value.email, `${label} email`).toLowerCase()
  if (!isValidEmail(email)) {
    throw new Error(`[@holo-js/mail] ${label} email must be a valid email address.`)
  }

  const name = typeof value.name === 'string'
    ? normalizeOptionalString(value.name, `${label} name`)
    : undefined

  return Object.freeze({
    email,
    ...(name ? { name } : {}),
  })
}

function normalizeRecipients(
  value: MailRecipientsInput | undefined,
  label: string,
  required: boolean,
): readonly MailAddress[] {
  if (typeof value === 'undefined') {
    if (required) {
      throw new Error(`[@holo-js/mail] ${label} must include at least one recipient.`)
    }

    return Object.freeze([])
  }

  const inputs = Array.isArray(value) ? value : [value]
  const recipients: MailAddress[] = []
  const seen = new Set<string>()

  for (const entry of inputs) {
    const normalized = normalizeAddress(entry, label)
    if (!seen.has(normalized.email)) {
      seen.add(normalized.email)
      recipients.push(normalized)
    }
  }

  if (required && recipients.length === 0) {
    throw new Error(`[@holo-js/mail] ${label} must include at least one recipient.`)
  }

  return Object.freeze(recipients)
}

function normalizePriority(value: MailPriority | undefined): MailPriority | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if ((MAIL_PRIORITY_VALUES as readonly string[]).includes(value)) {
    return value
  }

  throw new Error(`[@holo-js/mail] Mail priority must be one of: ${MAIL_PRIORITY_VALUES.join(', ')}.`)
}

function normalizeAttachmentDisposition(
  value: MailAttachmentDisposition | undefined,
): MailAttachmentDisposition {
  return value === 'inline' ? 'inline' : 'attachment'
}

function normalizeAttachmentContentId(
  value: string | undefined,
  disposition: MailAttachmentDisposition,
): string | undefined {
  if (typeof value === 'undefined') {
    if (disposition === 'inline') {
      throw new Error('[@holo-js/mail] Inline attachments must define a contentId.')
    }

    return undefined
  }

  const normalized = normalizeRequiredString(value.replace(/^<|>$/g, ''), 'Mail attachment contentId')
  /* v8 ignore next 3 -- normalizeRequiredString already rejects empty content IDs before this guard */
  if (disposition === 'inline' && !normalized) {
    throw new Error('[@holo-js/mail] Inline attachments must define a contentId.')
  }

  return normalized
}

function inferAttachmentName(value: MailAttachmentInput): string | undefined {
  if (typeof value.name === 'string' && value.name.trim()) {
    return value.name.trim()
  }

  if ('path' in value) {
    const parts = value.path.split('/')
    return parts[parts.length - 1]?.trim() || undefined
  }

  if ('storage' in value) {
    const parts = value.storage.path.split('/')
    return parts[parts.length - 1]?.trim() || undefined
  }

  return undefined
}

const ATTACHMENT_MIME_TYPES = Object.freeze({
  csv: 'text/csv',
  gif: 'image/gif',
  htm: 'text/html',
  html: 'text/html',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  webp: 'image/webp',
  xml: 'application/xml',
} satisfies Record<string, string>)

export function inferMimeTypeFromName(name: string | undefined): string | undefined {
  if (!name) {
    return undefined
  }

  const extension = name.split('.').pop()?.trim().toLowerCase()
  if (!extension) {
    return undefined
  }

  return ATTACHMENT_MIME_TYPES[extension as keyof typeof ATTACHMENT_MIME_TYPES]
}

function inferAttachmentSource(value: MailAttachmentInput): MailAttachmentMetadata['source'] {
  if ('path' in value) {
    return 'path'
  }

  if ('storage' in value) {
    return 'storage'
  }

  if ('content' in value) {
    return 'content'
  }

  return 'resolve'
}

export function createAttachmentMetadata(
  attachment: MailAttachmentInput,
): MailAttachmentMetadata {
  return Object.freeze({
    source: inferAttachmentSource(attachment),
    name: inferAttachmentName(attachment),
    contentType: attachment.contentType ?? inferMimeTypeFromName(inferAttachmentName(attachment)),
    disposition: attachment.disposition ?? 'attachment',
    contentId: attachment.contentId,
  })
}

function normalizeAttachment(input: MailAttachmentInput, index: number): MailAttachmentInput {
  if (!isObject(input)) {
    throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} must be a plain object.`)
  }

  const disposition = normalizeAttachmentDisposition(input.disposition)
  const contentId = normalizeAttachmentContentId(input.contentId, disposition)
  const name = inferAttachmentName(input)
  const contentType = typeof input.contentType === 'string'
    ? normalizeRequiredString(input.contentType, `Mail attachment #${index + 1} contentType`)
    : inferMimeTypeFromName(name)
  const base = {
    ...(name ? { name } : {}),
    ...(contentType
      ? { contentType }
      : {}),
    disposition,
    ...(contentId ? { contentId } : {}),
  }

  if ('path' in input) {
    if (typeof input.path !== 'string') {
      throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} path attachments must include a path.`)
    }

    return Object.freeze({
      ...base,
      path: normalizeRequiredString(input.path, `Mail attachment #${index + 1} path`),
    })
  }

  if ('storage' in input) {
    if (!isObject(input.storage) || typeof input.storage.path !== 'string') {
      throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} storage attachments must include a path.`)
    }

    return Object.freeze({
      ...base,
      storage: Object.freeze({
        path: normalizeRequiredString(input.storage.path, `Mail attachment #${index + 1} storage path`),
        ...(typeof input.storage.disk === 'string'
          ? { disk: normalizeRequiredString(input.storage.disk, `Mail attachment #${index + 1} storage disk`) }
          : {}),
      }),
    })
  }

  if ('content' in input) {
    if (!(typeof input.content === 'string' || input.content instanceof Uint8Array)) {
      throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} content attachments must use a string or Uint8Array.`)
    }

    const attachmentName = name ?? normalizeOptionalString(input.name, `Mail attachment #${index + 1} name`)
    if (!attachmentName) {
      throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} content attachments must define a name.`)
    }

    return Object.freeze({
      ...base,
      name: attachmentName,
      content: input.content,
    })
  }

  if ('resolve' in input) {
    if (typeof input.resolve !== 'function') {
      throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} resolve attachments must define resolve().`)
    }

    return Object.freeze({
      ...base,
      resolve: input.resolve,
    })
  }

  throw new Error(`[@holo-js/mail] Mail attachment #${index + 1} must define path, storage, content, or resolve.`)
}

function normalizeAttachments(attachments: readonly MailAttachmentInput[] | undefined): readonly MailAttachmentInput[] {
  if (typeof attachments === 'undefined') {
    return Object.freeze([])
  }

  return Object.freeze(attachments.map((attachment, index) => normalizeAttachment(attachment, index)))
}

export function resolveNormalizedAttachment(
  attachment: MailAttachmentInput,
): ResolvedMailAttachment {
  const metadata = createAttachmentMetadata(attachment)
  const name = metadata.name
  if (!name) {
    throw new Error('[@holo-js/mail] Attachments must resolve to a named attachment before sending.')
  }

  if ('path' in attachment) {
    return Object.freeze({
      ...metadata,
      name,
      path: attachment.path,
    })
  }

  if ('storage' in attachment) {
    return Object.freeze({
      ...metadata,
      name,
      storage: attachment.storage,
    })
  }

  if ('content' in attachment) {
    return Object.freeze({
      ...metadata,
      name,
      content: attachment.content,
    })
  }

  throw new Error('[@holo-js/mail] Resolver attachments must be resolved before creating transport attachments.')
}

export function isAttachmentQueueSafe(attachment: MailAttachmentInput): boolean {
  return !('resolve' in attachment)
}

export async function resolveAttachmentDefinition(
  attachment: MailAttachmentInput,
): Promise<MailAttachmentInput> {
  if (!('resolve' in attachment)) {
    return attachment
  }

  const resolvedPayload = await attachment.resolve()
  if (!isObject(resolvedPayload)) {
    throw new Error('[@holo-js/mail] Attachment resolvers must return a plain object payload.')
  }

  const merged = {
    ...resolvedPayload,
    ...(attachment.name ? { name: attachment.name } : {}),
    ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
    ...(attachment.disposition ? { disposition: attachment.disposition } : {}),
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
  } as MailAttachmentInput
  const normalized = normalizeAttachment(merged, 0)
  if ('resolve' in normalized) {
    throw new Error('[@holo-js/mail] Attachment resolvers must resolve to a path, storage, or content attachment.')
  }

  return normalized
}

export function createAttachmentResolutionPlan(
  attachment: MailAttachmentInput,
  context: MailAttachmentResolutionContext,
): MailAttachmentResolutionPlan {
  const metadata = createAttachmentMetadata(attachment)
  const queuedSafe = isAttachmentQueueSafe(attachment)

  if (context.queued && !queuedSafe) {
    throw new Error('[@holo-js/mail] Resolver attachments are not queue-safe and cannot be used when queueing is requested.')
  }

  return Object.freeze({
    ...metadata,
    queuedSafe,
    async resolve() {
      const normalized = await resolveAttachmentDefinition(attachment)
      return resolveNormalizedAttachment(normalized)
    },
  })
}

export function createAttachmentResolutionPlans(
  attachments: readonly MailAttachmentInput[],
  context: MailAttachmentResolutionContext,
): readonly MailAttachmentResolutionPlan[] {
  return Object.freeze(attachments.map(attachment => createAttachmentResolutionPlan(attachment, context)))
}

function normalizeRenderSource(render: MailRenderSource | undefined): Readonly<MailRenderSource> | undefined {
  if (typeof render === 'undefined') {
    return undefined
  }

  if (!isObject(render)) {
    throw new Error('[@holo-js/mail] Mail render sources must be plain objects when provided.')
  }

  return Object.freeze({
    view: normalizeViewIdentifier(render.view, 'Mail render view'),
    ...(typeof render.props === 'undefined'
      ? {}
      : { props: normalizeJsonValue(render.props, 'Mail render props') as MailJsonObject }),
  })
}

function normalizeQueueOptions(value: boolean | MailQueueOptions | undefined): boolean | Readonly<MailQueueOptions> | undefined {
  if (typeof value === 'undefined' || typeof value === 'boolean') {
    return value
  }

  return Object.freeze({
    ...(typeof value.queued === 'boolean' ? { queued: value.queued } : {}),
    ...(typeof value.connection === 'string'
      ? { connection: normalizeRequiredString(value.connection, 'Mail queue connection') }
      : {}),
    ...(typeof value.queue === 'string'
      ? { queue: normalizeRequiredString(value.queue, 'Mail queue name') }
      : {}),
    ...(typeof value.afterCommit === 'boolean' ? { afterCommit: value.afterCommit } : {}),
  })
}

function normalizeTextLikeContent(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  return normalizeRequiredString(value, label)
}

function normalizeContentSource(
  input: MailDefinitionInput,
): Pick<MailDefinition, 'text' | 'html' | 'markdown' | 'render' | 'markdownWrapper'> {
  const text = normalizeTextLikeContent(input.text, 'Mail text')
  const html = normalizeTextLikeContent(input.html, 'Mail html')
  const markdown = normalizeTextLikeContent(input.markdown, 'Mail markdown')
  const render = normalizeRenderSource(input.render)
  const markdownWrapper = typeof input.markdownWrapper === 'string'
    ? normalizeViewIdentifier(input.markdownWrapper, 'Mail markdown wrapper')
    : undefined

  const primaryKinds = [
    typeof html === 'string' ? 'html' : undefined,
    typeof markdown === 'string' ? 'markdown' : undefined,
    render ? 'render' : undefined,
    typeof text === 'string' && !html && !markdown && !render ? 'text' : undefined,
  ].filter(Boolean)

  if (primaryKinds.length !== 1) {
    throw new Error('[@holo-js/mail] Mail definitions must define exactly one primary content source.')
  }

  if (markdownWrapper && !markdown) {
    throw new Error('[@holo-js/mail] Mail markdown wrappers are only valid for markdown mails.')
  }

  return {
    ...(typeof text === 'string' ? { text } : {}),
    ...(typeof html === 'string' ? { html } : {}),
    ...(typeof markdown === 'string' ? { markdown } : {}),
    ...(render ? { render } : {}),
    ...(markdownWrapper ? { markdownWrapper } : {}),
  }
}

export function isMailDefinition(value: unknown): value is MailDefinition {
  return !!value
    && typeof value === 'object'
    && (value as { [HOLO_MAIL_DEFINITION_MARKER]?: unknown })[HOLO_MAIL_DEFINITION_MARKER] === true
}

export function mergeMailDefinitionInputs(
  base: MailDefinition | MailDefinitionInput,
  overrides: MailOverrideInput | undefined,
): MailDefinitionInput {
  if (!overrides || Object.keys(overrides).length === 0) {
    return isMailDefinition(base) ? { ...base } : { ...base }
  }

  return {
    ...base,
    ...overrides,
    headers: {
      ...(base.headers ?? {}),
      ...(overrides.headers ?? {}),
    },
    metadata: {
      ...((base.metadata ?? {}) as MailJsonObject),
      ...((overrides.metadata ?? {}) as MailJsonObject),
    },
  }
}

export function normalizeMailDefinition(
  input: MailDefinition | MailDefinitionInput,
): MailDefinition {
  if (isMailDefinition(input)) {
    return input
  }

  if (!isObject(input)) {
    throw new Error('[@holo-js/mail] Mail definitions must be plain objects.')
  }

  const subject = normalizeRequiredString(input.subject, 'Mail subject')
  const mailer = typeof input.mailer === 'string'
    ? normalizeRequiredString(input.mailer, 'Mail mailer')
    : undefined
  const from = typeof input.from !== 'undefined'
    ? normalizeAddress(input.from, 'Mail from')
    : undefined
  const replyTo = typeof input.replyTo !== 'undefined'
    ? normalizeAddress(input.replyTo, 'Mail replyTo')
    : undefined
  const metadata = typeof input.metadata === 'undefined'
    ? undefined
    : normalizeJsonValue(input.metadata, 'Mail metadata') as MailJsonObject
  const normalized: MailDefinition = {
    ...(mailer ? { mailer } : {}),
    ...(from ? { from } : {}),
    ...(replyTo ? { replyTo } : {}),
    to: normalizeRecipients(input.to, 'Mail to', true),
    cc: normalizeRecipients(input.cc, 'Mail cc', false),
    bcc: normalizeRecipients(input.bcc, 'Mail bcc', false),
    subject,
    ...normalizeContentSource(input),
    attachments: normalizeAttachments(input.attachments),
    headers: normalizeHeaders(input.headers),
    tags: normalizeTags(input.tags),
    ...(metadata ? { metadata } : {}),
    ...(normalizePriority(input.priority) ? { priority: normalizePriority(input.priority) } : {}),
    ...(typeof input.queue === 'undefined' ? {} : { queue: normalizeQueueOptions(input.queue) }),
    ...(typeof input.delay === 'undefined'
      ? {}
      : { delay: normalizeDelayValue(input.delay, 'Mail delay') }),
  }

  Object.defineProperty(normalized, HOLO_MAIL_DEFINITION_MARKER, {
    value: true,
    enumerable: false,
  })

  return Object.freeze(normalized)
}

export function defineMail<TMail extends MailDefinitionInput>(input: TMail): MailDefinition {
  return normalizeMailDefinition(input)
}

export function attachFromPath(
  path: string,
  options: MailAttachmentHelperOptions = {},
): MailPathAttachment {
  return Object.freeze({
    path,
    ...options,
  })
}

export function attachFromStorage(
  path: string,
  options: MailStorageAttachmentHelperOptions = {},
): MailStorageAttachment {
  return Object.freeze({
    storage: Object.freeze({
      path,
      ...(typeof options.disk === 'string' ? { disk: options.disk } : {}),
    }),
    ...(typeof options.name === 'string' ? { name: options.name } : {}),
    ...(typeof options.contentType === 'string' ? { contentType: options.contentType } : {}),
    ...(typeof options.disposition === 'string' ? { disposition: options.disposition } : {}),
    ...(typeof options.contentId === 'string' ? { contentId: options.contentId } : {}),
  })
}

export function attachContent(
  content: MailAttachmentContent,
  options: MailContentAttachmentHelperOptions,
): MailContentAttachment {
  return Object.freeze({
    content,
    ...options,
  })
}

export const mailInternals = {
  BUILT_IN_MAIL_DRIVERS,
  HOLO_MAIL_DEFINITION_MARKER,
  MAIL_ATTACHMENT_DISPOSITIONS,
  MAIL_PRIORITY_VALUES,
  attachContent,
  attachFromPath,
  attachFromStorage,
  createAttachmentMetadata,
  createAttachmentResolutionPlan,
  createAttachmentResolutionPlans,
  inferMimeTypeFromName,
  inferAttachmentName,
  inferAttachmentSource,
  isObject,
  isAttachmentQueueSafe,
  isValidEmail,
  mergeMailDefinitionInputs,
  normalizeAddress,
  normalizeAttachment,
  normalizeAttachments,
  normalizeDelayValue,
  normalizeHeaders,
  normalizeJsonValue,
  normalizeMailDefinition,
  normalizeOptionalString,
  normalizePriority,
  normalizeQueueOptions,
  normalizeRecipients,
  normalizeRenderSource,
  normalizeRequiredString,
  resolveAttachmentDefinition,
  resolveNormalizedAttachment,
  normalizeTags,
  normalizeViewIdentifier,
}
