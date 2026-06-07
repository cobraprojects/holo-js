import { describe, expect, it } from 'vitest'
import { createRealtimeClientDefinitionModule } from '../src/realtime-definition-transform'

describe('@holo-js/adapter-next realtime definition transform', () => {
  it('imports generated client definitions through the Next realtime adapter', () => {
    const output = createRealtimeClientDefinitionModule(`
      import { mutation, query } from '@holo-js/realtime'

      export const posts = query({
        name: 'posts.list',
        access: 'public',
        handler: async () => []
      })

      export const renamePost = mutation({
        name: 'posts.rename',
        access: 'public',
        handler: async () => ({ id: 1 })
      })
    `)

    expect(output).toContain("import { query, mutation } from '@holo-js/adapter-next/realtime'")
    expect(output).not.toContain("from '@holo-js/realtime'")
  })
})
