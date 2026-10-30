import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { NextModuleInputSourceMap } from '@holo-js/adapter-shared/build'
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

type LoaderOutput = { readonly code: string, readonly map?: unknown }

function runLoader(loader: typeof serverActionLoader, resourcePath: string, source: string, inputMap?: NextModuleInputSourceMap): LoaderOutput {
  let output: LoaderOutput | undefined
  const returned = loader.call({
    resourcePath,
    callback: (_error: null, code: string, map?: unknown) => { output = { code, map } },
  }, source, inputMap)
  expect(returned).toBeUndefined()
  return output!
}

function position(text: string, needle: string): { readonly line: number, readonly column: number } {
  const index = text.indexOf(needle)
  expect(index).toBeGreaterThanOrEqual(0)
  const before = text.slice(0, index).split('\n')
  return { line: before.length, column: before.at(-1)!.length }
}

function expectMapped(output: LoaderOutput, source: string, needle: string, resourcePath: string): void {
  const generated = position(output.code, needle)
  const original = originalPositionFor(new TraceMap(output.map as string), generated)
  expect(original).toMatchObject({ source: resourcePath, ...position(source, needle) })
}

async function importCompiled(filename: string, source: string, loader = serverActionLoader): Promise<Record<string, unknown>> {
  const directory = await mkdtemp(join(import.meta.dirname, '.server-actions-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, filename)
  await writeFile(join(directory, 'helpers.ts'), 'export async function shared() { return \'shared\' }\n')
  await writeFile(file, loader.call({ resourcePath: file }, source)!)
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
    const compiled = serverActionLoader.call({ resourcePath: 'actions.ts' }, source)!

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

  it('wraps an action exported as default by name before the export reads it', async () => {
    const module = await importCompiled('default-actions.ts', [
      '\'use server\'',
      'const submit = async () => \'submitted\'',
      'export default submit',
    ].join('\n'))

    expect(await (module.default as () => Promise<unknown>)()).toEqual({ wrapped: 'submitted' })
  })

  it('wraps a default-exported arrow action', async () => {
    const module = await importCompiled('arrow-actions.ts', [
      '\'use server\'',
      'export default (async () => \'arrow\')',
    ].join('\n'))

    expect(await (module.default as () => Promise<unknown>)()).toEqual({ wrapped: 'arrow' })
  })

  it('wraps an anonymous default action without clashing with module bindings', async () => {
    const module = await importCompiled('anonymous-actions.ts', [
      '\'use server\'',
      'const __holoDefaul\\u0074 = \'taken\'',
      'const __holoRouteRuntime = \'runtime\'',
      'export default async function () { return `${__holoDefault} ${__holoRouteRuntime}` }',
    ].join('\n'))

    expect(await (module.default as () => Promise<unknown>)()).toEqual({ wrapped: 'taken runtime' })
  })

  it('wraps route handlers declared, listed, imported, or re-exported in a route file', async () => {
    const module = await importCompiled('route.ts', [
      'import { shared } from \'./helpers\'',
      'export { shared as GET } from \'./helpers\'',
      'export { shared as PUT }',
      'const __holoExportedGET = \'kept\'',
      'export async function POST() { return \'posted\' }',
      'const DELETE = async () => \'deleted\'',
      'export { DELETE }',
      'export const dynamic = \'force-dynamic\'',
    ].join('\n'), routeLoader)

    expect(await Promise.all(['GET', 'PUT', 'POST', 'DELETE'].map(name => (module[name] as () => Promise<unknown>)()))).toEqual([
      { route: 'shared' },
      { route: 'shared' },
      { route: 'posted' },
      { route: 'deleted' },
    ])
    expect(module.dynamic).toBe('force-dynamic')
  })

  it('inserts the runtime import after a terminated directive or a shebang without moving any line', async () => {
    const actions = ['\'use server\';', 'export const save = async () => \'saved\''].join('\n')
    const route = ['#!/usr/bin/env node', 'export const GET = async () => \'got\''].join('\n')

    for (const [source, loader] of [[actions, serverActionLoader], [route, routeLoader]] as const) {
      expect(loader.call({ resourcePath: 'module.ts' }, source)!.split('\n')).toHaveLength(source.split('\n').length + 2)
    }
    expect(serverActionLoader.call({ resourcePath: 'module.ts' }, actions)).toMatch(/^'use server';import /)
    expect(await (((await importCompiled('terminated-actions.ts', actions)).save) as () => Promise<unknown>)()).toEqual({ wrapped: 'saved' })
    expect(await (((await importCompiled('route.ts', route, routeLoader)).GET) as () => Promise<unknown>)()).toEqual({ route: 'got' })
  })

  it('leaves modules without a leading use server directive unchanged', () => {
    for (const source of [
      'export async function save() { \'use server\'; return 1 }',
      'import \'./setup\'\n\'use server\'\nexport async function save() { return 1 }',
    ]) {
      expect(serverActionLoader.call({ resourcePath: 'page.tsx' }, source)).toBe(source)
    }
  })

  it('keeps every untouched line of a use server module in place and maps each position back to it', () => {
    const resourcePath = join(import.meta.dirname, 'app', 'ai-actions.ts')
    const source = [
      '// AI actions',
      '\'use server\'',
      '',
      'import { shared } from \'./helpers\'',
      '',
      'export async function aiMessage(kind: string) {',
      '  switch (kind) {',
      '    case \'a\': case \'b\': return shared()',
      '  }',
      '  throw new Error(`unknown ${kind}`)',
      '}',
      '',
      'export const remove = async () => \'removed\'',
      'export default async function () { return aiMessage(\'a\') }',
    ].join('\n')

    const output = runLoader(serverActionLoader, resourcePath, source)
    const lines = output.code.split('\n')

    for (const [index, line] of source.split('\n').entries()) {
      if (index !== 1 && index < 12) expect(lines[index]).toBe(line)
    }
    for (const needle of ['aiMessage(kind', 'switch (kind)', 'return shared()', 'throw new Error', 'remove = async', 'return aiMessage(']) {
      expectMapped(output, source, needle, resourcePath)
    }
    expect(output.map).toMatchObject({ version: 3, file: resourcePath, sources: [resourcePath], sourcesContent: [source] })
  })

  it('maps route handlers, including localized re-exports, back to their original lines', () => {
    const resourcePath = join(import.meta.dirname, 'app', 'api', 'route.ts')
    const source = [
      'import { shared } from \'./helpers\'',
      '',
      'export { shared as GET } from \'./helpers\'',
      '',
      'export async function POST(request: Request) {',
      '  if (!request.ok) throw new Error(\'bad request\')',
      '  return shared()',
      '}',
      'export const DELETE = async () => \'deleted\'',
    ].join('\n')

    const output = runLoader(routeLoader, resourcePath, source)

    expect(output.code.split('\n')).toHaveLength(source.split('\n').length + 4)
    for (const needle of ['POST(request', 'throw new Error', 'return shared()', 'DELETE = async']) {
      expectMapped(output, source, needle, resourcePath)
    }
    const reExport = position(output.code, '__holoExportedGET =')
    expect(originalPositionFor(new TraceMap(output.map as string), reExport)).toMatchObject({ line: 3 })
  })

  it('chains the map an earlier loader passed', () => {
    const resourcePath = join(import.meta.dirname, 'app', 'actions.ts')
    const original = ['\'use server\'', 'export async function save() {', '  throw new Error(\'save failed\')', '}'].join('\n')
    const source = `// banner\n${original}`
    const inputMap: NextModuleInputSourceMap = {
      version: 3,
      sources: [resourcePath],
      sourcesContent: [original],
      names: [],
      mappings: `;${['AAAA', 'AACA', 'AACA', 'AACA'].join(';')}`,
    }

    const output = runLoader(serverActionLoader, resourcePath, source, inputMap)

    const generated = position(output.code, 'throw new Error')
    expect(originalPositionFor(new TraceMap(output.map as string), generated)).toMatchObject({ source: resourcePath, line: 3 })
  })

  it('passes an unchanged module and its incoming map through the loader callback', () => {
    const source = 'export async function save() { return 1 }'
    const inputMap: NextModuleInputSourceMap = { version: 3, sources: ['page.tsx'], names: [], mappings: 'AAAA' }

    for (const loader of [serverActionLoader, routeLoader]) {
      expect(runLoader(loader, 'page.tsx', source, inputMap)).toEqual({ code: source, map: inputMap })
    }
  })
})
