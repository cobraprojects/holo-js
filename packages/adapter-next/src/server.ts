import holoAuth, { user as currentUser } from '@holo-js/auth'
import type { HoloAuthUser } from '@holo-js/auth'
import { runWithNextRequest, type NextRequestLike } from './request-context'

export type AuthState = {
  readonly authenticated: boolean
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

export type NextGuestOnlyRequest = NextRequestLike & {
  readonly nextUrl?: URL
  readonly url: string
}

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

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  const user = options.guard
    ? await holoAuth.guard(options.guard).user()
    : await currentUser()
  const clientUser = toClientAuthUser(user)

  return {
    authenticated: clientUser !== null,
    user: clientUser,
  }
}

export function guestOnly(options: GuestOnlyOptions) {
  return async function proxy(request: NextGuestOnlyRequest): Promise<Response | undefined> {
    const requestUrl = request.nextUrl ?? new URL(request.url)
    if (!matchesRoutes(options.routes, requestUrl.pathname)) {
      return undefined
    }

    return runWithNextRequest(request, async () => {
      const currentAuth = await auth({ guard: options.guard })
      if (!currentAuth.authenticated) {
        return undefined
      }

      return Response.redirect(new URL(options.redirectTo, request.url), options.status ?? 303)
    })
  }
}

export const routeProtectionInternals = {
  matchesRoute,
  matchesRoutes,
}
