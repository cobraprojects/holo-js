import { describe, expect, it } from 'vitest'
import { stripRealtimeServerHandlers } from '../src/realtime-definition-transform'

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
})
