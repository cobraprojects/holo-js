import { useAuth } from '../composables/auth'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

export type RouteMatcher = string | RegExp | ((pathname: string) => boolean)

export type GuestOnlyOptions = {
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

export type GuestOnlyRouteLocation = {
  readonly path: string
}

export type GuestOnlyRouteMiddlewareResult = void | false | Promise<void | false>

export type GuestOnlyRouteMiddleware = (
  to: GuestOnlyRouteLocation,
  from: GuestOnlyRouteLocation,
) => GuestOnlyRouteMiddlewareResult

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

export function guestOnly(options: GuestOnlyOptions): GuestOnlyRouteMiddleware {
  return defineNuxtRouteMiddleware(async (to) => {
    if (!matchesRoutes(options.routes, to.path)) {
      return undefined
    }

    const currentAuth = await useAuth()
    if (!currentAuth.authenticated.value) {
      return undefined
    }

    return navigateTo(options.redirectTo, {
      redirectCode: options.status ?? 303,
    })
  })
}

export const routeProtectionInternals = {
  matchesRoute,
  matchesRoutes,
}
