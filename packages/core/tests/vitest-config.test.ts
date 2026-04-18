import { describe, expect, it } from 'vitest'
import config from '../vitest.config'

function normalizeAliases(alias: unknown): Record<string, string> {
  if (Array.isArray(alias)) {
    return Object.fromEntries(alias.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return []
      }

      const candidate = entry as { find?: unknown, replacement?: unknown }
      if (typeof candidate.find !== 'string' || typeof candidate.replacement !== 'string') {
        return []
      }

      return [[candidate.find, candidate.replacement.replace(/\\/g, '/')]]
    }))
  }

  if (!alias || typeof alias !== 'object') {
    return {}
  }

  return Object.fromEntries(Object.entries(alias as Record<string, unknown>).flatMap(([key, value]) => {
    if (typeof value !== 'string') {
      return []
    }

    return [[key, value.replace(/\\/g, '/')]]
  }))
}

describe('@holo-js/core vitest config', () => {
  it('aliases the security redis-adapter subpath to source', () => {
    expect(normalizeAliases(config.resolve?.alias)).toMatchObject({
      '@holo-js/security': expect.stringContaining('/packages/security/src/index.ts'),
      '@holo-js/security/drivers/redis-adapter': expect.stringContaining('/packages/security/src/drivers/redis-adapter.ts'),
    })
  })
})
