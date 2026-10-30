import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { compileNextServerActions } from '../src/build'

const runtimeImport = 'import { adapterNextRuntimeInternals as __holoServerActionRuntime } from "@holo-js/adapter-next/runtime";'

describe('Next server action transform', () => {
  it('wraps every export of a use server module and keeps the directive first', () => {
    const output = compileNextServerActions([
      '\'use server\'',
      'import { validate } from \'@holo-js/forms\'',
      'export async function createPost(formData: FormData) { await validate(formData, form) }',
      'export const updatePost = async (formData: FormData) => formData',
      'export default async function () {}',
      'async function removePost() {}',
      'export { removePost as deletePost }',
      'export { archivePost } from \'./archive\'',
    ].join('\n'), '/app/posts/actions.ts')

    const lines = output.split('\n')
    expect(lines[0]).toBe('\'use server\';')
    expect(lines[1]).toBe(runtimeImport)
    expect(output).toContain('async function createPost(formData: FormData)')
    expect(output).toContain('const __holoServerAction_createPost = __holoServerActionRuntime.serverAction(createPost);\nexport { __holoServerAction_createPost as createPost };')
    expect(output).toContain('export const updatePost = __holoServerActionRuntime.serverAction(async (formData: FormData) => formData);')
    expect(output).toContain('async function __holoServerAction_default() { }')
    expect(output).toContain('export default __holoServerActionRuntime.serverAction(__holoServerAction_default);')
    expect(output).toContain('const __holoServerAction_deletePost = __holoServerActionRuntime.serverAction(removePost);\nexport { __holoServerAction_deletePost as deletePost };')
    expect(output).toContain('import { archivePost as __holoImported_archivePost } from \'./archive\';')
    expect(output).toContain('export { __holoServerAction_archivePost as archivePost };')
  })

  it('keeps declared action names callable inside the module and parses .ts files as TypeScript', async () => {
    const output = compileNextServerActions([
      '\'use server\'',
      'const identity = <T>(value: T) => value',
      'export async function load() { return identity(1) }',
      'export default async function save() { return await load() }',
    ].join('\n'), '/app/actions.ts')
    const transpiled = ts.transpileModule(output.replace(runtimeImport, 'const __holoServerActionRuntime = { serverAction: <T>(action: T) => action };'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = await import(`data:text/javascript,${encodeURIComponent(transpiled)}`) as { default: () => Promise<number> }

    await expect(module.default()).resolves.toBe(1)
  })

  it('wraps a default export expression', () => {
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
