import { describe, expect, it, vi } from 'vitest'
import realtimeDefinitionLoader from '../src/realtime-definition-loader'

describe('Next realtime definition loader', () => {
  it('marks modules cacheable and transforms their client definition', () => {
    const cacheable = vi.fn()
    const output = realtimeDefinitionLoader.call({ cacheable }, `import { defineRealtimeQuery } from '@holo-js/realtime'\nexport default defineRealtimeQuery({ name: 'posts.list', handler: async () => [] })`)
    expect(cacheable).toHaveBeenCalledOnce()
    expect(output).toContain('posts.list')
  })

  it('returns source maps through the loader callback', () => {
    const callback = vi.fn()
    const source = `import { query } from '@holo-js/realtime'\nexport const posts = query({ name: 'posts.list' })`

    expect(realtimeDefinitionLoader.call({ callback }, source)).toBeUndefined()
    expect(callback).toHaveBeenCalledWith(
      null,
      expect.stringContaining('posts.list'),
      expect.objectContaining({ sourcesContent: [source] }),
    )
  })
})
