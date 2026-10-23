import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { holoSvelteKitRealtime } from '../src/vite'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('SvelteKit realtime client definitions', () => {
  it('serves the browser definition of a server realtime module before the server-only guard runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-realtime-load-'))
    roots.push(root)
    await mkdir(join(root, 'server/realtime'), { recursive: true })
    const file = join(root, 'server/realtime/posts.ts')
    await writeFile(file, 'import { query } from \'@holo-js/realtime\'\nexport const posts = query({ name: \'posts.list\', handler: async () => [] })\n')
    const plugin = holoSvelteKitRealtime(root)

    const browserCode = await plugin.load?.(file, { ssr: false })

    expect(browserCode).toEqual(expect.stringContaining('posts.list'))
    expect(browserCode).not.toContain('async () => []')
    expect(await plugin.load?.(file, { ssr: true })).toBeNull()
  })

  it('does not transform a module twice after serving its browser definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-realtime-once-'))
    roots.push(root)
    await mkdir(join(root, 'server/realtime'), { recursive: true })
    const file = join(root, 'server/realtime/posts.ts')
    await writeFile(file, 'import { query } from \'@holo-js/realtime\'\nexport const posts = query({ name: \'posts.list\', handler: async () => [] })\n')
    const plugin = holoSvelteKitRealtime(root)

    const browserCode = await plugin.load?.(file, { ssr: false })

    expect(plugin.transform(browserCode ?? '', file)).toBeNull()
  })
})
