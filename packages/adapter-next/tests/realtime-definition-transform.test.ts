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
    `, 'server/realtime/posts.ts')

    expect(output).toContain("import { query, mutation } from '@holo-js/adapter-next/realtime'")
    expect(output).not.toContain("from '@holo-js/realtime'")
  })

  it('fails closed for a server realtime module with no definitions and never sends its source', () => {
    expect(() => createRealtimeClientDefinitionModule([
      'import { db } from \'@holo-js/db\'',
      'export const ADMIN_TOKEN = \'sk_live_example\'',
      '',
    ].join('\n'), 'server/realtime/admin.ts')).toThrow('server/realtime/admin.ts')
  })

  it('fails closed when a definition name is not a string literal', () => {
    expect(() => createRealtimeClientDefinitionModule([
      'import { query } from \'@holo-js/realtime\'',
      'export const posts = query({ name: process.env.POSTS_NAME, handler: async () => [] })',
      '',
    ].join('\n'), 'server/realtime/posts.ts')).toThrow('server/realtime/posts.ts')
  })
})
