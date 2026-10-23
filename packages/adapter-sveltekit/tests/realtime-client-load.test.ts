import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { holoSvelteKitRealtime } from '../src/vite'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function realtimeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-realtime-load-'))
  roots.push(root)
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), source)
  }
  return root
}

const definitionsModule = [
  'import { query } from \'@holo-js/realtime\'',
  'export const posts = query({ name: \'posts.list\', handler: async () => [] })',
  '',
].join('\n')

describe('SvelteKit realtime client definitions', () => {
  it('serves the browser definition of a server realtime module before the server-only guard runs', async () => {
    const root = await realtimeProject({ 'server/realtime/posts.ts': definitionsModule })
    const file = join(root, 'server/realtime/posts.ts')
    const plugin = holoSvelteKitRealtime(root)

    const browserCode = await plugin.load?.(file, { ssr: false })

    expect(browserCode).toEqual(expect.stringContaining('posts.list'))
    expect(browserCode).not.toContain('async () => []')
    expect(await plugin.load?.(file, { ssr: true })).toBeNull()
  })

  it('does not transform a module twice after serving its browser definition', async () => {
    const root = await realtimeProject({ 'server/realtime/posts.ts': definitionsModule })
    const file = join(root, 'server/realtime/posts.ts')
    const plugin = holoSvelteKitRealtime(root)

    const browserCode = await plugin.load?.(file, { ssr: false })

    expect(plugin.transform(browserCode ?? '', file)).toBeNull()
  })

  it('fails closed for a server realtime module with no definitions and never sends its source', async () => {
    const root = await realtimeProject({
      'server/realtime/admin.ts': [
        'import { db } from \'@holo-js/db\'',
        'export const ADMIN_TOKEN = \'sk_live_example\'',
        'export function helper() { return db }',
        '',
      ].join('\n'),
    })
    const file = join(root, 'server/realtime/admin.ts')
    const plugin = holoSvelteKitRealtime(root)

    expect(() => plugin.load?.(file, { ssr: false })).toThrow('server/realtime/admin.ts')
  })

  it('keeps extra server code and secret constants out of the browser stub', async () => {
    const root = await realtimeProject({
      'server/realtime/posts.ts': [
        'import { query } from \'@holo-js/realtime\'',
        'import { db } from \'@holo-js/db\'',
        'const ADMIN_TOKEN = \'sk_live_example\'',
        'export function helper() { return db }',
        'export const posts = query({ name: \'posts.list\', handler: async () => [ADMIN_TOKEN] })',
        '',
      ].join('\n'),
    })
    const file = join(root, 'server/realtime/posts.ts')
    const plugin = holoSvelteKitRealtime(root)

    const browserCode = await plugin.load?.(file, { ssr: false }) ?? ''

    expect(browserCode).toEqual(expect.stringContaining('posts.list'))
    expect(browserCode).not.toContain('sk_live_example')
    expect(browserCode).not.toContain('ADMIN_TOKEN')
    expect(browserCode).not.toContain('@holo-js/db')
    expect(browserCode).not.toContain('helper')
  })

  it('fails closed when a definition name is not a string literal', async () => {
    const root = await realtimeProject({
      'server/realtime/posts.ts': [
        'import { query } from \'@holo-js/realtime\'',
        'export const posts = query({ name: process.env.POSTS_NAME, handler: async () => [] })',
        '',
      ].join('\n'),
    })
    const file = join(root, 'server/realtime/posts.ts')
    const plugin = holoSvelteKitRealtime(root)

    expect(() => plugin.load?.(file, { ssr: false })).toThrow('server/realtime/posts.ts')
  })
})
