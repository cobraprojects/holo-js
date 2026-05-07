import holoAuth, { user as currentUser } from '../index'
import type { AuthUserLike, HoloAuthUser } from '../contracts'

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

export type AuthOnlyOptions = AuthOptions & {
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

export type SvelteKitHandleEvent = {
  readonly url: URL
}

export type SvelteKitHandleInput<TEvent extends SvelteKitHandleEvent = SvelteKitHandleEvent> = {
  readonly event: TEvent
  readonly resolve: (event: TEvent, options?: never) => Response | Promise<Response>
}

export type SvelteKitHandle = <TEvent extends SvelteKitHandleEvent>(
  input: SvelteKitHandleInput<TEvent>,
) => Response | Promise<Response>

function toClientAuthUser(user: (HoloAuthUser & AuthUserLike) | null): HoloAuthUser | null {
  // AuthUserLike custom fields crossing SvelteKit load boundaries must stay JSON-safe.
  return user ? JSON.parse(JSON.stringify(user)) as HoloAuthUser : null
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
  return left.pathname === right.pathname
    && left.search === right.search
    && left.hash === right.hash
}

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  let user: HoloAuthUser | null
  try {
    user = options.guard
      ? await holoAuth.guard(options.guard).user()
      : await currentUser()
  } catch (error) {
    console.warn('Failed to resolve SvelteKit auth state.', error)
    return {
      authenticated: false,
      user: null,
    }
  }

  const clientUser = toClientAuthUser(user)

  return {
    authenticated: clientUser !== null,
    user: clientUser,
  }
}

export function guestOnly(options: GuestOnlyOptions): SvelteKitHandle {
  return async ({ event, resolve }) => {
    if (!matchesRoutes(options.routes, event.url.pathname)) {
      return resolve(event)
    }

    const currentAuth = await auth({ guard: options.guard })
    if (!currentAuth.authenticated) {
      return resolve(event)
    }

    const redirectUrl = new URL(options.redirectTo, event.url)
    if (isSameUrl(event.url, redirectUrl)) {
      return resolve(event)
    }

    return Response.redirect(redirectUrl, options.status ?? 303)
  }
}

export function authOnly(options: AuthOnlyOptions): SvelteKitHandle {
  return async ({ event, resolve }) => {
    if (!matchesRoutes(options.routes, event.url.pathname)) {
      return resolve(event)
    }

    const currentAuth = await auth({ guard: options.guard })
    if (currentAuth.authenticated) {
      return resolve(event)
    }

    const redirectUrl = new URL(options.redirectTo, event.url)
    if (isSameUrl(event.url, redirectUrl)) {
      return resolve(event)
    }

    return Response.redirect(redirectUrl, options.status ?? 303)
  }
}

export const routeProtectionInternals = {
  isSameUrl,
  matchesRoute,
  matchesRoutes,
}
