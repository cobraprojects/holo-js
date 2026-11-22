import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { NextModuleInputSourceMap } from '@holo-js/adapter-shared/build'
import routeLoader from '../src/route-loader'
import serverActionLoader from '../src/server-action-loader'

vi.mock('@holo-js/adapter-next/runtime', () => {
  const wrapped = new WeakSet<object>()
  return { adapterNextRuntimeInternals: {
    serverAction: <TArgs extends readonly unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>) => {
      if (wrapped.has(action)) return action
      const invoke = async (...args: TArgs) => ({ wrapped: await action(...args) })
      wrapped.add(invoke)
      return invoke
    },
    routeHandler: <TArgs extends readonly unknown[], TResult>(handler: (...args: TArgs) => Promise<TResult>) => (
      async (...args: TArgs) => ({ route: await handler(...args) })
    ),
  } }
})

type LoaderOutput = { readonly code: string, readonly map?: unknown }

type NextSwc = {
  loadBindings(): Promise<unknown>
  transform(source: string, options: Record<string, unknown>): Promise<{ readonly code: string }>
}

type NextServerReferenceInfo = {
  extractInfoFromServerReferenceId(id: string): unknown
  omitUnusedArgs(args: readonly unknown[], info: unknown): unknown[]
}

const requireNext = createRequire(import.meta.url)
const nextSwc = requireNext('next/dist/build/swc/index.js') as NextSwc
const nextServerReferenceInfo = requireNext('next/dist/shared/lib/server-reference-info.js') as NextServerReferenceInfo

async function nextActionIds(source: string, isReactServerLayer: boolean): Promise<readonly string[]> {
  await nextSwc.loadBindings()
  const { code } = await nextSwc.transform(source, {
    filename: '/app/actions.ts',
    jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
    serverActions: { isReactServerLayer, isDevelopment: false, useCacheEnabled: false, hashSalt: '', cacheKinds: [] },
    serverComponents: { isReactServerLayer, cacheComponentsEnabled: false, useCacheEnabled: false, taintEnabled: false, pageExtensions: [] },
  })
  return [...new Set([...code.matchAll(/"([0-9a-f]{42})"/g)].map(match => match[1]!))].sort()
}

function runLoader(loader: typeof serverActionLoader, resourcePath: string, source: string, inputMap?: NextModuleInputSourceMap): LoaderOutput {
  let output: LoaderOutput | undefined
  const returned = loader.call({
    resourcePath,
    callback: (_error: null, code: string, map?: unknown) => { output = { code, map } },
  }, source, inputMap)
  expect(returned).toBeUndefined()
  return output!
}

function withExportKeywordsBlanked(line: string): string {
  return line.replace(/^export (?:default )?(?=async function)/, keywords => ' '.repeat(keywords.length))
}

