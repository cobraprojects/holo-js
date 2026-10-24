import { describe, expect, it } from 'vitest'
import { createRealtimeClientDefinitionModule } from '../src/realtime-definition-transform'

describe('@holo-js/adapter-nuxt realtime definition transform', () => {
  it('imports generated client definitions through the Nuxt realtime adapter', () => {
    const transformed = createRealtimeClientDefinitionModule([
      'export const renamePost = mutation({',
      '  name: \'posts.rename\',',
      '  access: \'public\',',
      '  handler: async () => ({ ok: true }),',
      '})',
    ].join('\n'), 'server/realtime/posts.ts')

    expect(transformed).toContain('from \'@holo-js/adapter-nuxt/realtime\'')
    expect(transformed).not.toContain('from \'@holo-js/realtime\'')
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
