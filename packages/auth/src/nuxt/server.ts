import { useAuth } from '../nuxt'
import { defineNuxtRouteMiddleware, navigateTo } from '#imports'

export type RouteMatcher = string | RegExp | ((pathname: string) => boolean)

type RouteProtectionOptions = {
  readonly guard?: string
  readonly redirectTo: string
  readonly routes?: readonly RouteMatcher[]
  readonly status?: 301 | 302 | 303 | 307 | 308
}

export type GuestOnlyOptions = RouteProtectionOptions

export type AuthOnlyOptions = RouteProtectionOptions

export type RouteProtectionLocation = {
  readonly path: string
}

export type RouteProtectionMiddlewareResult = void | false | Promise<void | false>

export type RouteProtectionMiddleware = (
  to: RouteProtectionLocation,
  from: RouteProtectionLocation,
) => RouteProtectionMiddlewareResult

export type GuestOnlyRouteLocation = RouteProtectionLocation
export type GuestOnlyRouteMiddlewareResult = RouteProtectionMiddlewareResult
export type GuestOnlyRouteMiddleware = RouteProtectionMiddleware
export type AuthOnlyRouteLocation = RouteProtectionLocation
export type AuthOnlyRouteMiddlewareResult = RouteProtectionMiddlewareResult
export type AuthOnlyRouteMiddleware = RouteProtectionMiddleware

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

function isSamePath(path: string, redirectTo: string): boolean {
  const resolvePathname = (value: string): string => {
    try {
      return new URL(value, 'https://holo.local').pathname
    } catch {
      return value.split(/[?#]/, 1).join('')
    }
  }

  return normalizePathname(resolvePathname(path)) === normalizePathname(resolvePathname(redirectTo))
}

function createUseAuthOptions(guard: string | undefined): { readonly guard: string } | undefined {
  return guard ? { guard } : undefined
}

function createRouteProtectionMiddleware(
  options: RouteProtectionOptions,
  shouldRedirect: (authenticated: boolean) => boolean,
): RouteProtectionMiddleware {
  return defineNuxtRouteMiddleware(async (to) => {
    if (!matchesRoutes(options.routes, to.path)) {
      return undefined
    }

    const currentAuth = await useAuth(createUseAuthOptions(options.guard))
    if (!shouldRedirect(currentAuth.authenticated.value)) {
      return undefined
    }

    if (isSamePath(to.path, options.redirectTo)) {
      return undefined
    }

    return navigateTo(options.redirectTo, {
      redirectCode: options.status ?? 303,
    })
  })
}

export function guestOnly(options: GuestOnlyOptions): GuestOnlyRouteMiddleware {
  return createRouteProtectionMiddleware(options, authenticated => authenticated)
}

export function authOnly(options: AuthOnlyOptions): AuthOnlyRouteMiddleware {
  return createRouteProtectionMiddleware(options, authenticated => !authenticated)
}
