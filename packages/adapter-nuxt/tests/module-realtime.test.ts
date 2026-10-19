import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { moduleInternals } from '../src/module'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Nuxt realtime module transforms', () => {
  it('distinguishes missing packages from unexpected resolution failures', () => {
    expect(moduleInternals.hasProjectPackage('/project', 'missing', () => { throw { code: 'MODULE_NOT_FOUND' } })).toBe(false)
    expect(() => moduleInternals.hasProjectPackage('/project', 'broken', () => { throw new Error('resolver failed') })).toThrow('resolver failed')
    expect(moduleInternals.hasProjectPackage('/project', 'present', () => '/package/index.js')).toBe(true)
  })

  it('recognizes and resolves realtime definition modules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-realtime-'))
    roots.push(root)
    const sourcePath = join(root, 'server/realtime/posts.ts')
    await mkdir(join(root, 'server/realtime'), { recursive: true })
    await writeFile(sourcePath, `import { query } from '@holo-js/realtime'\nexport const posts = query({ name: 'posts.list' })`)

    expect(moduleInternals.existsFile(sourcePath)).toBe(true)
    expect(moduleInternals.existsFile(`${sourcePath}.missing`)).toBe(false)
    expect(moduleInternals.isRealtimeDefinitionModule(root, `${sourcePath}?v=1`)).toBe(true)
    expect(moduleInternals.isRealtimeDefinitionModule(root, join(root, 'server/models/Post.ts'))).toBe(false)
    expect(moduleInternals.resolveExistingRealtimeDefinitionFile(sourcePath)).toBe(sourcePath)
    expect(moduleInternals.resolveExistingRealtimeDefinitionFile(sourcePath.slice(0, -3))).toBe(sourcePath)
    expect(moduleInternals.resolveExistingRealtimeDefinitionFile(join(root, 'server/realtime/missing'))).toBeUndefined()
    expect(moduleInternals.resolveRealtimeDefinitionImport('./posts', sourcePath)).toBeUndefined()
    expect(moduleInternals.resolveRealtimeDefinitionImport('./server/realtime/posts', join(root, 'client.ts'))).toBe(sourcePath)
    expect(moduleInternals.resolveRealtimeDefinitionImport('./server/realtime/posts', undefined)).toBeUndefined()
    expect(moduleInternals.resolveRealtimeDefinitionImport('unrelated', sourcePath)).toBeUndefined()
    expect(moduleInternals.resolveRealtimeDefinitionImport(sourcePath, undefined)).toBe(sourcePath)
  })

  it('builds one realtime definitions module from the project server/realtime files for the Nuxt query and mutation routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-realtime-definitions-'))
    roots.push(root)
    await mkdir(join(root, 'server/realtime/nested'), { recursive: true })
    await writeFile(join(root, 'server/realtime/posts.ts'), `import { query } from '@holo-js/realtime'\nexport const posts = query({ name: 'posts.list', access: 'public', handler: async () => ({ records: [] }) })`)
    await writeFile(join(root, 'server/realtime/nested/comments.ts'), `import { mutation } from '@holo-js/realtime'\nexport const comments = mutation({ name: 'comments.create', access: 'public', handler: async () => ({}) })`)
    const modulePath = join(root, 'realtime-definitions.mjs')
    await writeFile(modulePath, moduleInternals.renderRealtimeDefinitionsModule(root))

    const { realtimeDefinitions } = await import(pathToFileURL(modulePath).href) as { realtimeDefinitions: readonly { readonly name: string }[] }
    expect(realtimeDefinitions.map(definition => definition.name)).toEqual(['comments.create', 'posts.list'])
  })

  it('resolves, loads, and transforms realtime definitions in client builds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-plugin-'))
    roots.push(root)
    const sourcePath = join(root, 'server/realtime/posts.ts')
    const source = `import { query } from '@holo-js/realtime'\nexport const posts = query({ name: 'posts.list' })`
    await mkdir(join(root, 'server/realtime'), { recursive: true })
    await writeFile(sourcePath, source)
    const plugin = moduleInternals.createRealtimeDefinitionVitePlugin(root) as {
      resolveId(source: string, importer?: string, options?: { ssr?: boolean }): string | null
      load(id: string): string | null
      transform(code: string, id: string, options?: { ssr?: boolean }): { code: string, map: { sourcesContent: string[] } } | null
    }

    expect(plugin.resolveId(sourcePath, undefined, { ssr: true })).toBeNull()
    const resolved = plugin.resolveId(sourcePath)
    expect(resolved).toContain(sourcePath)
    expect(plugin.resolveId('unrelated')).toBeNull()
    expect(plugin.load('unrelated')).toBeNull()
    expect(plugin.load(resolved!)).toContain('posts.list')
    expect(plugin.transform(source, sourcePath, { ssr: true })).toBeNull()
    expect(plugin.transform(source, join(root, 'server/models/Post.ts'))).toBeNull()
    expect(plugin.transform(source, sourcePath)).toMatchObject({ map: { sourcesContent: [source] } })

    const vite: { plugins?: unknown[] } = {}
    moduleInternals.addVitePlugin(vite, plugin)
    moduleInternals.addVitePlugin(vite, 'second')
    expect(vite.plugins).toEqual([plugin, 'second'])

    const opts = { nitro: { errorHandler: './existing' } }
    moduleInternals.addNitroErrorHandler(opts as never, './holo-error')
    moduleInternals.addNitroErrorHandler(opts as never, './holo-error')
    expect(opts.nitro.errorHandler).toEqual(['./existing', './holo-error'])
    const empty = { nitro: {} }
    moduleInternals.addNitroErrorHandler(empty as never, './holo-error')
    expect(empty.nitro).toMatchObject({ errorHandler: ['./holo-error'] })
  })
})
