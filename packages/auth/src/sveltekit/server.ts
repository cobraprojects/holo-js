import { runWithSvelteKitRequestEvent as runWithRequestEvent, type SvelteKitRequestEvent } from '@holo-js/adapter-shared/sveltekit/request-context'
import holoAuth, { authRuntimeInternals, provider as currentProvider, user as currentUser } from '../index'
import type { AuthUserLike, HoloAuthUser } from '../contracts'

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

type RouteProtectionOptions = AuthOptions & {
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

export type GuestOnlyOptions = RouteProtectionOptions

export type AuthOnlyOptions = RouteProtectionOptions

export type SvelteKitHandleEvent = {
  readonly url: URL
}

type SvelteKitResolveOptions = {
  readonly transformPageChunk?: (input: {
    readonly html: string
    readonly done: boolean
  }) => string | Promise<string>
  readonly filterSerializedResponseHeaders?: (name: string, value: string) => boolean
  readonly preload?: (input: {
    readonly type: 'js' | 'css' | 'font' | 'asset'
    readonly path: string
  }) => boolean
}

export type SvelteKitHandleInput<TEvent extends SvelteKitHandleEvent = SvelteKitHandleEvent> = {
  readonly event: TEvent
  readonly resolve: (event: TEvent, options?: SvelteKitResolveOptions) => Response | Promise<Response>
}

export type SvelteKitHandle = <TEvent extends SvelteKitHandleEvent>(
  input: SvelteKitHandleInput<TEvent>,
) => Response | Promise<Response>

function isSvelteKitStoredRequestEvent(event: SvelteKitHandleEvent): event is SvelteKitHandleEvent & SvelteKitRequestEvent {
  const candidate = event as SvelteKitHandleEvent & {
    readonly cookies?: {
      get?: unknown
      set?: unknown
    }
    readonly request?: {
      readonly headers?: unknown
    }
  }

  return typeof candidate.cookies?.get === 'function'
    && typeof candidate.cookies.set === 'function'
    && candidate.request?.headers instanceof Headers
}

function runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitHandleEvent,
  callback: () => TValue,
): TValue {
  if (!isSvelteKitStoredRequestEvent(event)) {
    return callback()
  }

  return runWithRequestEvent(event, callback)
}

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
  return left.origin === right.origin
    && left.pathname === right.pathname
    && left.search === right.search
    && left.hash === right.hash
}

export async function auth(options: AuthOptions = {}): Promise<AuthState> {
  const guard = options.guard ?? authRuntimeInternals.getRuntimeBindings().config.defaults.guard
  let user: HoloAuthUser | null
  let provider: string | null
  try {
    user = options.guard
      ? await holoAuth.guard(options.guard).user()
      : await currentUser()
    provider = options.guard
      ? await holoAuth.guard(options.guard).provider()
      : await currentProvider()
  } catch (error) {
    console.warn('Failed to resolve SvelteKit auth state.', error)
    return {
      authenticated: false,
      guard,
      provider: null,
      user: null,
    }
  }

  const clientUser = toClientAuthUser(user)

  return {
    authenticated: clientUser !== null,
    guard,
    provider: clientUser ? provider : null,
    user: clientUser,
  }
}

function createRouteProtectionHandle(
  options: RouteProtectionOptions,
  shouldRedirect: (auth: AuthState) => boolean,
): SvelteKitHandle {
  return async ({ event, resolve }) => {
    return runWithSvelteKitRequestEvent(event, async () => {
      if (!matchesRoutes(options.routes, event.url.pathname)) {
        return resolve(event)
      }

      const currentAuth = await auth({ guard: options.guard })
      if (!shouldRedirect(currentAuth)) {
        return resolve(event)
      }

      const redirectUrl = new URL(options.redirectTo, event.url)
      if (isSameUrl(event.url, redirectUrl)) {
        return resolve(event)
      }

      return Response.redirect(redirectUrl, options.status ?? 303)
    })
  }
}

export function guestOnly(options: GuestOnlyOptions): SvelteKitHandle {
  return createRouteProtectionHandle(options, currentAuth => currentAuth.authenticated)
}

export function authOnly(options: AuthOnlyOptions): SvelteKitHandle {
  return createRouteProtectionHandle(options, currentAuth => !currentAuth.authenticated)
}

export const routeProtectionInternals = {
  isSameUrl,
  matchesRoute,
  matchesRoutes,
}
