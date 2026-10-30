import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import serverActionLoader from '../src/server-action-loader'

vi.mock('@holo-js/adapter-next/runtime', () => ({
  adapterNextRuntimeInternals: {
    serverAction: <TArgs extends readonly unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>) => (
      Object.assign(async (...args: TArgs) => ({ wrapped: await action(...args) }), { original: action })
    ),
  },
}))

async function importCompiled(filename: string, source: string): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(import.meta.dirname, '.server-actions-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, filename)
  await writeFile(join(directory, 'helpers.ts'), 'export async function shared() { return \'shared\' }\n')
  await writeFile(file, serverActionLoader.call({ resourcePath: file }, source))
  return await import(file) as Record<string, unknown>
}

describe('Next server action loader', () => {
  it('wraps every export of a use server module and keeps the directive first', async () => {
    const source = [
      '// actions',
      '\'use server\'',
      'export async function save(value: string) { return `saved ${value}` }',
      'export const remove = async () => \'removed\'',
      'async function rename() { return \'renamed\' }',
      'export { rename, rename as alias }',
      'export { shared } from \'./helpers\'',
      'export default async function submit() { return save(\'default\') }',
    ].join('\n')

    const module = await importCompiled('actions.ts', source)
    const compiled = serverActionLoader.call({ resourcePath: 'actions.ts' }, source)

    expect(compiled.trimStart().startsWith('// actions\n\'use server\'')).toBe(true)
    expect(await Promise.all(['save', 'remove', 'rename', 'alias', 'shared', 'default'].map(name => (module[name] as () => Promise<unknown>)()))).toEqual([
      { wrapped: 'saved undefined' },
      { wrapped: 'removed' },
      { wrapped: 'renamed' },
      { wrapped: 'renamed' },
      { wrapped: 'shared' },
      { wrapped: 'saved default' },
    ])
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
