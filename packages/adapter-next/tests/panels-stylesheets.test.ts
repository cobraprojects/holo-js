import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withHolo } from '../src/config'

const repository = resolve(import.meta.dirname, '../../..')
const stylesheet = { name: 'editor', src: '/_holo-panels/assets/editor.a123.css', components: ['rich-editor'] }
let previousCwd: string
let root: string
let manifest: string

function writeManifest(value: unknown): void {
  writeFileSync(manifest, JSON.stringify(value))
}

beforeEach(() => {
  previousCwd = process.cwd()
  root = mkdtempSync(join(repository, '.holo-panels-stylesheets-'))
  const generated = join(root, '.holo-js/generated/panels')
  mkdirSync(generated, { recursive: true })
  manifest = join(generated, 'plugins.json')
  process.chdir(root)
})

afterEach(() => {
  process.chdir(previousCwd)
  rmSync(root, { recursive: true, force: true })
})

describe('Panels prepared stylesheet defines', () => {
  it('forwards a JSON string of prepared URLs and preserves caller configuration', () => {
    writeManifest({ version: 1, plugins: [], stylesheets: [stylesheet, { name: '@panels/theme:base', src: '/theme.css', components: [], eager: true }] })
    const input = {
      basePath: '/dashboard',
      compiler: { styledComponents: true, define: { CUSTOM: 'value', ENABLED: true, COUNT: 2 } },
      turbopack: { rules: { '*.txt': { loaders: ['text-loader'] } } },
      rewrites: async () => [{ source: '/old', destination: '/new' }],
    }
    const before = structuredClone({ ...input, rewrites: undefined })
    const result = withHolo(input)
    expect(result.compiler).toEqual({
      styledComponents: true,
      define: {
        ...input.compiler.define,
        __HOLO_APP_BASE__: '/dashboard',
        'globalThis.__HOLO_PANELS_STYLESHEETS__': JSON.stringify({ editor: stylesheet.src, '@panels/theme:base': '/theme.css' }),
      },
    })
    expect(result.turbopack.rules['*.txt']).toEqual(input.turbopack.rules['*.txt'])
    expect({ ...input, rewrites: undefined }).toEqual(before)
    return expect(result.rewrites()).resolves.toEqual([{ source: '/old', destination: '/new' }])
  })

  it.each([undefined, { version: 1 }, { version: 1, stylesheets: [] }])('leaves ordinary defines unchanged for absent or empty stylesheets: %j', (value) => {
    if (value !== undefined) writeManifest(value)
    expect(withHolo({ compiler: { define: { CUSTOM: 'value' } } }).compiler?.define).toEqual({ CUSTOM: 'value', __HOLO_APP_BASE__: '' })
  })

  it.each([
    null,
    [],
    { version: 2, stylesheets: [stylesheet] },
    { stylesheets: [stylesheet] },
    { version: 1, stylesheets: null },
    { version: 1, stylesheets: {} },
    { version: 1, stylesheets: [null] },
    { version: 1, stylesheets: [stylesheet, stylesheet] },
    { version: 1, stylesheets: Array.from({ length: 1_001 }, () => stylesheet) },
  ])('rejects malformed declarations: %j', (value) => {
    writeManifest(value)
    expect(() => withHolo()).toThrow(/Invalid Holo Panels stylesheet metadata/)
  })

  it.each([
    { name: '' },
    { name: '__proto__' },
    { name: 'constructor' },
    { name: 'has spaces' },
    { name: 'x'.repeat(257) },
    { src: 'https://example.com/editor.css' },
    { src: '//example.com/editor.css' },
    { src: 'editor.css' },
    { src: '/a/../editor.css' },
    { src: '/%2e%2e/editor.css' },
    { src: '/a\\editor.css' },
    { src: '/editor.css?query' },
    { src: '/editor.css#hash' },
    { src: '/editor.js' },
    { src: `/${'a'.repeat(2_048)}.css` },
    { components: undefined },
    { components: 'rich-editor' },
    { components: [null] },
    { components: Array.from({ length: 1_001 }, () => 'editor') },
    { eager: 'true' },
    { eager: null },
  ])('rejects unsafe or unbounded stylesheet fields: %j', (fields) => {
    writeManifest({ version: 1, stylesheets: [{ ...stylesheet, ...fields }] })
    expect(() => withHolo()).toThrow(/Invalid Holo Panels stylesheet metadata/)
  })

  it.skipIf(process.platform === 'win32')('rejects FIFO metadata without waiting for a writer', () => {
    execFileSync('mkfifo', [manifest])
    const entry = pathToFileURL(join(repository, 'packages/adapter-next/src/config.ts')).href
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
import { strict as assert } from 'node:assert'
import { withHolo } from ${JSON.stringify(entry)}
assert.throws(() => withHolo(), /Invalid Holo Panels stylesheet metadata/)
`], { cwd: root, timeout: 5_000, stdio: 'pipe' })
  })

  it('rejects invalid JSON, oversized files, and non-file metadata', () => {
    for (const content of ['{', ' '.repeat(1_048_577)]) {
      writeFileSync(manifest, content)
      expect(() => withHolo()).toThrow(/Invalid Holo Panels stylesheet metadata/)
    }
    rmSync(manifest)
    mkdirSync(manifest)
    expect(() => withHolo()).toThrow(/Invalid Holo Panels stylesheet metadata/)
  })
})
