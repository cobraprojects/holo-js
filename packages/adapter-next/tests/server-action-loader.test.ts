import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import routeLoader from '../src/route-loader'
import serverActionLoader from '../src/server-action-loader'

vi.mock('@holo-js/adapter-next/runtime', () => ({
  adapterNextRuntimeInternals: {
    serverAction: <TArgs extends readonly unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>) => (
      Object.assign(async (...args: TArgs) => ({ wrapped: await action(...args) }), { original: action })
    ),
    routeHandler: <TArgs extends readonly unknown[], TResult>(handler: (...args: TArgs) => Promise<TResult>) => (
      async (...args: TArgs) => ({ route: await handler(...args) })
    ),
  },
}))

async function importCompiled(filename: string, source: string, loader = serverActionLoader): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(import.meta.dirname, '.server-actions-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, filename)
  await writeFile(join(directory, 'helpers.ts'), 'export async function shared() { return \'shared\' }\n')
  await writeFile(file, loader.call({ resourcePath: file }, source))
  return await import(file) as Record<string, unknown>
}

describe('Next server action loader', () => {
  it('wraps every local export of a use server module through its binding and keeps the directive first', async () => {
    const source = [
      '// actions',
      '\'use server\'',
      'export { later, rename as alias, type Payload, Result }',
      'export const early = save',
      'interface Result { readonly ok: boolean }',
      'type Payload = { readonly value: string }',
      'export const { pick } = { pick: async () => \'picked\' }',
      'export async function save(value: string) { return `saved ${value}` }',
      'export const remove = async () => \'removed\'',
      'async function rename() { return \'renamed\' }',
      'export { shared } from \'./helpers\'',
      'export async function current() { return [save, pick] }',
      'const later = async () => \'later\'',
      'export default async function submit() { return save(\'default\') }',
    ].join('\n')

    const module = await importCompiled('actions.ts', source)
    const compiled = serverActionLoader.call({ resourcePath: 'actions.ts' }, source)

    expect(compiled.trimStart().startsWith('// actions\n\'use server\'')).toBe(true)
    expect(Object.keys(module).sort()).toEqual(['alias', 'current', 'default', 'early', 'later', 'pick', 'remove', 'save', 'shared'])
    expect(await Promise.all(['save', 'remove', 'alias', 'later', 'pick', 'shared', 'default'].map(name => (module[name] as () => Promise<unknown>)()))).toEqual([
      { wrapped: 'saved undefined' },
      { wrapped: 'removed' },
      { wrapped: 'renamed' },
      { wrapped: 'later' },
      { wrapped: 'picked' },
      'shared',
      { wrapped: { wrapped: 'saved default' } },
    ])
    expect(await (module.current as () => Promise<unknown>)()).toEqual({ wrapped: [module.save, module.pick] })
  })

  it('wraps route handlers declared, listed, or re-exported in a route file', async () => {
    const module = await importCompiled('route.ts', [
      'export { shared as GET } from \'./helpers\'',
      'export async function POST() { return \'posted\' }',
      'const DELETE = async () => \'deleted\'',
      'export { DELETE }',
      'export const dynamic = \'force-dynamic\'',
    ].join('\n'), routeLoader)

    expect(await Promise.all(['GET', 'POST', 'DELETE'].map(name => (module[name] as () => Promise<unknown>)()))).toEqual([
      { route: 'shared' },
      { route: 'posted' },
      { route: 'deleted' },
    ])
    expect(module.dynamic).toBe('force-dynamic')
  })

  it('leaves modules without a leading use server directive unchanged', () => {
    for (const source of [
      'export async function save() { \'use server\'; return 1 }',
      'import \'./setup\'\n\'use server\'\nexport async function save() { return 1 }',
    ]) {
      expect(serverActionLoader.call({ resourcePath: 'page.tsx' }, source)).toBe(source)
    }
  })
})
