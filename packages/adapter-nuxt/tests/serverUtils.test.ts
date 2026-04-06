import { describe, expect, it } from 'vitest'
import {
  holo as runtimeHolo,
  useHoloDb as useRuntimeHoloDb,
  useHoloDebug as useRuntimeHoloDebug,
  useHoloEnv as useRuntimeHoloEnv,
} from '../src/runtime/composables'
import { Storage as RuntimeStorage, useStorage as useRuntimeStorage } from '@holo-js/storage/runtime'
import {
  holo,
  useHoloDb,
  useHoloDebug,
  useHoloEnv,
} from '../src/runtime/server/imports/holo'
import { Storage, useStorage } from '../src/runtime/server/utils/storage'

describe('server utils', () => {
  it('re-exports the storage facade and composable', () => {
    expect(Storage).toBe(RuntimeStorage)
    expect(useStorage).toBe(useRuntimeStorage)
  })

  it('re-exports the Holo runtime composables for server auto-imports', () => {
    expect(holo).toBe(runtimeHolo)
    expect(useHoloDb).toBe(useRuntimeHoloDb)
    expect(useHoloEnv).toBe(useRuntimeHoloEnv)
    expect(useHoloDebug).toBe(useRuntimeHoloDebug)
  })
})
