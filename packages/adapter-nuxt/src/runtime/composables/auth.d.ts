import type { HoloAuthUser } from '@holo-js/auth'

export type { HoloAuthUser } from '@holo-js/auth'

export interface HoloAuthRef<TValue> {
  value: TValue
}

export interface HoloAuthComputedRef<TValue> {
  readonly value: TValue
}

export interface UseAuthOptions {
  readonly endpoint?: string
  readonly guard?: string
  readonly key?: string
}

export interface UseAuthResult {
  readonly authenticated: HoloAuthComputedRef<boolean>
  readonly user: HoloAuthRef<HoloAuthUser | null>
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

export declare function useAuth(options?: UseAuthOptions): Promise<UseAuthResult>
