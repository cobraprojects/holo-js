import { describe, expect, it } from 'vitest'
import {
  createRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform,
  stripRealtimeServerHandlers,
} from '../src'

describe('shared realtime definition transform', () => {
  it('creates client definitions from exported query and mutation declarations', () => {
    const output = createRealtimeClientDefinitionModule(`
      export const posts = query({ ...shared, name: 'posts.list', handler: async () => [] })
      export const rename = mutation({ name: routeName, authorize: () => true, handler: async () => true })
      const internal = query({ handler: async () => [] })
    `, '@holo-js/test/realtime')
    expect(output).toContain("import { query, mutation } from '@holo-js/test/realtime'")
    expect(output).toContain("name: 'posts.list'")
    expect(output).toContain('name: routeName')
    expect(output.match(/handler: undefined/g)).toHaveLength(2)
    expect(output).not.toContain('internal')
  })

  it('supports definitions without names and ignores unsupported declaration shapes', () => {
    const output = createRealtimeClientDefinitionModule(`
      export const unnamed = query({ handler: async () => [] })
      export const indirect = makeQuery({ handler: async () => [] })
      export const missingArgument = query()
      export const nonObject = query(options)
      export const { destructured } = query({})
    `, '@holo-js/test/realtime')
    expect(output).toContain('export const unnamed = query({')
    expect(output).not.toContain('name:')
    expect(output).not.toContain('indirect')
  })

  it('supports aliased factories, templates, comments, and nested syntax', () => {
    const output = createRealtimeClientDefinitionModule(`
      import { query as defineQuery, mutation as defineMutation } from '@holo-js/realtime'
      export const templated = defineQuery({
        name: \`posts.${'${segment}'}\`,
        handler: async () => ({ nested: { value: /[{}]/.test('{}') } }),
      })
      // The client definition must retain this declaration while removing its server closure.
      export const changed = defineMutation({ handler: async () => true })
    `, '@holo-js/test/realtime')

    expect(output).toContain('export const templated = query({')
    expect(output).toContain('name: `posts.${segment}`')
    expect(output).toContain('export const changed = mutation({')
    expect(output).not.toContain('/[{}]/')
  })

  it('rejects malformed source instead of emitting a partial client module', () => {
    expect(() => createRealtimeClientDefinitionModule(
      'export const broken = query({ handler: () => {',
      '@holo-js/test/realtime',
    )).toThrow(SyntaxError)
  })

  it('emits source maps for generated and stripped modules', () => {
    const source = `export const posts = query({ name: 'posts.list', handler: async () => [] })`
    const generated = createRealtimeClientDefinitionTransform(source, '@holo-js/test/realtime')
    const strippedSource = 'const internal = { handler: () => true }'
    const stripped = createRealtimeClientDefinitionTransform(strippedSource, '@holo-js/test/realtime')

    expect(generated.map).toMatchObject({
      file: 'realtime.client.ts',
      sources: ['realtime.ts'],
      sourcesContent: [source],
    })
    expect(generated.map.mappings).not.toBe('')
    expect(stripped.map.sourcesContent).toEqual([strippedSource])
    expect(stripped.map.mappings).not.toBe('')
  })

  it('replaces server-only properties and methods through the TypeScript AST', () => {
    const output = stripRealtimeServerHandlers(`
      const definition = {
        handler: async () => /}/.test('}'),
        'authorize': () => true,
        handler() { return true },
        authorize() { return true },
        ['handler']: () => false,
        ...shared,
        access: 'public',
      }
    `)
    expect(output).toContain('handler: undefined')
    expect(output).toContain('authorize\': undefined')
    expect(output).toContain('access: \'public\'')
    expect(output).toContain('[\'handler\']')
    expect(output).not.toContain('.test(')
  })

  it('falls back to stripping when no exported definitions exist', () => {
    expect(createRealtimeClientDefinitionModule(
      'const value = { handler: () => true }',
      '@holo-js/test/realtime',
    )).toContain('handler: undefined')
  })

  it('retains server handlers while targeting the framework realtime adapter', () => {
    const source = `
      import { mutation, query } from '@holo-js/realtime'
      import Post from '../models/Post'

      export const posts = query({ name: 'posts.list', handler: async () => await Post.get() })
      export const rename = mutation({ name: 'posts.rename', handler: async () => true })
    `
    const output = createRealtimeClientDefinitionTransform(source, '@holo-js/test/realtime', {
      preserveServerHandlers: true,
    }).code

    expect(output).toContain("from \"@holo-js/test/realtime\"")
    expect(output).toContain("from '../models/Post'")
    expect(output).toContain('handler: async () => await Post.get()')
    expect(output).toContain('handler: async () => true')
  })
})
