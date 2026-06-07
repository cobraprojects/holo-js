import { describe, expect, it } from 'vitest'
import { stripRealtimeServerHandlers } from '../src/realtime-definition-transform'

describe('realtime definition transform', () => {
  it('skips regex literals while removing server handlers', () => {
    const source = [
      'export const posts = query({',
      '  name: \'posts.list\',',
      '  handler: async () => ({',
      '    ok: /[{}]/.test(\'{\'),',
      '  }),',
      '  access: \'public\',',
      '})',
    ].join('\n')

    expect(stripRealtimeServerHandlers(source)).toContain('handler: undefined,')
    expect(stripRealtimeServerHandlers(source)).toContain('access: \'public\'')
  })
})
