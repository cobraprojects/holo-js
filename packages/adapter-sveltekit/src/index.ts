import { AsyncLocalStorage } from 'node:async_hooks'
import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import type { HoloConfigMap } from '@holo-js/config'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

type SvelteKitRequestEvent = {
  readonly cookies: {
    get(name: string): string | undefined
  }
  readonly request: {
    readonly headers: Headers
  }
}

const svelteKitAdapter = createHoloFrameworkAdapter<SvelteKitHoloOptions>({
  stateKey: '__holoSvelteKitAdapter__',
  displayName: 'SvelteKit',
})
const svelteKitRequestEventStore = new AsyncLocalStorage<SvelteKitRequestEvent>()

function resolveSvelteKitAuthRequestAccessors(): NonNullable<SvelteKitHoloOptions['authRequest']> {
  return {
    async getCookie(name: string) {
      const event = svelteKitRequestEventStore.getStore()
      return event?.cookies.get(name) ?? undefined
    },
    async getHeader(name: string) {
      const event = svelteKitRequestEventStore.getStore()
      return event?.request.headers.get(name) ?? undefined
    },
  }
}

function resolveSvelteKitOptions(options: SvelteKitHoloOptions): SvelteKitHoloOptions {
  return {
    ...options,
    authRequest: options.authRequest ?? resolveSvelteKitAuthRequestAccessors(),
  }
}

export const svelteKitHoloCapabilities = svelteKitAdapter.capabilities

export function runWithSvelteKitRequestEvent<TValue>(
  event: SvelteKitRequestEvent,
  callback: () => TValue,
): TValue {
  return svelteKitRequestEventStore.run(event, callback)
}

export async function createSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.createProject<TCustom>(resolveSvelteKitOptions(options))
}

export async function initializeSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.initializeProject<TCustom>(resolveSvelteKitOptions(options))
}

export function createSvelteKitHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
) {
  return svelteKitAdapter.createHelpers<TCustom>(resolveSvelteKitOptions(options))
}

export async function resetSvelteKitHoloProject(): Promise<void> {
  await svelteKitAdapter.resetProject()
}

export const adapterSvelteKitInternals = svelteKitAdapter.internals
