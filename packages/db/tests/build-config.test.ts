import { describe, expect, it } from 'vitest'
import type { Options } from 'tsup'
import tsupConfig from '../tsup.config'

describe('db build config', () => {
  it('keeps optional driver packages external for runtime lazy imports', () => {
    if (typeof tsupConfig === 'function') {
      throw new TypeError('Expected a static tsup config object for @holo-js/db.')
    }

    const config = (Array.isArray(tsupConfig)
      ? tsupConfig[0]
      : tsupConfig) as Options

    expect(config.external).toEqual(expect.arrayContaining([
      '@holo-js/db-sqlite',
      '@holo-js/db-postgres',
      '@holo-js/db-mysql',
    ]))
  })
})
