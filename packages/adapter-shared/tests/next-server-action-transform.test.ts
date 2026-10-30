import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, onTestFinished } from 'vitest'
import { compileNextServerActions } from '../src/build'

const runtimeImport = 'import { adapterNextRuntimeInternals as __holoServerActionRuntime } from "@holo-js/adapter-next/runtime";'
const fakeRuntime = 'const __holoServerActionRuntime = { serverAction: (action: (...args: unknown[]) => unknown) => Object.assign((...args: unknown[]) => action(...args), { wrapped: true }) };'

type LoadedAction = ((...args: unknown[]) => Promise<unknown>) & { readonly wrapped?: true }

function transpile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
}

async function loadActions(source: string, filename: string, siblings: Record<string, string> = {}): Promise<Record<string, LoadedAction>> {
  const output = compileNextServerActions(source, filename)
  expect(output).toContain(runtimeImport)
  const directory = await mkdtemp(join(tmpdir(), 'holo-server-actions-'))
  onTestFinished(async () => await rm(directory, { recursive: true, force: true }))
  for (const [name, sibling] of Object.entries(siblings)) await writeFile(join(directory, name), sibling)
  const modulePath = join(directory, 'actions.mjs')
  await writeFile(modulePath, transpile(output.replace(runtimeImport, fakeRuntime)))
  return await import(pathToFileURL(modulePath).href) as Record<string, LoadedAction>
}

describe('Next server action transform', () => {
  it('wraps every exported action while keeping export names and module semantics', async () => {
    const actions = await loadActions([
      '\'use server\'',
      'import { archive as imported } from \'./archive.mjs\'',
      'const identity = <T>(value: T) => value',
      'const __holoServerAction_1 = \'taken\'',
      'export { listedFirst, imported }',
      'export async function load() { return identity(1) }',
      'export const update = async () => await load()',
      'export const { destructured } = { destructured: async () => 2 }',
      'export default async function save() { return await load() }',
      'const listedFirst = async () => await load()',
      'async function remove() { return __holoServerAction_1 }',
      'export { remove as deletePost, remove as "remove-post" }',
      'export { archive, archive as "archive-post" } from \'./archive.mjs\'',
    ].join('\n'), '/app/actions.ts', { 'archive.mjs': 'export async function archive() { return \'archived\' }\n' })

    const expected = {
      load: 1, update: 1, destructured: 2, default: 1, listedFirst: 1, imported: 'archived',
      deletePost: 'taken', 'remove-post': 'taken', archive: 'archived', 'archive-post': 'archived',
    }
    expect(Object.keys(actions).sort()).toEqual(Object.keys(expected).sort())
    for (const [name, result] of Object.entries(expected)) {
      expect(actions[name]?.wrapped, name).toBe(true)
      await expect(actions[name]!(), name).resolves.toBe(result)
    }
  })

  it('gives code inside the module the exported actions and keeps exports live', async () => {
    const actions = await loadActions([
      '\'use server\'',
      'const early = declared',
      'export async function declared() { return 1 }',
      'export const assigned = async () => 2',
      'const { listed } = { listed: async () => 3 }',
      'export { listed }',
      'export const references = async () => [early, declared, assigned, listed, capturedSplit]',
      'const { split } = { split: async () => 9 }, capturedSplit = split',
      'let delayed',
      'delayed = async () => 10',
      'let reassigned = async () => 11',
      'reassigned = async () => 12',
      'export { split, delayed, reassigned }',
      'export let replaceable = async () => 4',
      'export const replace = async () => { replaceable = async () => 5 }',
    ].join('\n'), '/app/actions.ts')

    const [early, declared, assigned, listed, capturedSplit] = await actions.references!() as readonly unknown[]
    expect(capturedSplit).toBe(actions.split)
    expect(early).toBe(actions.declared)
    expect(declared).toBe(actions.declared)
    expect(assigned).toBe(actions.assigned)
    expect(listed).toBe(actions.listed)
    expect(actions.delayed?.wrapped).toBe(true)
    await expect(actions.delayed!()).resolves.toBe(10)
    expect(actions.reassigned?.wrapped).toBe(true)
    await expect(actions.reassigned!()).resolves.toBe(12)
    await actions.replace!()
    await expect(actions.replaceable!()).resolves.toBe(5)
  })

  it('gives each export of the same action its own wrapper and wraps anonymous default functions', async () => {
    const named = await loadActions([
      '\'use server\'',
      'export default async function save() { return 6 }',
      'async function remove() { return 7 }',
      'export { save, remove as deletePost, remove as "remove-post" }',
    ].join('\n'), '/app/actions.ts')
    const anonymous = await loadActions('\'use server\'\nexport default async function () { return 8 }\n', '/app/anonymous.ts')
    const aliased = await loadActions('\'use server\'\nexport const shared = async () => 9\nexport { shared as default }\n', '/app/aliased.ts')

    expect(new Set([named.default, named.save, named.deletePost, named['remove-post']]).size).toBe(4)
    for (const action of [named.default, named.save, named.deletePost, named['remove-post'], anonymous.default]) expect(action?.wrapped).toBe(true)
    await expect(named.save!()).resolves.toBe(6)
    await expect(named['remove-post']!()).resolves.toBe(7)
    await expect(anonymous.default!()).resolves.toBe(8)
    expect(aliased.default).not.toBe(aliased.shared)
    expect(aliased.default?.wrapped).toBe(true)
    await expect(aliased.default!()).resolves.toBe(9)
  })

  it('leaves use cache functions for Next to compile', () => {
    const source = [
      '\'use server\'',
      'export async function cached() { \'use cache\'; return 1 }',
      'export const cachedArrow = async () => { \'use cache: remote\'; return 2 }',
      'export { cached as alias, cachedArrow as default }',
    ].join('\n')
    expect(compileNextServerActions(source, '/app/actions.ts')).toBe(source)
    for (const defaultExport of ['export default async function () { \'use cache\'; return 3 }', 'export default async () => { \'use cache\'; return 4 }']) {
      expect(compileNextServerActions(`'use server'\n${defaultExport}\n`, '/app/actions.ts')).toBe(`'use server'\n${defaultExport}\n`)
    }
  })

  it('keeps the directive prologue before the runtime import', () => {
    expect(compileNextServerActions('"use server"\nexport default action\n', '/app/actions.ts'))
      .toBe(`"use server";\n${runtimeImport}\nexport default __holoServerActionRuntime.serverAction(action);\n`)
  })

  it('leaves modules without a top-level use server directive unchanged', () => {
    for (const source of [
      'export async function action() {}\n',
      'import x from \'y\'\n\'use server\'\nexport async function action() {}\n',
      'export async function action() {\n  \'use server\'\n}\n',
      '\'use client\'\nexport function Button() { return \'use server\' }\n',
    ]) {
      expect(compileNextServerActions(source, '/app/actions.ts')).toBe(source)
    }
  })

  it('leaves a use server module with only type and star exports unchanged', () => {
    const source = '\'use server\'\nexport type Input = { id: number }\nexport * from \'./other\'\n'
    expect(compileNextServerActions(source, '/app/actions.ts')).toBe(source)
  })
})
