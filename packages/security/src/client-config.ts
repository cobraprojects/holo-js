import type { NormalizedHoloSecurityConfig } from '@holo-js/config'
import type { SecurityClientConfig } from './contracts'

export const SECURITY_CLIENT_CONFIG_COOKIE = 'HOLO-CSRF-CONFIG'

const DEFAULT_SECURITY_CLIENT_CONFIG: SecurityClientConfig = Object.freeze({
  csrf: Object.freeze({
    field: '_token',
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

function isSecurityClientConfig(value: unknown): value is SecurityClientConfig {
  return !!value
    && typeof value === 'object'
    && !!(value as { readonly csrf?: unknown }).csrf
    && typeof (value as { readonly csrf: { readonly field?: unknown } }).csrf.field === 'string'
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
    }),
  })
}

export function serializeSecurityClientConfig(config: SecurityClientConfig): string {
  return JSON.stringify(config)
}

export function readSecurityClientConfigFromCookies(cookieHeader: string | null | undefined): SecurityClientConfig | undefined {
  const raw = parseCookieHeader(cookieHeader)[SECURITY_CLIENT_CONFIG_COOKIE]
  if (!raw) {
    return undefined
  }

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isSecurityClientConfig(parsed)) {
      return undefined
    }

    return Object.freeze({
      csrf: Object.freeze({
        field: parsed.csrf.field,
        cookie: parsed.csrf.cookie,
      }),
    })
  } catch {
    return undefined
  }
}

export const securityClientConfigInternals = {
  parseCookieHeader,
}