function withoutWrapperCall(line: string): string {
  return line.replace(/__holoRouteRuntime\.serverAction\((.*)\)$/, '$1')
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

  it('lets Next send every argument a caller passes, including form data an action does not declare', async () => {
    const source = [
      '\'use server\'',
      'export async function retire(organizationId: string) { return organizationId }',
      'export const remove = async () => \'removed\'',
      'async function rename() { return \'renamed\' }',
      'export { rename as alias }',
      'export default async function () { return \'default\' }',
      'export async function overloaded(value: string): Promise<string>',
      'export async function overloaded(value?: string) { return value ?? \'none\' }',
    ].join('\n')
    const compiled = serverActionLoader.call({ resourcePath: '/app/actions.ts' }, source)!
    const formData = new FormData()

    const browserIds = await nextActionIds(compiled, false)

    expect(browserIds).toHaveLength(5)
    expect(browserIds).toEqual(await nextActionIds(compiled, true))
    for (const id of browserIds) {
      const sent = nextServerReferenceInfo.omitUnusedArgs(['organization', formData], nextServerReferenceInfo.extractInfoFromServerReferenceId(id))
      expect(sent).toEqual(['organization', formData])
    }
  })

  it('wraps an action exported as default by name before the export reads it', async () => {
    const module = await importCompiled('default-actions.ts', [
      '\'use server\'',
      'const submit = async () => \'submitted\'',
      'export default submit',
    ].join('\n'))

    expect(await (module.default as () => Promise<unknown>)()).toEqual({ wrapped: 'submitted' })
  })

  it('exports the action a default export named when it ran, not a later reassignment', async () => {
    const module = await importCompiled('reassigned-default-actions.ts', [
      '\'use server\'',
      'let submit = async () => \'original\'',
      'export default submit',
      'submit = async () => \'replacement\'',
    ].join('\n'))

    expect(await (module.default as () => Promise<unknown>)()).toEqual({ wrapped: 'original' })
  })

  it('keeps an exported let action live when the module reassigns it', async () => {
    const module = await importCompiled('live-actions.ts', [
      '\'use server\'',
      'export let current = async () => \'original\'',
      'export async function replace() { current = async () => \'replacement\' }',
    ].join('\n'))

    await (module.replace as () => Promise<unknown>)()

    expect(await (module.current as () => Promise<unknown>)()).toBe('replacement')
  })

  it('wraps an action the module reassigns before an export reads it', async () => {
    const module = await importCompiled('reassigned-actions.ts', [
      '\'use server\'',
      'export let action = async () => \'original\'',
      'action = async () => \'replacement\'',
      'let fallback = async () => \'original\'',
      'fallback = async () => \'replacement\'',
      'export default fallback',
    ].join('\n'))

    expect(await Promise.all([module.action, module.default].map(action => (action as () => Promise<unknown>)()))).toEqual([
      { wrapped: 'replacement' },
      { wrapped: 'replacement' },
    ])
  })

  it('keeps the columns after an export list that mixes actions and types', () => {
    const source = ['\'use server\'', 'type T = string', 'async function a() { return 1 }', 'export {a, type T}; export async function b() {}'].join('\n')

    const lines = runLoader(serverActionLoader, 'actions.ts', source).code.split('\n')

    expect(lines[3]!.indexOf('async function b')).toBe(source.split('\n')[3]!.indexOf('async function b'))
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

  it('appends the runtime import, so a shebang, a terminated directive, and the original code stay in place', async () => {
    const actions = ['\'use server\';', 'export const save = async () => { return \'saved\' }'].join('\n')
    const route = ['#!/usr/bin/env node', 'export const GET = async () => \'got\''].join('\n')

    for (const [source, loader] of [[actions, serverActionLoader], [route, routeLoader]] as const) {
      const lines = loader.call({ resourcePath: 'module.ts' }, source)!.split('\n')
      const expected = source.split('\n').map(line => loader === serverActionLoader ? withExportKeywordsBlanked(line) : line)
      expect(lines.slice(0, 2).map(line => withoutWrapperCall(line).replace('let  ', 'const'))).toEqual(expected)
      expect(lines[2]).toMatch(/^import \{ adapterNextRuntimeInternals as __holoRouteRuntime \} from /)
    }
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

  it('keeps every line of a use server module in place and maps each position back to it', () => {
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

    expect(lines.slice(0, source.split('\n').length).map(line => withoutWrapperCall(line).replace('let  ', 'const').replace('function __holoDefault (', 'function ('))).toEqual(source.split('\n').map(withExportKeywordsBlanked))
    for (const needle of ['aiMessage(kind', 'switch (kind)', 'return shared()', 'throw new Error', 'async () => \'removed\'', 'return aiMessage(']) {
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

    expect(output.code.split('\n')).toHaveLength(source.split('\n').length + 5)
    for (const needle of ['POST(request', 'throw new Error', 'return shared()', 'DELETE = async']) {
      expectMapped(output, source, needle, resourcePath)
    }
    const reExport = position(output.code, '__holoExportedGET =')
    expect(originalPositionFor(new TraceMap(output.map as string), reExport)).toMatchObject({ line: 3 })
  })

  it('keeps the lines after a replaced statement that spans several lines in place', () => {
    const route = ['export {', '  shared as GET, shared /* kept', '  comment */ as other', '} from \'./hel\\', 'pers\'', 'export async function POST() { throw new Error(\'x\') }'].join('\n')
    const actions = ['\'use server\'', 'export default', '(async () => 1)', 'export async function save() { throw new Error(\'x\') }'].join('\n')

    for (const [source, loader] of [[route, routeLoader], [actions, serverActionLoader]] as const) {
      const lines = source.split('\n')
      const expected = loader === serverActionLoader ? withExportKeywordsBlanked(lines.at(-1)!) : lines.at(-1)
      expect(runLoader(loader, 'module.ts', source).code.split('\n')[lines.length - 1]).toBe(expected)
    }
    const carriageReturns = ['export {', ' GET', '} from \'./helpers\'', 'export async function POST() {}'].join('\r')
    expect(runLoader(routeLoader, 'route.ts', carriageReturns).code.split(/\r\n|[\r\n]/)[3]).toBe('export async function POST() {}')
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
