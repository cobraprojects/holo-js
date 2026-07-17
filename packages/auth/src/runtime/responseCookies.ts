import type {
  NormalizedAuthClerkProviderConfig,
  NormalizedAuthWorkosProviderConfig,
  NormalizedHoloAuthClerkConfig,
  NormalizedHoloAuthWorkosConfig,
} from '../config'
import {
  type CookieOptions,
  type CookieSerializationOptions,
  serializeCookie,
} from './cookieSerialization'
import { parseSetCookieDefinition } from './setCookieParser'

type NormalizedHostedProviderConfig = NormalizedAuthWorkosProviderConfig | NormalizedAuthClerkProviderConfig

type AuthCookieBindings = {
  readonly config: {
    readonly defaults: { readonly guard: string }
    readonly workos: NormalizedHoloAuthWorkosConfig
    readonly clerk: NormalizedHoloAuthClerkConfig
  }
  readonly session: {
    cookie?(name: string, value: string, options: CookieSerializationOptions): string
    sessionCookie(value: string): string
    rememberMeCookie(value: string): string
  }
}

function forgetCookie(
  bindings: AuthCookieBindings,
  name: string,
  options: CookieOptions = {},
): string {
  const cookieOptions = {
    ...options,
    expires: new Date(0),
    maxAge: 0,
  } satisfies CookieSerializationOptions

  if (bindings.session.cookie) {
    return bindings.session.cookie(name, '', cookieOptions)
  }

  return serializeCookie(name, '', cookieOptions)
}

function getHostedSessionCookieNamesForGuard(
  config: AuthCookieBindings['config'],
  guardName: string,
): readonly string[] {
  const names = new Set<string>()
  for (const provider of Object.values(config.workos)) {
    if (!isHostedProviderConfig(provider)) {
      continue
    }
    if ((provider.guard ?? config.defaults.guard) === guardName) {
      names.add(provider.sessionCookie)
    }
  }
  for (const provider of Object.values(config.clerk)) {
    if (!isHostedProviderConfig(provider)) {
      continue
    }
    if ((provider.guard ?? config.defaults.guard) === guardName) {
      names.add(provider.sessionCookie)
    }
  }

  return [...names]
}

function isHostedProviderConfig(
  value: NormalizedHoloAuthWorkosConfig[string] | NormalizedHoloAuthClerkConfig[string],
): value is NormalizedHostedProviderConfig {
  return !!(
    value
    && typeof value === 'object'
    && 'sessionCookie' in value
    && typeof value.sessionCookie === 'string'
  )
}

export function buildLogoutCookies(
  bindings: AuthCookieBindings,
  guardName: string,
  options: {
    readonly clearSessionCookies: boolean
  },
): readonly string[] {
  const cookies: string[] = []
  const defaultSessionCookie = parseSetCookieDefinition(bindings.session.sessionCookie(''))
  const defaultRememberCookie = parseSetCookieDefinition(bindings.session.rememberMeCookie(''))

  if (options.clearSessionCookies) {
    if (defaultSessionCookie) {
      cookies.push(forgetCookie(bindings, defaultSessionCookie.name, defaultSessionCookie.options))
    }
    if (defaultRememberCookie) {
      cookies.push(forgetCookie(bindings, defaultRememberCookie.name, defaultRememberCookie.options))
    }
  }

  const hostedCookieOptions: CookieOptions = { path: '/', domain: '' }
  for (const cookieName of getHostedSessionCookieNamesForGuard(bindings.config, guardName)) {
    cookies.push(forgetCookie(bindings, cookieName, hostedCookieOptions))
  }

  return Object.freeze([...new Set(cookies)])
}

export function forgetDefaultRememberCookie(bindings: AuthCookieBindings): string | undefined {
  const rememberCookie = parseSetCookieDefinition(bindings.session.rememberMeCookie(''))
  return rememberCookie
    ? forgetCookie(bindings, rememberCookie.name, rememberCookie.options)
    : undefined
}
