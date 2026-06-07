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
    ].join('\n'))

    expect(transformed).toContain('from \'@holo-js/adapter-nuxt/realtime\'')
    expect(transformed).not.toContain('from \'@holo-js/realtime\'')
  })
})
