import {
  createHoloFrameworkAdapter,
  type HoloAdapterProject,
  type HoloFrameworkOptions,
} from '@holo-js/core'
import type { HoloConfigMap } from '@holo-js/config'

export type NextHoloOptions = HoloFrameworkOptions
export type NextHoloProject<TCustom extends HoloConfigMap = HoloConfigMap> = HoloAdapterProject<TCustom>

const nextAdapter = createHoloFrameworkAdapter<NextHoloOptions>({
  stateKey: '__holoNextAdapter__',
  displayName: 'Next',
})

export const nextHoloCapabilities = nextAdapter.capabilities

export async function createNextHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloOptions = {},
): Promise<NextHoloProject<TCustom>> {
  return nextAdapter.createProject<TCustom>(options)
}

export async function initializeNextHoloProject<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloOptions = {},
): Promise<NextHoloProject<TCustom>> {
  return nextAdapter.initializeProject<TCustom>(options)
}

export function createNextHoloHelpers<TCustom extends HoloConfigMap = HoloConfigMap>(
  options: NextHoloOptions = {},
) {
  return nextAdapter.createHelpers<TCustom>(options)
}

export async function resetNextHoloProject(): Promise<void> {
  await nextAdapter.resetProject()
}

export const adapterNextInternals = nextAdapter.internals
