import type { AsyncLocalStorage } from 'node:async_hooks'

export type SvelteKitRequestEvent = {
  readonly url?: URL
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
  readonly request: {
    readonly method?: string
    readonly headers: Headers
  }
}

export type SvelteKitCookieOptions = {
  path: string
  domain?: string
  maxAge?: number
  expires?: Date
  secure?: boolean
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
  partitioned?: boolean
}

type SvelteKitRuntimeGlobal = typeof globalThis & {
  __holoSvelteKitRequestEventStore?: AsyncLocalStorage<SvelteKitRequestEvent>
}

const runtimeGlobal = globalThis as SvelteKitRuntimeGlobal

export function getCurrentSvelteKitRequestEvent(): SvelteKitRequestEvent | undefined {
  return runtimeGlobal.__holoSvelteKitRequestEventStore?.getStore()
}

export function runWithSvelteKitRequestEvent<TValue>(event: SvelteKitRequestEvent, callback: () => TValue): TValue {
  runtimeGlobal.__holoSvelteKitRequestEventStore ??= new (process.getBuiltinModule('node:async_hooks').AsyncLocalStorage)<SvelteKitRequestEvent>()
  return runtimeGlobal.__holoSvelteKitRequestEventStore.run(event, callback)
}
