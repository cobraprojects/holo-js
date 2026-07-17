export type HoloAppEnv = 'development' | 'production' | 'test'

export function normalizeMailEnvironment(
  value: string | undefined,
  fallback: HoloAppEnv = 'development',
): HoloAppEnv {
  return value === 'development' || value === 'production' || value === 'test' ? value : fallback
}

export interface HoloMailAddressConfig {
  readonly email: string
  readonly name?: string
}

export interface HoloMailQueueConfig {
  readonly queued?: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit?: boolean
}

export interface HoloMailPreviewConfig {
  readonly allowedEnvironments?: readonly HoloAppEnv[]
}

export interface HoloMailMarkdownConfig {
  readonly wrapper?: string
}

export interface BaseMailDriverConfig {
  readonly driver: string
  readonly from?: HoloMailAddressConfig
  readonly replyTo?: HoloMailAddressConfig
  readonly queue?: HoloMailQueueConfig
}

export interface PreviewMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'preview'
  readonly path?: string
}

export interface LogMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'log'
  readonly logBodies?: boolean
}

export interface FakeMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'fake'
}

export interface SmtpMailDriverConfig extends BaseMailDriverConfig {
  readonly driver: 'smtp'
  readonly host?: string
  readonly port?: number | string
  readonly secure?: boolean
  readonly user?: string
  readonly password?: string
}

export type HoloMailMailerConfig
  = PreviewMailDriverConfig
  | LogMailDriverConfig
  | FakeMailDriverConfig
  | SmtpMailDriverConfig
  | (BaseMailDriverConfig & Record<string, unknown>)

export interface HoloMailConfig {
  readonly default?: string
  readonly from?: HoloMailAddressConfig
  readonly replyTo?: HoloMailAddressConfig
  readonly queue?: HoloMailQueueConfig
  readonly preview?: HoloMailPreviewConfig
  readonly markdown?: HoloMailMarkdownConfig
  readonly mailers?: Readonly<Record<string, HoloMailMailerConfig>>
}

export interface NormalizedHoloMailAddressConfig {
  readonly email: string
  readonly name?: string
}

export interface NormalizedHoloMailQueueConfig {
  readonly queued: boolean
  readonly connection?: string
  readonly queue?: string
  readonly afterCommit: boolean
}

export interface NormalizedHoloMailPreviewConfig {
  readonly allowedEnvironments: readonly HoloAppEnv[]
}

export interface NormalizedHoloMailMarkdownConfig {
  readonly wrapper?: string
}

export interface NormalizedBaseMailDriverConfig {
  readonly name: string
  readonly driver: string
  readonly from?: NormalizedHoloMailAddressConfig
  readonly replyTo?: NormalizedHoloMailAddressConfig
  readonly queue: NormalizedHoloMailQueueConfig
}

export interface NormalizedPreviewMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'preview'
  readonly path: string
}

export interface NormalizedLogMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'log'
  readonly logBodies: boolean
}

export interface NormalizedFakeMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'fake'
}

export interface NormalizedSmtpMailDriverConfig extends NormalizedBaseMailDriverConfig {
  readonly driver: 'smtp'
  readonly host: string
  readonly port: number
  readonly secure: boolean
  readonly user?: string
  readonly password?: string
}

export type NormalizedHoloMailMailerConfig
  = NormalizedPreviewMailDriverConfig
  | NormalizedLogMailDriverConfig
  | NormalizedFakeMailDriverConfig
  | NormalizedSmtpMailDriverConfig
  | NormalizedBaseMailDriverConfig

export interface NormalizedHoloMailConfig {
  readonly default: string
  readonly from?: NormalizedHoloMailAddressConfig
  readonly replyTo?: NormalizedHoloMailAddressConfig
  readonly queue: NormalizedHoloMailQueueConfig
  readonly preview: NormalizedHoloMailPreviewConfig
  readonly markdown: NormalizedHoloMailMarkdownConfig
  readonly mailers: Readonly<Record<string, NormalizedHoloMailMailerConfig>>
}

export const DEFAULT_MAILER_NAME = 'preview'
export const DEFAULT_MAIL_PREVIEW_PATH = '.holo-js/runtime/mail-preview'
export const DEFAULT_SMTP_HOST = '127.0.0.1'
export const DEFAULT_SMTP_PORT = 1025

