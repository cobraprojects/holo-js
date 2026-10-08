import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { renderSvelteViteConfig } from '../src/project/scaffold/framework-renderers'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('SvelteKit scaffold workspace assets', () => {
  it('serves workspace and generated assets while denying files outside the workspace', async () => {
    const workspace = await realpath(await mkdtemp(join(tmpdir(), 'holo-svelte-workspace-')))
    const privateDirectory = await realpath(await mkdtemp(join(tmpdir(), 'holo-svelte-private-')))
    directories.push(workspace, privateDirectory)
    const project = join(workspace, 'apps/web')
    const font = join(workspace, 'packages/theme/font.woff2')
    const generated = join(project, '.holo-js/generated/panels/theme.css')
    const privateFile = join(privateDirectory, 'private.woff2')
    await Promise.all([dirname(font), dirname(generated), join(project, 'src/routes')].map(directory => mkdir(directory, { recursive: true })))
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*', 'packages/*'] }))
    await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'scaffold-asset-test', private: true, type: 'module' }))
    await symlink(resolve(import.meta.dirname, '../node_modules'), join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(project, 'vite.config.ts'), renderSvelteViteConfig(false))
    await writeFile(join(project, 'svelte.config.js'), 'export default { kit: {} }')
    await writeFile(join(project, 'src/routes/+page.svelte'), '<h1>Workspace assets</h1>')
    await writeFile(font, 'workspace font asset')
    await writeFile(generated, ':root { color: red }')
    await writeFile(privateFile, 'private asset')
    const originalDirectory = process.cwd()
    process.chdir(project)
    try {
      const server = await createServer({
        root: project,
        configFile: join(project, 'vite.config.ts'),
        logLevel: 'silent',
        server: { host: '127.0.0.1' },
      })
      try {
        await server.listen()
        const address = server.httpServer?.address()
        if (!address || typeof address === 'string') throw new Error('Missing Vite server address')
        const request = (file: string): Promise<Response> => fetch(`http://127.0.0.1:${address.port}/@fs/${file.replaceAll('\\', '/').replace(/^\/+/, '')}`)
        const asset = await request(font)
        expect(asset.status).toBe(200)
        expect(await asset.text()).toBe('workspace font asset')
        expect((await request(generated)).status).toBe(200)
        expect((await request(privateFile)).status).toBe(403)
      } finally {
        await server.close()
      }
    } finally {
      process.chdir(originalDirectory)
    }
  }, 30_000)
})
