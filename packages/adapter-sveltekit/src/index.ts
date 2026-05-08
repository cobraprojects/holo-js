import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import type { HoloConfigMap } from '@holo-js/config'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

type SvelteKitRequestEvent = {
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
  readonly request: {
    readonly headers: Headers
  }
}

type SvelteKitCookieOptions = {
  path: string
  domain?: string
  maxAge?: number
  expires?: Date
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  partitioned?: boolean
}

type ParsedResponseCookie = {
  readonly name: string
  readonly value: string
  readonly options: SvelteKitCookieOptions
}

type SvelteKitRuntimeGlobal = typeof globalThis & {
  __holoSvelteKitRequestEventStore?: AsyncLocalStorage<SvelteKitRequestEvent>
}

// Shared AsyncLocalStorage contract with packages/auth/src/sveltekit/server.ts:
// keep this exact global key and compatible AsyncLocalStorage<SvelteKitRequestEvent>
// / AsyncLocalStorage<SvelteKitStoredRequestEvent> value types in sync.
const svelteKitAdapter = createHoloFrameworkAdapter<SvelteKitHoloOptions>({
  stateKey: '__holoSvelteKitAdapter__',
  displayName: 'SvelteKit',
})

function getSvelteKitRequestEventStore(): AsyncLocalStorage<SvelteKitRequestEvent> {
  const runtimeGlobal = globalThis as SvelteKitRuntimeGlobal
  runtimeGlobal.__holoSvelteKitRequestEventStore ??= new AsyncLocalStorage<SvelteKitRequestEvent>()

  return runtimeGlobal.__holoSvelteKitRequestEventStore
}

function safeDecodeCookieSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseResponseCookie(cookie: string): ParsedResponseCookie | null {
  const [nameValue, ...attributes] = cookie.split(';')
  const separator = nameValue?.indexOf('=') ?? -1
  if (!nameValue || separator <= 0) {
    return null
  }

  const options: SvelteKitCookieOptions = { path: '/' }
  for (const rawAttribute of attributes) {
    const attribute = rawAttribute.trim()
    if (!attribute) {
      continue
    }

    const attributeSeparator = attribute.indexOf('=')
    const key = (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator)).trim().toLowerCase()
    const value = attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim()

    switch (key) {
      case 'path':
        options.path = value || '/'
        break
      case 'domain':
        options.domain = value
        break
      case 'max-age': {
        const maxAge = Number(value)
        if (Number.isFinite(maxAge)) {
          options.maxAge = maxAge
        }
        break
      }
      case 'expires': {
        const expires = new Date(value)
        if (!Number.isNaN(expires.getTime())) {
          options.expires = expires
        }
        break
      }
      case 'secure':
        options.secure = true
        break
      case 'httponly':
        options.httpOnly = true
        break
      case 'samesite':
        if (value.toLowerCase() === 'lax' || value.toLowerCase() === 'strict' || value.toLowerCase() === 'none') {
          options.sameSite = value.toLowerCase() as SvelteKitCookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = value ? value.toLowerCase() === 'true' : true
        break
    }
  }

  return {
    name: safeDecodeCookieSegment(nameValue.slice(0, separator)),
    value: safeDecodeCookieSegment(nameValue.slice(separator + 1)),
    options,
  }
}

function resolveSvelteKitAuthRequestAccessors(): NonNullable<SvelteKitHoloOptions['authRequest']> {
  return {
    async getCookie(name: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      return event?.cookies.get(name) ?? undefined
    },
    async getHeader(name: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      return event?.request.headers.get(name) ?? undefined
    },
    appendResponseCookie(cookie: string) {
      const event = getSvelteKitRequestEventStore().getStore()
      const parsed = parseResponseCookie(cookie)
      if (!event || !parsed) {
        return
      }

      event.cookies.set(parsed.name, parsed.value, parsed.options)
    },
  }
}

function resolveSvelteKitOptions(options: SvelteKitHoloOptions): SvelteKitHoloOptions {
  return {
    ...options,
    authRequest: options.authRequest ?? resolveSvelteKitAuthRequestAccessors(),
  }
}

export const svelteKitHoloCapabilities = svelteKitAdapter.capabilities

export function runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitRequestEvent,
  callback: () => TValue,
): TValue {
  return getSvelteKitRequestEventStore().run(event, callback)
}

export async function createSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.createProject<TCustom>(resolveSvelteKitOptions(options))
}

export async function initializeSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.initializeProject<TCustom>(resolveSvelteKitOptions(options))
}

export function createSvelteKitHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
) {
  return svelteKitAdapter.createHelpers<TCustom>(resolveSvelteKitOptions(options))
}

export async function resetSvelteKitHoloProject(): Promise<void> {
  await svelteKitAdapter.resetProject()
}

export const adapterSvelteKitInternals = svelteKitAdapter.internals