const DEFAULT_MAIL_QUEUE_CONFIG: Readonly<NormalizedHoloMailQueueConfig> = Object.freeze({
  queued: false,
  connection: undefined,
  queue: undefined,
  afterCommit: false,
})

export const holoMailDefaults: Readonly<NormalizedHoloMailConfig> = Object.freeze({
  default: DEFAULT_MAILER_NAME,
  from: undefined,
  replyTo: undefined,
  queue: DEFAULT_MAIL_QUEUE_CONFIG,
  preview: Object.freeze({
    allowedEnvironments: Object.freeze(['development'] as const),
  }),
  markdown: Object.freeze({
    wrapper: undefined,
  }),
  mailers: Object.freeze({
    preview: Object.freeze({
      name: 'preview',
      driver: 'preview' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      path: DEFAULT_MAIL_PREVIEW_PATH,
    }),
    log: Object.freeze({
      name: 'log',
      driver: 'log' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      logBodies: false,
    }),
    fake: Object.freeze({
      name: 'fake',
      driver: 'fake' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
    }),
    smtp: Object.freeze({
      name: 'smtp',
      driver: 'smtp' as const,
      from: undefined,
      replyTo: undefined,
      queue: DEFAULT_MAIL_QUEUE_CONFIG,
      host: DEFAULT_SMTP_HOST,
      port: DEFAULT_SMTP_PORT,
      secure: false,
    }),
  }),
})

function normalizeOptionalMailString(
  value: string | undefined,
  label: string,
): string | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  const normalized = value.trim()
  if (!normalized) {
    throw new Error(`[Holo Mail] ${label} must be a non-empty string when provided.`)
  }

  return normalized
}

function isValidMailAddress(email: string): boolean {
  if (email.includes(' ')) {
    return false
  }

  const parts = email.split('@')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

function normalizeMailAddress(
  address: HoloMailAddressConfig | undefined,
  label: string,
): NormalizedHoloMailAddressConfig | undefined {
  if (!address) {
    return undefined
  }

  const email = normalizeOptionalMailString(address.email, `${label} email`)?.toLowerCase()
  if (!email || !isValidMailAddress(email)) {
    throw new Error(`[Holo Mail] ${label} email must be a valid email address.`)
  }

  const name = normalizeOptionalMailString(address.name, `${label} name`)

  return Object.freeze({
    email,
    ...(name ? { name } : {}),
  })
}

function normalizeMailQueueConfig(
  queue: HoloMailQueueConfig | undefined,
  fallback: NormalizedHoloMailQueueConfig = holoMailDefaults.queue,
): NormalizedHoloMailQueueConfig {
  return Object.freeze({
    queued: queue?.queued ?? fallback.queued,
    connection: normalizeOptionalMailString(queue?.connection, 'Mail queue connection') ?? fallback.connection,
    queue: normalizeOptionalMailString(queue?.queue, 'Mail queue name') ?? fallback.queue,
    afterCommit: queue?.afterCommit ?? fallback.afterCommit,
  })
}

function normalizeMailPreviewEnvironments(
  environments: readonly HoloAppEnv[] | undefined,
): readonly HoloAppEnv[] {
  if (typeof environments === 'undefined') {
    return holoMailDefaults.preview.allowedEnvironments
  }

  const normalized = new Set<HoloAppEnv>()
  for (const environment of environments) {
    if (environment !== 'development' && environment !== 'production' && environment !== 'test') {
      throw new Error('[Holo Mail] Mail preview environments must be development, production, or test.')
    }

    normalized.add(environment)
  }

  return Object.freeze([...normalized])
}

function normalizeMailMailerConfig(
  name: string,
  config: HoloMailMailerConfig,
  fallback: NormalizedHoloMailMailerConfig | undefined,
): NormalizedHoloMailMailerConfig {
  const normalizedName = normalizeOptionalMailString(name, 'Mail mailer name')
  const driver = normalizeOptionalMailString(config.driver, `Mail mailer "${name}" driver`)
  if (!normalizedName || !driver) {
    throw new Error('[Holo Mail] Mailers must define a name and driver.')
  }

  const base = {
    name: normalizedName,
    driver,
    from: normalizeMailAddress(config.from, `Mail mailer "${name}" from`) ?? fallback?.from,
    replyTo: normalizeMailAddress(config.replyTo, `Mail mailer "${name}" replyTo`) ?? fallback?.replyTo,
    queue: normalizeMailQueueConfig(config.queue, fallback?.queue ?? holoMailDefaults.queue),
  } satisfies NormalizedHoloMailMailerConfig

  if (driver === 'preview') {
    const previewFallback = fallback?.driver === 'preview'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'preview' }>
      : undefined

    return Object.freeze({
      ...base,
      driver: 'preview' as const,
      path: normalizeOptionalMailString((config as { path?: string }).path, `Mail mailer "${name}" preview path`)
        ?? previewFallback?.path
        ?? DEFAULT_MAIL_PREVIEW_PATH,
    })
  }

  if (driver === 'log') {
    const logFallback = fallback?.driver === 'log'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'log' }>
      : undefined

    return Object.freeze({
      ...base,
      driver: 'log' as const,
      logBodies: (config as { logBodies?: boolean }).logBodies ?? logFallback?.logBodies ?? false,
    })
  }

  if (driver === 'fake') {
    return Object.freeze({
      ...base,
      driver: 'fake' as const,
    })
  }

  if (driver === 'smtp') {
    const smtpFallback = fallback?.driver === 'smtp'
      ? fallback as Extract<NormalizedHoloMailMailerConfig, { readonly driver: 'smtp' }>
      : undefined
    const rawPort = (config as { port?: string | number }).port
    const normalizedPort = typeof rawPort === 'number'
      ? rawPort
      : typeof rawPort === 'string' && rawPort.trim()
        ? Number(rawPort.trim())
        : smtpFallback?.port
          ?? DEFAULT_SMTP_PORT

    if (!Number.isFinite(normalizedPort) || normalizedPort <= 0) {
      throw new Error(`[Holo Mail] Mail mailer "${name}" SMTP port must be a positive number.`)
    }

    return Object.freeze({
      ...base,
      driver: 'smtp' as const,
      host: normalizeOptionalMailString((config as { host?: string }).host, `Mail mailer "${name}" SMTP host`)
        ?? smtpFallback?.host
        ?? DEFAULT_SMTP_HOST,
      port: normalizedPort,
      secure: (config as { secure?: boolean }).secure ?? smtpFallback?.secure ?? false,
      user: normalizeOptionalMailString((config as { user?: string }).user, `Mail mailer "${name}" SMTP user`)
        ?? smtpFallback?.user
        ?? undefined,
      password: normalizeOptionalMailString((config as { password?: string }).password, `Mail mailer "${name}" SMTP password`)
        ?? smtpFallback?.password
        ?? undefined,
    })
  }

  const customFields = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== 'driver' && key !== 'from' && key !== 'replyTo' && key !== 'queue'),
  )

  return Object.freeze({
    ...base,
    ...customFields,
  })
}

