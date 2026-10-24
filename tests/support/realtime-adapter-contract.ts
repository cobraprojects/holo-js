import { describe, expect, it } from 'vitest'

type RealtimeTransformResult = {
  readonly code: string
  readonly map: {
    readonly version: 3
    readonly sources: readonly string[]
    readonly sourcesContent: readonly string[]
    readonly mappings: string
  }
}

export type RealtimeAdapterContract = {
  readonly adapterName: string
  readonly importTarget: string
  readonly createModule: (source: string, filePath: string) => string
  readonly createTransform: (source: string, filePath: string) => RealtimeTransformResult
  readonly stripHandlers: (source: string) => string
}

export function runRealtimeAdapterContract(contract: RealtimeAdapterContract): void {
  describe(`${contract.adapterName} realtime adapter contract`, () => {
    const source = [
      `import { query as read, mutation as write } from '@holo-js/realtime'`,
      `export const post = read({ name: \`posts.show\`, handler: async () => ({ id: 1 }) })`,
      `export const updatePost = write({ authorize: () => true, handler: async () => ({ ok: true }) })`,
    ].join('\n')

    it('emits framework-targeted client definitions from shared AST semantics', () => {
      const module = contract.createModule(source, 'server/realtime/posts.ts')
      expect(module).toContain(`from '${contract.importTarget}'`)
      expect(module).toContain('export const post = query({')
      expect(module).toContain('export const updatePost = mutation({')
      expect(module).not.toContain('async ()')
    })

    it('returns mutable source maps accepted by framework build pipelines', () => {
      const result = contract.createTransform(source, 'server/realtime/posts.ts')
      expect(result.map).toMatchObject({ version: 3, sources: ['realtime.ts'] })
      expect(result.map.sourcesContent).toEqual([source])
      expect(result.map.mappings).not.toBe('')

      const sources = [...result.map.sources]
      const mutableSources = result.map.sources as string[]
      mutableSources.splice(0, mutableSources.length, ...sources)
      expect(result.map.sources).toEqual(sources)
    })

    it('removes server-only handlers while retaining nested client metadata', () => {
      const stripped = contract.stripHandlers(`export const value = { nested: { name: 'post' }, handler() { return 1 }, authorize: () => true }`)
      expect(stripped).toContain(`name: 'post'`)
      expect(stripped).toContain('handler: undefined')
      expect(stripped).toContain('authorize: undefined')
    })

    it('rejects malformed definitions instead of returning partial output', () => {
      expect(() => contract.createTransform(`export const post = query({ handler: () => {`, 'server/realtime/posts.ts')).toThrow(SyntaxError)
    })

    it('fails closed for a module with no definitions and never returns its source', () => {
      expect(() => contract.createModule(`export const ADMIN_TOKEN = 'sk_live_example'`, 'server/realtime/admin.ts')).toThrow('server/realtime/admin.ts')
    })

    it('fails closed when a definition name is not a string literal', () => {
      expect(() => contract.createModule(`export const post = query({ name: process.env.POSTS_NAME, handler: async () => [] })`, 'server/realtime/posts.ts')).toThrow('server/realtime/posts.ts')
    })

    it('emits definitions reached through a default import', () => {
      const module = contract.createModule([
        `import realtime from '@holo-js/realtime'`,
        `export const listPosts = realtime.query({ name: 'posts.list', access: 'public', handler: async ({ db }) => await db.table('posts').get() })`,
      ].join('\n'), 'server/realtime/posts.ts')
      expect(module).toContain(`import { query } from '${contract.importTarget}'`)
      expect(module).toContain('export const listPosts = query({')
      expect(module).toContain(`name: 'posts.list'`)
      expect(module).not.toContain('db.table')
    })

    it('emits definitions reached through a namespace import', () => {
      const module = contract.createModule([
        `import * as realtime from '@holo-js/realtime'`,
        `export const rename = realtime.defineRealtimeMutation({ name: 'posts.rename', handler: async () => true })`,
      ].join('\n'), 'server/realtime/posts.ts')
      expect(module).toContain(`import { mutation } from '${contract.importTarget}'`)
      expect(module).toContain('export const rename = mutation({')
    })

    it('emits an export default definition', () => {
      const module = contract.createModule([
        `import { mutation } from '@holo-js/realtime'`,
        `export default mutation({ name: 'posts.rename', handler: async () => true })`,
      ].join('\n'), 'server/realtime/posts.ts')
      expect(module).toContain(`import { mutation } from '${contract.importTarget}'`)
      expect(module).toContain('export default mutation({')
      expect(module).toContain(`name: 'posts.rename'`)
    })

    it('fails closed when a default definition name is not a string literal', () => {
      expect(() => contract.createModule([
        `import realtime from '@holo-js/realtime'`,
        `const NAME = process.env.POSTS_NAME`,
        `export default realtime.query({ name: NAME, handler: async () => [] })`,
      ].join('\n'), 'server/realtime/posts.ts')).toThrow(/server\/realtime\/posts\.ts.*default/)
    })

    it('keeps the default export of a file that also has named definitions', () => {
      const module = contract.createModule([
        `import { query } from '@holo-js/realtime'`,
        `export const posts = query({ name: 'posts.list', handler: async () => [] })`,
        `export default query({ name: 'posts.default', handler: async () => [] })`,
      ].join('\n'), 'server/realtime/posts.ts')
      expect(module).toContain('export const posts = query({')
      expect(module).toContain('export default query({')
      expect(module).toContain(`name: 'posts.default'`)
    })

    it('inlines a name read from a same-file string const', () => {
      const module = contract.createModule([
        `const POSTS = 'posts.list'`,
        `export const posts = query({ name: POSTS, handler: async () => [] })`,
      ].join('\n'), 'server/realtime/posts.ts')
      expect(module).toContain(`name: 'posts.list'`)
      expect(module).not.toContain('POSTS')
    })

    it('fails closed for an exported definition it cannot reduce', () => {
      expect(() => contract.createModule([
        `export const posts = query({ name: 'posts.list', handler: async () => [] })`,
        `export default query(options)`,
      ].join('\n'), 'server/realtime/posts.ts')).toThrow(/server\/realtime\/posts\.ts.*default/)
    })
  })
}
