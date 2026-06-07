import { initializeHolo, type CreateHoloOptions } from '@holo-js/core'
import type { DotPath, HoloConfigMap, LoadedHoloConfig, ValueAtPath } from '@holo-js/config'
import { getCurrentNextRequest, type NextRequestLike } from './request-context'
export { runWithNextRequest, type NextRequestLike } from './request-context'

export type NextHoloRuntimeOptions = CreateHoloOptions & {
  readonly projectRoot: string
}

type ResponseCookieOptions = {
  path?: string
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
  readonly options: ResponseCookieOptions
}

type MutableNextCookieStore = {
  set(name: string, value: string, options?: ResponseCookieOptions): void
}

type NextNavigationModule = {
  readonly redirect: (url: string) => never
}

type NextHttpAccessFallbackError = Error & {
  digest: `NEXT_HTTP_ERROR_FALLBACK;${403 | 404}`
}

type NextHeadersModule = {
  readonly cookies: () => Promise<{
    get(name: string): { value?: string } | undefined
    set?(name: string, value: string, options?: ResponseCookieOptions): void
  }>
  readonly headers: () => Promise<Headers>
}

function createNextHttpAccessFallbackError(status: 403 | 404, message: string): never {
  const error = new Error(message) as NextHttpAccessFallbackError
  error.digest = `NEXT_HTTP_ERROR_FALLBACK;${status}`
  throw error
}

type NextRequestWithCookies = Request & {
  readonly cookies?: {
    get(name: string): { readonly value?: string } | undefined
  }
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

  const options: ResponseCookieOptions = {}
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
        options.path = value
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
          options.sameSite = value.toLowerCase() as ResponseCookieOptions['sameSite']
        }
        break
      case 'partitioned':
        options.partitioned = true
        break
    }
  }

  return {
    name: safeDecodeCookieSegment(nameValue.slice(0, separator)),
    value: safeDecodeCookieSegment(nameValue.slice(separator + 1)),
    options,
  }
}

function parseRequestCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const segment of header?.split(';') ?? []) {
    const separator = segment.indexOf('=')
    if (separator <= 0) {
      continue
    }

    const name = safeDecodeCookieSegment(segment.slice(0, separator).trim())
    const value = safeDecodeCookieSegment(segment.slice(separator + 1).trim())
    if (name) {
      cookies.set(name, value)
    }
  }

  return cookies
}

export function createNextRequestContext(request: Request): NextRequestLike {
  const nextRequest = request as NextRequestWithCookies
  const parsedCookies = nextRequest.cookies ? undefined : parseRequestCookies(request.headers.get('cookie'))

  return {
    headers: request.headers,
    cookies: {
      get(name) {
        const nextCookie = nextRequest.cookies?.get(name)
        if (nextCookie && typeof nextCookie.value === 'string') {
          return { value: nextCookie.value }
        }

        const value = parsedCookies?.get(name)
        return typeof value === 'string' ? { value } : undefined
      },
    },
  }
}

function resolveNextAuthRequestAccessors(): NonNullable<CreateHoloOptions['authRequest']> {
  return {
    async getCookie(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.cookies.get(name)?.value
      }

      const { cookies } = await import('next/headers.js') as NextHeadersModule
      const store = await cookies()
      return store.get(name)?.value
    },
    async getHeader(name: string) {
      const request = getCurrentNextRequest()
      if (request) {
        return request.headers.get(name) ?? undefined
      }

      const { headers } = await import('next/headers.js') as NextHeadersModule
      const requestHeaders = await headers()
      return requestHeaders.get(name) ?? undefined
    },
    async appendResponseCookie(cookie: string) {
      const parsed = parseResponseCookie(cookie)
      if (!parsed) {
        return
      }

      const { cookies } = await import('next/headers.js') as NextHeadersModule
      const store = await cookies() as MutableNextCookieStore
      store.set(parsed.name, parsed.value, parsed.options)
    },
    async redirectResponse(url: string) {
      const { redirect } = await import('next/navigation.js') as NextNavigationModule
      redirect(url)
    },
  }
}

export function createNextHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloRuntimeOptions,
) {
  const resolveRuntime = async () => await initializeHolo<TCustom>(options.projectRoot, {
    ...options,
    authRequest: options.authRequest ?? resolveNextAuthRequestAccessors(),
    authorizationError: options.authorizationError ?? {
      createError(decision) {
        if (decision.status === 404) {
          return createNextHttpAccessFallbackError(404, decision.message ?? 'Resource not found.')
        }

        return createNextHttpAccessFallbackError(403, decision.message ?? 'Forbidden')
      },
    },
  })

  const useConfig = async <TPath extends DotPath<LoadedHoloConfig<TCustom>['all']>>(
    path: TPath,
  ): Promise<ValueAtPath<LoadedHoloConfig<TCustom>['all'], TPath>> => {
    const runtime = await resolveRuntime()
    return runtime.config(path)
  }

  return {
    async getApp() {
      const runtime = await resolveRuntime()
      return {
        projectRoot: runtime.projectRoot,
        config: runtime.loadedConfig,
        registry: runtime.registry,
        runtime,
      }
    },
    async getProject() {
      const runtime = await resolveRuntime()
      return {
        projectRoot: runtime.projectRoot,
        config: runtime.loadedConfig,
        registry: runtime.registry,
        runtime,
      }
    },
    async getSession() {
      const runtime = await resolveRuntime()
      return runtime.session
    },
    async getAuth() {
      const runtime = await resolveRuntime()
      return runtime.auth
    },
    useConfig,
    config: useConfig,
  }
}