export function normalizeMailConfig(
  config: HoloMailConfig = {},
): NormalizedHoloMailConfig {
  const mergedMailers = {
    ...(holoMailDefaults.mailers as Record<string, NormalizedHoloMailMailerConfig>),
  }

  for (const [name, mailer] of Object.entries(config.mailers ?? {})) {
    mergedMailers[name] = normalizeMailMailerConfig(name, mailer, mergedMailers[name])
  }

  const defaultMailer = normalizeOptionalMailString(config.default, 'Default mailer')
    ?? holoMailDefaults.default

  if (!mergedMailers[defaultMailer]) {
    throw new Error(
      `[Holo Mail] default mailer "${defaultMailer}" is not configured. `
      + `Available mailers: ${Object.keys(mergedMailers).join(', ')}`,
    )
  }

  return Object.freeze({
    default: defaultMailer,
    from: normalizeMailAddress(config.from, 'Mail from') ?? holoMailDefaults.from,
    replyTo: normalizeMailAddress(config.replyTo, 'Mail replyTo') ?? holoMailDefaults.replyTo,
    queue: normalizeMailQueueConfig(config.queue),
    preview: Object.freeze({
      allowedEnvironments: normalizeMailPreviewEnvironments(config.preview?.allowedEnvironments),
    }),
    markdown: Object.freeze({
      wrapper: normalizeOptionalMailString(config.markdown?.wrapper, 'Mail markdown wrapper') ?? holoMailDefaults.markdown.wrapper,
    }),
    mailers: Object.freeze(mergedMailers),
  })
}

export function defineMailConfig<TConfig extends HoloMailConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloMailConfig, NormalizedHoloMailConfig>({
  name: 'mail',
  normalize: normalizeMailConfig,
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    mail: NormalizedHoloMailConfig
  }
}
