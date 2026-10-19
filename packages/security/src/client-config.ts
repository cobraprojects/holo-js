import type { NormalizedHoloSecurityConfig } from './config'
import type { SecurityClientConfig } from './contracts'

export const SECURITY_CLIENT_CONFIG_COOKIE = 'HOLO-CSRF-CONFIG'
export const SECURITY_XSRF_HEADER = 'X-XSRF-TOKEN'

const DEFAULT_SECURITY_CLIENT_CONFIG: SecurityClientConfig = Object.freeze({
  csrf: Object.freeze({
    field: '_token',
    header: 'X-CSRF-TOKEN',
    cookie: 'XSRF-TOKEN',
  }),
})

function safeDecodeCookieValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function parseCookieHeader(header: string | null | undefined): Readonly<Record<string, string>> {
  if (!header) {
    return Object.freeze({})
  }

  const entries = header
    .split(';')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const separator = segment.indexOf('=')
      if (separator <= 0) {
        return undefined
      }

      const name = safeDecodeCookieValue(segment.slice(0, separator))
      const value = safeDecodeCookieValue(segment.slice(separator + 1))

      return name && typeof value === 'string'
        ? [name, value] as const
        : undefined
    })
    .filter((entry): entry is readonly [string, string] => typeof entry !== 'undefined')

  return Object.freeze(Object.fromEntries(entries))
}

type SerializedSecurityClientConfig = {
  readonly csrf: Omit<SecurityClientConfig['csrf'], 'header'> & { readonly header?: string }
}

function isSecurityClientConfig(value: unknown): value is SerializedSecurityClientConfig {
  return !!value
    && typeof value === 'object'
    && !!(value as { readonly csrf?: unknown }).csrf
    && typeof (value as { readonly csrf: { readonly field?: unknown } }).csrf.field === 'string'
    && ['string', 'undefined'].includes(typeof (value as { readonly csrf: { readonly header?: unknown } }).csrf.header)
    && typeof (value as { readonly csrf: { readonly cookie?: unknown } }).csrf.cookie === 'string'
}

export function getDefaultSecurityClientConfig(): SecurityClientConfig {
  return DEFAULT_SECURITY_CLIENT_CONFIG
}

export function createSecurityClientConfig(config: NormalizedHoloSecurityConfig): SecurityClientConfig {
  return Object.freeze({
    csrf: Object.freeze({
      field: config.csrf.field,
      cookie: config.csrf.cookie,
      header: config.csrf.header,
    }),
  })
}

export function serializeSecurityClientConfig(config: SecurityClientConfig): string {
  return JSON.stringify(config)
}

function parseSecurityClientConfig(raw: string | undefined): SerializedSecurityClientConfig | undefined {
  if (!raw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isSecurityClientConfig(parsed)) {
      return undefined
    }

    return parsed
  } catch {
    return undefined
  }
}

export function readSecurityClientConfigFromCookies(cookieHeader: string | null | undefined): SecurityClientConfig | undefined {
  const parsed = parseSecurityClientConfig(parseCookieHeader(cookieHeader)[SECURITY_CLIENT_CONFIG_COOKIE])
  return parsed ? Object.freeze({
      csrf: Object.freeze({
        field: parsed.csrf.field,
        header: parsed.csrf.header ?? DEFAULT_SECURITY_CLIENT_CONFIG.csrf.header,
        cookie: parsed.csrf.cookie,
      }),
    }) : undefined
}

function getCsrfRequestHeaders(cookieHeader: string | undefined): Readonly<Record<string, string>> {
  const cookies = parseCookieHeader(cookieHeader)
  const config = parseSecurityClientConfig(cookies[SECURITY_CLIENT_CONFIG_COOKIE]) ?? DEFAULT_SECURITY_CLIENT_CONFIG
  const token = cookies[config.csrf.cookie]
  return token ? { [SECURITY_XSRF_HEADER]: token } : {}
}

export const securityClientConfigInternals = {
  parseCookieHeader,
  getCsrfRequestHeaders,
}
