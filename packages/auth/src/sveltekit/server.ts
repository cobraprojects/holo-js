import { AsyncLocalStorage } from 'node:async_hooks'
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

type SvelteKitCookieOptions = {
  path: string
  domain?: string
  maxAge?: number
  expires?: Date
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
}

type SvelteKitStoredRequestEvent = SvelteKitHandleEvent & {
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
  readonly request: {
    readonly headers: Headers
  }
}

type SvelteKitRuntimeGlobal = typeof globalThis & {
  __holoSvelteKitRequestEventStore?: AsyncLocalStorage<SvelteKitStoredRequestEvent>
}

export type SvelteKitHandleInput<TEvent extends SvelteKitHandleEvent = SvelteKitHandleEvent> = {
  readonly event: TEvent
  readonly resolve: (event: TEvent, options?: never) => Response | Promise<Response>
}

export type SvelteKitHandle = <TEvent extends SvelteKitHandleEvent>(
  input: SvelteKitHandleInput<TEvent>,
) => Response | Promise<Response>

function getSvelteKitRequestEventStore(): AsyncLocalStorage<SvelteKitStoredRequestEvent> {
  const runtimeGlobal = globalThis as SvelteKitRuntimeGlobal
  runtimeGlobal.__holoSvelteKitRequestEventStore ??= new AsyncLocalStorage<SvelteKitStoredRequestEvent>()

  return runtimeGlobal.__holoSvelteKitRequestEventStore
}

function isSvelteKitStoredRequestEvent(event: SvelteKitHandleEvent): event is SvelteKitStoredRequestEvent {
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

  return getSvelteKitRequestEventStore().run(event, callback)
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
    return runWithSvelteKitRequestEvent(event, async () => {
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
    })
  }
}

export function authOnly(options: AuthOnlyOptions): SvelteKitHandle {
  return async ({ event, resolve }) => {
    return runWithSvelteKitRequestEvent(event, async () => {
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
    })
  }
}

export const routeProtectionInternals = {
  isSameUrl,
  matchesRoute,
  matchesRoutes,
}
