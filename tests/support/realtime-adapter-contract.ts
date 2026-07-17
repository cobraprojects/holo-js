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
  readonly createModule: (source: string) => string
  readonly createTransform: (source: string) => RealtimeTransformResult
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
      const module = contract.createModule(source)
      expect(module).toContain(`from '${contract.importTarget}'`)
      expect(module).toContain('export const post = query({')
      expect(module).toContain('export const updatePost = mutation({')
      expect(module).not.toContain('async ()')
    })

    it('returns mutable source maps accepted by framework build pipelines', () => {
      const result = contract.createTransform(source)
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
      expect(() => contract.createTransform(`export const post = query({ handler: () => {`)).toThrow(SyntaxError)
    })
  })
}
