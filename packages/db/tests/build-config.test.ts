import { describe, expect, it } from 'vitest'
import type { Options } from 'tsup'
import tsupConfig from '../tsup.config'

describe('db build config', () => {
  it('does not reference concrete driver packages', () => {
    if (typeof tsupConfig === 'function') {
      throw new TypeError('Expected a static tsup config object for @holo-js/db.')
    }

    const config = (Array.isArray(tsupConfig)
      ? tsupConfig[0]
      : tsupConfig) as Options

    expect(config.external).toBeUndefined()
  })
})
