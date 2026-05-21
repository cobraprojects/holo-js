interface HoloRef<TValue> {
  value: TValue
}

interface HoloComputedRef<TValue> {
  readonly value: TValue
}

interface HoloCookieRef<TValue> {
  value: TValue
}

interface HoloUseFetchResult<TValue> {
  readonly data: HoloRef<TValue | null>
  readonly refresh: () => Promise<void>
}

interface HoloRouteLocation {
  readonly path: string
}

type HoloNavigateToResult = void | false | Promise<void | false>

declare module '#imports' {
  export function computed<TValue>(getter: () => TValue): HoloComputedRef<TValue>
  export function defineNuxtRouteMiddleware<TValue>(
    middleware: (to: HoloRouteLocation, from: HoloRouteLocation) => TValue | Promise<TValue>,
  ): (to: HoloRouteLocation, from: HoloRouteLocation) => TValue | Promise<TValue>
  export function navigateTo(
    to: string,
    options?: { readonly redirectCode?: number },
  ): HoloNavigateToResult
  export function useCookie<TValue>(
    name: string,
    options?: {
      readonly path?: string
      readonly sameSite?: 'lax' | 'strict' | 'none'
      readonly secure?: boolean
    },
  ): HoloCookieRef<TValue>
  export function useFetch<TValue = import('./contracts').CurrentAuthResponse>(
    request: string,
    options?: { readonly key?: string },
  ): Promise<HoloUseFetchResult<TValue>>
  export function useState<TValue>(key: string, init: () => TValue): HoloRef<TValue>
}
