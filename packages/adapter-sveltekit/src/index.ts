import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import { getRequestEvent } from '$app/server'
import type { HoloConfigMap } from '@holo-js/config'
export {
  holoSvelteKitTransport,
  type SvelteKitTransportDefinition,
} from './transport'

export type SvelteKitHoloOptions = HoloFrameworkOptions

export type SvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

function withSvelteKitAuthRequest(options: SvelteKitHoloOptions = {}): SvelteKitHoloOptions {
  if (options.authRequest) {
    return options
  }

  return {
    ...options,
    authRequest: {
      async getCookie(name: string) {
        const event = getRequestEvent()
        return event.cookies.get(name) ?? undefined
      },
      async getHeader(name: string) {
        const event = getRequestEvent()
        return event.request.headers.get(name) ?? undefined
      },
    },
  }
}

const svelteKitAdapter = createHoloFrameworkAdapter<SvelteKitHoloOptions>({
  stateKey: '__holoSvelteKitAdapter__',
  displayName: 'SvelteKit',
})

export const svelteKitHoloCapabilities = svelteKitAdapter.capabilities

export async function createSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.createProject<TCustom>(withSvelteKitAuthRequest(options))
}

export async function initializeSvelteKitHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
): Promise<SvelteKitHoloProject<TCustom>> {
  return svelteKitAdapter.initializeProject<TCustom>(withSvelteKitAuthRequest(options))
}

export function createSvelteKitHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: SvelteKitHoloOptions = {},
) {
  return svelteKitAdapter.createHelpers<TCustom>(withSvelteKitAuthRequest(options))
}

export async function resetSvelteKitHoloProject(): Promise<void> {
  await svelteKitAdapter.resetProject()
}

export const adapterSvelteKitInternals = svelteKitAdapter.internals
