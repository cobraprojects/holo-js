import { describe, expect, it } from 'vitest'
import { holoSveltePreprocess, sveltePreprocessInternals, transformSvelteUseFormReactivity } from '../src/preprocess'
import { createReactiveView } from '../src/reactive-view'
import { applyReplacements, skipBlockComment, skipLineComment, skipString } from '../src/transform-utils'
import { holoSvelteKitRealtime, isRealtimeDefinitionModule } from '../src/vite'

describe('SvelteKit transform internals', () => {
  it('handles strings, comments, and ordered replacements', () => {
    expect(skipString(`'a\\'b' tail`, 0, '\'')).toBe(6)
    expect(skipString('`unterminated', 0, '`')).toBe(13)
    expect(skipLineComment('// comment\nnext', 0)).toBe(11)
    expect(skipLineComment('// comment', 0)).toBe(10)
    expect(skipBlockComment('/* comment */next', 0)).toBe(13)
    expect(skipBlockComment('/* comment', 0)).toBe(10)
    expect(applyReplacements('abc', [])).toBe('abc')
    expect(applyReplacements('abcdef', [
      { start: 4, end: 6, text: 'Y' },
      { start: 1, end: 3, text: 'X' },
    ])).toBe('aXdY')
  })

  it('discovers script blocks and aliased form imports', () => {
    expect(sveltePreprocessInternals.collectScriptBlocks('<script>one</script><script lang="ts">two</script>')).toHaveLength(2)
    expect(sveltePreprocessInternals.collectScriptBlocks('<script>open')).toEqual([])
    expect(sveltePreprocessInternals.collectUseFormAliases(`
      import { useForm, useForm as form, other } from '@holo-js/adapter-sveltekit/client'
    `)).toEqual(['useForm', 'form'])
    expect(sveltePreprocessInternals.collectUseFormAliases('const useForm = local')).toEqual([])
  })

  it('parses generic calls around strings and comments', () => {
    expect(sveltePreprocessInternals.findOpeningParen(' <Type>()', 0)).toBe(7)
    expect(sveltePreprocessInternals.findOpeningParen(' value', 0)).toBe(-1)
    expect(sveltePreprocessInternals.findOpeningParen('<broken', 0)).toBe(-1)
    expect(sveltePreprocessInternals.findClosingParen(`(')', /* ) */ () => true)`, 0)).toBe(24)
    expect(sveltePreprocessInternals.findClosingParen('(unterminated', 0)).toBe(-1)
    expect(sveltePreprocessInternals.skipTypeArguments('value', 0)).toBe(0)
    expect(sveltePreprocessInternals.skipTypeArguments('<{ value: ">" /* > */ }>()', 0)).toBe(24)
    expect(sveltePreprocessInternals.skipTypeArguments('<Type // >\n>()', 0)).toBe(12)
    expect(sveltePreprocessInternals.skipTypeArguments('<Outer<Inner>>()', 0)).toBe(14)
    expect(sveltePreprocessInternals.findOpeningParen('<Type>   ()', 0)).toBe(9)
    expect(sveltePreprocessInternals.findClosingParen('(value // )\n)', 0)).toBe(12)
  })

  it('transforms valid form declarations and ignores malformed or already reactive ones', () => {
    const source = `<script lang="ts">
import { useForm as form } from '@holo-js/adapter-sveltekit/client'
const post = form<{ title: string }>({ title: ')' })
</script>`
    const transformed = transformSvelteUseFormReactivity(source)
    expect(transformed).toContain('let post = form')
    expect(transformed).toContain('post.subscribe(() => { post = post })')
    expect(transformSvelteUseFormReactivity(transformed)).toBe(transformed)
    expect(sveltePreprocessInternals.transformScript(`${source}\npost.subscribe(() => { post = post })`)).toContain('const post')
    expect(sveltePreprocessInternals.transformScript("import { useForm } from '@holo-js/adapter-sveltekit/client'\nconst form = useForm")).not.toContain('.subscribe')
    expect(sveltePreprocessInternals.transformScript("import { useForm } from '@holo-js/adapter-sveltekit/client'\nconst form = useForm(")).not.toContain('.subscribe')
    expect(transformSvelteUseFormReactivity('<h1>Plain</h1>')).toBe('<h1>Plain</h1>')
    expect(sveltePreprocessInternals.transformScript('const form = useForm({})')).toBe('const form = useForm({})')
    expect(holoSveltePreprocess().markup({ content: source }).code).toBe(transformed)
  })

  it('recognizes and transforms only client realtime definition modules', () => {
    expect(isRealtimeDefinitionModule('/app/', '/app/server/realtime/posts.ts?x=1')).toBe(true)
    expect(isRealtimeDefinitionModule('C:\\app', 'C:\\app\\server\\realtime\\posts.mts')).toBe(true)
    expect(isRealtimeDefinitionModule('/app', '/app/server/realtime/posts.txt')).toBe(false)
    expect(isRealtimeDefinitionModule('/app', '/app/server/models/Post.ts')).toBe(false)

    const plugin = holoSvelteKitRealtime('/app')
    const code = `import { query } from '@holo-js/realtime'\nexport const posts = query({ name: 'posts.list' })`
    expect(plugin.transform(code, '/app/server/realtime/posts.ts', { ssr: true })).toBeNull()
    expect(plugin.transform(code, '/app/server/models/Post.ts')).toBeNull()
    expect(plugin.transform(code, '/app/server/realtime/posts.ts')).toMatchObject({
      map: { sourcesContent: [code] },
    })
  })
})

describe('SvelteKit reactive views', () => {
  it('tracks access, preserves array length, wraps nested values, and binds functions', () => {
    let subscriptions = 0
    const target = [{ value: 1 }]
    const cache = new WeakMap<object, object>()
    const view = createReactiveView(target, () => { subscriptions += 1 }, cache, {
      bindFunctions: true,
      preserveArrayLengthDescriptor: true,
      shouldWrapValue: (value: unknown): value is object => Boolean(value) && typeof value === 'object',
    })
    expect(createReactiveView(target, () => {}, cache, {
      shouldWrapValue: (_value: unknown): _value is object => false,
    })).toBe(view)
    expect(view.length).toBe(1)
    expect(view[0]?.value).toBe(1)
    expect('length' in view).toBe(true)
    expect(Object.keys(view)).toEqual(['0'])
    expect(Object.getOwnPropertyDescriptor(view, 'length')?.configurable).toBe(false)
    expect(view.map(item => item.value)).toEqual([1])
    view[0] = { value: 2 }
    expect(target[0]?.value).toBe(2)
    expect(subscriptions).toBeGreaterThan(0)
  })

  it('returns undefined descriptors and configurable object descriptors', () => {
    const view = createReactiveView({ value: 1 }, () => {}, new WeakMap(), {
      preserveArrayLengthDescriptor: false,
      shouldWrapValue: (_value: unknown): _value is object => false,
    })
    expect(Object.getOwnPropertyDescriptor(view, 'missing')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(view, 'value')?.configurable).toBe(true)
  })
})
