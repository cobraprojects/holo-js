import { describe, expect, it } from 'vitest'
import { createRealtimeClientDefinitionModule, stripRealtimeServerHandlers } from '../src/realtime-definition-transform'

describe('realtime definition transform', () => {
  it('skips regex literals while removing server handlers', () => {
    const source = [
      'export const posts = query({',
      '  name: \'posts.list\',',
      '  handler: async () => ({',
      '    ok: /}\\//.test(\'}/\'),',
      '  }),',
      '  access: \'public\',',
      '})',
    ].join('\n')

    const stripped = stripRealtimeServerHandlers(source)

    expect(stripped).toContain('handler: undefined,')
    expect(stripped).toContain('access: \'public\'')
    expect(stripped).not.toContain('/}\\//')
    expect(stripped).not.toContain('ok:')
  })

  it('imports generated client definitions through the SvelteKit realtime adapter', () => {
    const transformed = createRealtimeClientDefinitionModule([
      'export const renamePost = mutation({',
      '  name: \'posts.rename\',',
      '  access: \'public\',',
      '  handler: async () => ({ ok: true }),',
      '})',
    ].join('\n'))

    expect(transformed).toContain('from \'@holo-js/adapter-sveltekit/realtime\'')
    expect(transformed).not.toContain('from \'@holo-js/realtime\'')
  })
})
