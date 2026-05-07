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

export declare function guestOnly(options: GuestOnlyOptions): GuestOnlyRouteMiddleware

export declare const routeProtectionInternals: {
  readonly matchesRoute: (route: RouteMatcher, pathname: string) => boolean
  readonly matchesRoutes: (routes: readonly RouteMatcher[] | undefined, pathname: string) => boolean
}
