import holoAuth, { authRuntimeInternals, provider as currentProvider, user as currentUser } from '../index'
import type { HoloAuthUser } from '../contracts'
import { runWithNextAuthRequest, type NextAuthRequestLike } from './request-context'

export type AuthState = {
  readonly authenticated: boolean
  readonly guard: string
  readonly provider: string | null
  readonly user: HoloAuthUser | null
}

export type AuthOptions = {
  readonly guard?: string
}

export type RouteMatcher = string | RegExp | ((pathname: string) => boolean)

export type GuestOnlyOptions = AuthOptions & {
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

export type AuthOnlyOptions = AuthOptions & {
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

type NextRouteProtectionRequest = NextAuthRequestLike & {
  readonly nextUrl?: URL
  readonly url: string
}

type NextRouteProtectionResult = Response | undefined | void

type NextRouteProtectionProxy = (
  request: NextRouteProtectionRequest,
) => NextRouteProtectionResult | Promise<NextRouteProtectionResult>

function toClientAuthUser(user: HoloAuthUser | null): HoloAuthUser | null {
  return user ? { ...user } : null
}

function normalizePathname(pathname: string): string {
  if (pathname === '/') {
    return pathname
  }

  return pathname.replace(/\/+$/g, '')
}

function matchesRoute(route: RouteMatcher, pathname: string): boolean {
  const normalizedPathname = normalizePathname(pathname)
  if (typeof route === 'function') {
    return route(normalizedPathname)
  }

  if (route instanceof RegExp) {
    route.lastIndex = 0
    return route.test(normalizedPathname)
  }

  const normalizedRoute = normalizePathname(route)
  if (normalizedRoute.endsWith('/*')) {
    const prefix = normalizePathname(normalizedRoute.slice(0, -2))
    return normalizedPathname === prefix || normalizedPathname.startsWith(`${prefix}/`)
  }

  return normalizedPathname === normalizedRoute
}

function matchesRoutes(routes: readonly RouteMatcher[] | undefined, pathname: string): boolean {
  return (routes ?? ['/*']).some(route => matchesRoute(route, pathname))
}

function isSameUrl(left: URL, right: URL): boolean {
  return left.origin === right.origin
    && left.pathname === right.pathname
    && left.search === right.search
    && left.hash === right.hash
}

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  const guard = options.guard ?? authRuntimeInternals.getRuntimeBindings().config.defaults.guard
  try {
    const user = options.guard
      ? await holoAuth.guard(guard).user()
      : await currentUser()
    const provider = options.guard
      ? await holoAuth.guard(guard).provider()
      : await currentProvider()
    const clientUser = toClientAuthUser(user)

    return {
      authenticated: clientUser !== null,
      guard,
      provider: clientUser ? provider : null,
      user: clientUser,
    }
  } catch (error) {
    console.warn('Failed to resolve Next.js auth state.', error)
    return {
      authenticated: false,
      guard,
      provider: null,
      user: null,
    }
  }
}

export function guestOnly(options: GuestOnlyOptions): NextRouteProtectionProxy {
  return async function proxy(request) {
    const requestUrl = request.nextUrl ?? new URL(request.url)
    if (!matchesRoutes(options.routes, requestUrl.pathname)) {
      return undefined
    }

    return runWithNextAuthRequest(request, async () => {
      const currentAuth = await auth({ guard: options.guard })
      if (!currentAuth.authenticated) {
        return undefined
      }

      const redirectUrl = new URL(options.redirectTo, request.url)
      if (isSameUrl(requestUrl, redirectUrl)) {
        return undefined
      }

      return Response.redirect(redirectUrl, options.status ?? 303)
    })
  }
}

export function authOnly(options: AuthOnlyOptions): NextRouteProtectionProxy {
  return async function proxy(request) {
    const requestUrl = request.nextUrl ?? new URL(request.url)
    if (!matchesRoutes(options.routes, requestUrl.pathname)) {
      return undefined
    }

    return runWithNextAuthRequest(request, async () => {
      const currentAuth = await auth({ guard: options.guard })
      if (currentAuth.authenticated) {
        return undefined
      }

      const redirectUrl = new URL(options.redirectTo, request.url)
      if (isSameUrl(requestUrl, redirectUrl)) {
        return undefined
      }

      return Response.redirect(redirectUrl, options.status ?? 303)
    })
  }
}

export function protectRoutes(...proxies: readonly NextRouteProtectionProxy[]): NextRouteProtectionProxy {
  return async function proxy(request) {
    for (const routeProxy of proxies) {
      const response = await routeProxy(request)
      if (response) {
        return response
      }
    }

    return undefined
  }
}

export const routeProtectionInternals = {
  isSameUrl,
  matchesRoute,
  matchesRoutes,
}

export { getCurrentNextAuthRequest, runWithNextAuthRequest, type NextAuthRequestLike } from './request-context'
