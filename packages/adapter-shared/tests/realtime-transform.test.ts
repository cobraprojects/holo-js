import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createRealtimeClientDefinitionModule,
  createRealtimeClientDefinitionTransform,
  stripRealtimeServerHandlers,
} from '../src'

async function loadStubInNode(source: string): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(tmpdir(), 'holo-realtime-stub-'))
  try {
    await writeFile(join(directory, 'factories.mjs'), [
      'export const query = definition => ({ kind: \'query\', ...definition })',
      'export const mutation = definition => ({ kind: \'mutation\', ...definition })',
    ].join('\n'))
    await writeFile(join(directory, 'stub.mjs'), createRealtimeClientDefinitionModule({ source, importTarget: './factories.mjs', filePath: 'server/realtime/posts.ts' }))
    await writeFile(join(directory, 'print.mjs'), 'const stub = await import(\'./stub.mjs\')\nconsole.log(JSON.stringify(Object.fromEntries(Object.entries(stub).map(([key, value]) => [key, { ...value, handler: value.handler ?? null }]))))\n')
    return JSON.parse(execFileSync('node', [join(directory, 'print.mjs')], { encoding: 'utf8' })) as Record<string, unknown>
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('shared realtime definition transform', () => {
  it('creates client definitions from exported query and mutation declarations', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      export const posts = query({ ...shared, name: 'posts.list', handler: async () => [] })
      export const rename = mutation({ name: 'posts.rename', authorize: () => true, handler: async () => true })
      const internal = query({ handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain("import { query, mutation } from '@holo-js/test/realtime'")
    expect(output).toContain("name: 'posts.list'")
    expect(output).toContain("name: 'posts.rename'")
    expect(output.match(/handler: undefined/g)).toHaveLength(2)
    expect(output).not.toContain('internal')
  })

  it('supports definitions without names and ignores calls that are not realtime factories', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      export const unnamed = query({ handler: async () => [] })
      export const indirect = makeQuery({ handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain('export const unnamed = query({')
    expect(output).not.toContain('name:')
    expect(output).not.toContain('indirect')
  })

  it('supports aliased factories, templates, comments, and nested syntax', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      import { query as defineQuery, mutation as defineMutation } from '@holo-js/realtime'
      export const templated = defineQuery({
        name: \`posts.templated\`,
        handler: async () => ({ nested: { value: /[{}]/.test('{}') } }),
      })
      // The client definition must retain this declaration while removing its server closure.
      export const changed = defineMutation({ handler: async () => true })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

    expect(output).toContain('export const templated = query({')
    expect(output).toContain('name: `posts.templated`')
    expect(output).toContain('export const changed = mutation({')
    expect(output).not.toContain('/[{}]/')
  })

  it('rejects malformed source instead of emitting a partial client module', () => {
    expect(() => createRealtimeClientDefinitionModule({ source: 'export const broken = query({ handler: () => {', importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toThrow(SyntaxError)
  })

  it('emits source maps for generated and stripped modules', () => {
    const source = `export const posts = query({ name: 'posts.list', handler: async () => [] })`
    const generated = createRealtimeClientDefinitionTransform({ source: source, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    const strippedSource = 'const internal = { handler: () => true }'

    expect(generated.map).toMatchObject({
      file: 'realtime.client.ts',
      sources: ['realtime.ts'],
    })
    expect(generated.map).not.toHaveProperty('sourcesContent')
    expect(generated.map.mappings).not.toBe('')
    expect(() => createRealtimeClientDefinitionTransform({ source: strippedSource, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/internal.ts' })).toThrow('server/realtime/internal.ts')
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

  it('fails closed when no exported definitions exist', () => {
    expect(() => createRealtimeClientDefinitionModule({ source: 'const value = { handler: () => true }', importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/internal.ts' })).toThrow('server/realtime/internal.ts')
  })

  it('retains server handlers while targeting the framework realtime adapter', () => {
    const source = `
      import { mutation, query } from '@holo-js/realtime'
      import Post from '../models/Post'

      export const posts = query({ name: 'posts.list', handler: async () => await Post.get() })
      export const rename = mutation({ name: 'posts.rename', handler: async () => true })
    `
    const output = createRealtimeClientDefinitionTransform({ source: source, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts', preserveServerHandlers: true }).code

    expect(output).toContain('from "@holo-js/test/realtime"')
    expect(output).toContain("from '../models/Post'")
    expect(output).toContain('handler: async () => await Post.get()')
    expect(output).toContain('handler: async () => true')
  })

  it('recognizes the defineRealtimeQuery and defineRealtimeMutation exports as query and mutation definitions', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      import { defineRealtimeQuery, defineRealtimeMutation } from '@holo-js/realtime'
      export const posts = defineRealtimeQuery({ name: 'posts.list', handler: async () => [] })
      export const rename = defineRealtimeMutation({ name: 'posts.rename', handler: async () => true })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain("import { query, mutation } from '@holo-js/test/realtime'")
    expect(output).toContain('export const posts = query({')
    expect(output).toContain('export const rename = mutation({')
  })

  it('accepts a template literal without substitutions as a name', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      export const posts = query({ name: \`posts.list\`, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain('name: `posts.list`')
  })

  it('fails closed for a name that interpolates a value', () => {
    expect(() => createRealtimeClientDefinitionModule({ source: `
      export const posts = query({ name: \`posts.\${process.env.SECRET}\`, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toThrow('server/realtime/posts.ts')
  })

  it('rejects a call whose options are not in the input object instead of ignoring them', () => {
    expect(() => createRealtimeClientDefinitionTransform({
      source: 'export const post = query({ name: \x27posts.list\x27, handler: async () => [] })',
      importTarget: '@holo-js/test/realtime',
      preserveServerHandlers: true,
    } as never)).toThrow(TypeError)
  })

  it('turns the documented default-import snippet into a working browser stub', async () => {
    const docs = await readFile(new URL('../../../apps/docs/docs/realtime/index.md', import.meta.url), 'utf8')
    const section = docs.slice(docs.indexOf('### Default export'))
    const snippet = section.slice(section.indexOf('```ts\n') + 6, section.indexOf('\n```', section.indexOf('```ts\n')))
    const output = createRealtimeClientDefinitionModule({ source: snippet, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

    expect(snippet).toContain('import realtime from \'@holo-js/realtime\'')
    expect(await loadStubInNode(snippet)).toEqual({ listPosts: { kind: 'query', name: 'posts.list', handler: null } })
    expect(output).not.toContain('db.table')
    expect(output).not.toContain('public')
  })

  it('recognizes every factory reached through a default or namespace import', () => {
    for (const binding of ['import realtime from \'@holo-js/realtime\'', 'import * as realtime from \'@holo-js/realtime\'']) {
      const output = createRealtimeClientDefinitionModule({ source: `
        ${binding}
        export const posts = realtime.query({ name: 'posts.list', handler: async () => [] })
        export const rename = realtime.mutation({ name: 'posts.rename', handler: async () => true })
        export const drafts = realtime.defineRealtimeQuery({ name: 'posts.drafts', handler: async () => [] })
        export const archive = realtime['defineRealtimeMutation']({ name: 'posts.archive', handler: async () => true })
      `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

      expect(output).toContain("import { query, mutation } from '@holo-js/test/realtime'")
      expect(output).toContain('export const posts = query({')
      expect(output).toContain('export const rename = mutation({')
      expect(output).toContain('export const drafts = query({')
      expect(output).toContain('export const archive = mutation({')
      expect(output).not.toContain('realtime.')
      expect(output.match(/handler: undefined/g)).toHaveLength(4)
    }
  })

  it('emits an export default definition', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      import { mutation } from '@holo-js/realtime'
      export default mutation({ name: 'posts.rename', handler: async () => true })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

    expect(output).toContain("import { mutation } from '@holo-js/test/realtime'")
    expect(output).toContain('export default mutation({')
    expect(output).toContain("name: 'posts.rename'")
  })

  it('keeps both the named and the default definitions of a mixed file', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      import realtime from '@holo-js/realtime'
      export const posts = realtime.query({ name: 'posts.list', handler: async () => [] })
      export default realtime.query({ name: 'posts.default', handler: async () => [] }) satisfies object
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

    expect(output).toContain('export const posts = query({')
    expect(output).toContain('export default query({')
    expect(output).toContain("name: 'posts.default'")
  })

  it('inlines a name read from a same-file const initialized with a string literal', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      const LIST = 'posts.list'
      const RENAME = \`posts.rename\`
      const name = 'posts.default'
      const SECRET = process.env.SECRET
      export const posts = query({ name: LIST, handler: async () => SECRET })
      export const rename = mutation({ name: RENAME, handler: async () => true })
      export default query({ name, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })

    expect(output).toContain("name: 'posts.list'")
    expect(output).toContain('name: `posts.rename`')
    expect(output).toContain("name: 'posts.default'")
    expect(output).not.toContain('LIST')
    expect(output).not.toContain('RENAME')
    expect(output).not.toContain('SECRET')
  })

  it.each([
    ['a const read from the environment', 'const NAME = process.env.NAME'],
    ['a let binding', 'let NAME = \'posts.list\''],
    ['a template with substitutions', 'const NAME = `posts.${process.env.NAME}`'],
    ['an imported binding', 'import { NAME } from \'./names\''],
    ['a const that aliases another const', 'const BASE = \'posts.list\'\nconst NAME = BASE'],
  ])('still rejects a name read from %s', (_, declaration) => {
    expect(() => createRealtimeClientDefinitionModule({ source: `
      ${declaration}
      export const posts = query({ name: NAME, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toThrow(/server\/realtime\/posts\.ts.*posts/)
  })

  it('rejects a default definition whose name is not a string literal', () => {
    expect(() => createRealtimeClientDefinitionModule({ source: `
      export default query({ name: process.env.NAME, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toThrow(/server\/realtime\/posts\.ts.*default/)
  })

  it.each([
    ['options that are not an object literal', 'nonObject', 'export const nonObject = query(options)'],
    ['a missing options argument', 'missingArgument', 'export const missingArgument = query()'],
    ['a destructured export', '{ destructured }', 'export const { destructured } = query({})'],
    ['a definition nested in another value', 'definitions', 'export const definitions = { posts: query({ name: \'posts.list\', handler: async () => [] }) }'],
    ['a namespace call with non-literal options', 'posts', 'import * as realtime from \'@holo-js/realtime\'\nexport const posts = realtime.query(options)'],
    ['a default export with non-literal options', 'default', 'export default query(options)'],
    ['a default export of a local definition', 'default', 'const posts = query({ name: \'posts.list\', handler: async () => [] })\nexport default posts'],
    ['an export list of a local definition', 'listed', 'const posts = query({ name: \'posts.list\', handler: async () => [] })\nexport { posts as listed }'],
    ['a default export nested in another value', 'default', 'export default [query({ name: \'posts.list\', handler: async () => [] })]'],
    ['an export list before the local definition it names', 'listed', 'export { posts as listed }\nconst posts = query({ name: \'posts.list\', handler: async () => [] })'],
    ['an exported alias of a definition', 'alias', 'const posts = query({ name: \'posts.list\', handler: async () => [] })\nexport const alias = posts'],
    ['an exported alias of an alias of a definition', 'listed', 'const posts = query({ name: \'posts.list\', handler: async () => [] })\nconst again = posts\nexport { again as listed }'],
    ['a computed member of the default import', 'rename', 'import realtime from \'@holo-js/realtime\'\nconst key = \'mutation\'\nexport const rename = realtime[key]({ name: \'posts.rename\', handler: async () => true })'],
    ['a computed member of the namespace import', 'rename', 'import * as realtime from \'@holo-js/realtime\'\nexport const rename = realtime[\'muta\' + \'tion\']({ name: \'posts.rename\', handler: async () => true })'],
    ['a member of the default import that is not a factory', 'other', 'import realtime from \'@holo-js/realtime\'\nexport const other = realtime.createRealtimeClient({ name: \'posts.list\' })'],
    ['an exported reference to the realtime import', 'exposed', 'import * as realtime from \'@holo-js/realtime\'\nexport const exposed = realtime'],
    ['a factory held in a local', 'aliased', 'import realtime from \'@holo-js/realtime\'\nconst q = realtime.query\nexport const aliased = q({ name: \'posts.list\', handler: async () => [] })'],
    ['a factory destructured from the default import', 'aliased', 'import realtime from \'@holo-js/realtime\'\nconst { mutation: m } = realtime\nexport const aliased = m({ name: \'posts.rename\', handler: async () => true })'],
    ['a member of an aliased namespace', 'aliased', 'import * as realtime from \'@holo-js/realtime\'\nconst r = realtime\nexport const aliased = r.query({ name: \'posts.list\', handler: async () => [] })'],
  ])('fails closed for %s and names the export', (_, exportName, source) => {
    const transform = () => createRealtimeClientDefinitionModule({ source: `
      export const kept = query({ name: 'posts.kept', handler: async () => [] })
      ${source}
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(transform).toThrow('server/realtime/posts.ts')
    expect(transform).toThrow(exportName)
  })

  it.each([
    ['a later name property that overrides a literal', '{ name: \'posts.list\', name: process.env.NAME, handler: async () => [] }'],
    ['a computed name key', '{ [\'name\']: process.env.NAME, handler: async () => [] }'],
    ['a computed key that may be the name', '{ name: \'posts.list\', [key]: \'other\', handler: async () => [] }'],
    ['a spread after the name', '{ name: \'posts.list\', ...overrides, handler: async () => [] }'],
    ['a spread with no explicit name', '{ ...shared, handler: async () => [] }'],
  ])('rejects a definition whose name the browser cannot know from %s', (_, options) => {
    expect(() => createRealtimeClientDefinitionModule({
      source: `export const posts = query(${options})`,
      importTarget: '@holo-js/test/realtime',
      filePath: 'server/realtime/posts.ts',
    })).toThrow(/server\/realtime\/posts\.ts.*posts/)
  })

  it('uses the name the runtime sees when the name key is repeated or computed from a literal', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      export const posts = query({ name: 'posts.old', ['name']: 'posts.list', handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain("name: 'posts.list'")
    expect(output).not.toContain('posts.old')
  })

  it('reduces a factory callee wrapped in parentheses or a type assertion', () => {
    const output = createRealtimeClientDefinitionModule({ source: `
      import realtime from '@holo-js/realtime'
      export const posts = (query as typeof query)({ name: 'posts.list', handler: async () => [] })
      export default (realtime.mutation)({ name: 'posts.rename', handler: async () => true })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(output).toContain('export const posts = query({')
    expect(output).toContain('export default mutation({')
  })

  it('ignores ambient const declarations when resolving a name', () => {
    expect(() => createRealtimeClientDefinitionModule({ source: `
      declare const NAME = 'posts.list'
      export const posts = query({ name: NAME, handler: async () => [] })
    `, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toThrow(/server\/realtime\/posts\.ts.*posts/)
  })

  it('emits a module Node can load when an export shares a factory name', async () => {
    expect(await loadStubInNode(`
      import realtime from '@holo-js/realtime'
      export const query = realtime.query({ name: 'posts.list', handler: async () => [] })
      export const mutation = realtime.mutation({ name: 'posts.rename', handler: async () => true })
    `)).toEqual({
      query: { kind: 'query', name: 'posts.list', handler: null },
      mutation: { kind: 'mutation', name: 'posts.rename', handler: null },
    })
  })

  it('returns an emitted stub unchanged when a bundler transforms it again', () => {
    const source = `
      import realtime from '@holo-js/realtime'
      export const query = realtime.query({ name: 'posts.list', handler: async () => [] })
      export default realtime.mutation({ name: 'posts.rename', handler: async () => true })
    `
    const stub = createRealtimeClientDefinitionModule({ source, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })
    expect(stub).toContain("import { query as _query, mutation } from '@holo-js/test/realtime'")
    expect(createRealtimeClientDefinitionModule({ source: stub, importTarget: '@holo-js/test/realtime', filePath: 'server/realtime/posts.ts' })).toBe(stub)
  })
})
