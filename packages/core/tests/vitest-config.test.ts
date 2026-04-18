import { describe, expect, it } from 'vitest'
import config from '../vitest.config'

describe('@holo-js/core vitest config', () => {
  it('aliases the security redis-adapter subpath to source', () => {
    expect(config.resolve?.alias).toMatchObject({
      '@holo-js/security': expect.stringContaining('/packages/security/src/index.ts'),
      '@holo-js/security/drivers/redis-adapter': expect.stringContaining('/packages/security/src/drivers/redis-adapter.ts'),
    })
  })
})
