import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type Plugin } from 'vite'

export const browserBuildSecret = 'sk_live_browser_build'

export type RealtimeProjectLayout = 'plain' | 'symlinked-root' | 'symlinked-realtime-directory'

export const symlinkedFileError = 'server/realtime/linked.ts is a symbolic link; Holo can\'t guarantee its server code stays out of the browser bundle. Replace it with a regular file.'

export async function useFactoryNamedExports(root: string): Promise<void> {
  await writeFile(join(root, 'server/realtime/posts.ts'), [
    `import realtime from '@holo-js/realtime'`,
    `const SECRET = '${browserBuildSecret}'`,
    `export const query = realtime.query({ name: 'posts.list', handler: async () => SECRET })`,
    `export const mutation = realtime.mutation({ name: 'posts.rename', handler: async () => SECRET })`,
    '',
  ].join('\n'))
  await writeFile(join(root, 'client.ts'), [
    `import { query as posts, mutation } from './server/realtime/posts'`,
    `import { query as aliased } from '#realtime/posts'`,
    `import { query as resolved } from 'virtual:posts'`,
    'export default [posts, mutation, aliased, resolved]',
    '',
  ].join('\n'))
}

export async function addSymlinkedRealtimeFile(root: string): Promise<void> {
  const target = join(root, '..', 'linked-target.ts')
  await writeFile(target, `export const linked = 'server only'\n`)
  await symlink(target, join(root, 'server/realtime/linked.ts'))
}

export const realtimeProjectLayouts: readonly RealtimeProjectLayout[] = ['plain', 'symlinked-root', 'symlinked-realtime-directory']

export type SecretRealtimeProject = {
  readonly root: string
  readonly cleanup: () => Promise<void>
}

export async function createSecretRealtimeProject(layout: RealtimeProjectLayout = 'plain'): Promise<SecretRealtimeProject> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'holo-realtime-browser-build-')))
  const projectDirectory = join(workspace, 'project')
  const realtimeDirectory = layout === 'symlinked-realtime-directory'
    ? join(workspace, 'shared-realtime')
    : join(projectDirectory, 'server/realtime')
  await mkdir(join(projectDirectory, 'server'), { recursive: true })
  await mkdir(realtimeDirectory, { recursive: true })
  if (layout === 'symlinked-realtime-directory') {
    await symlink(realtimeDirectory, join(projectDirectory, 'server/realtime'), 'dir')
    await writeFile(join(workspace, 'package-lock.json'), '{}')
  }
  const root = layout === 'symlinked-root' ? join(workspace, 'linked-project') : projectDirectory
  if (layout === 'symlinked-root') {
    await symlink(projectDirectory, root, 'dir')
  }
  await writeFile(join(realtimeDirectory, 'posts.ts'), [
    `import { query } from '@holo-js/realtime'`,
    `const SECRET = '${browserBuildSecret}'`,
    `export const posts = query({ name: 'posts.list', handler: async () => SECRET })`,
    '',
  ].join('\n'))
  await writeFile(join(projectDirectory, 'client.ts'), [
    `import { posts } from './server/realtime/posts'`,
    `import { posts as aliased } from '#realtime/posts'`,
    `import { posts as resolved } from 'virtual:posts'`,
    'export default [posts, aliased, resolved]',
    '',
  ].join('\n'))
  return { root, cleanup: () => rm(workspace, { recursive: true, force: true }) }
}

export async function buildBrowserBundleWithVite(root: string, plugin: unknown): Promise<string> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '#realtime': join(root, 'server/realtime') } },
    plugins: [plugin as Plugin, {
      name: 'resolve-virtual-posts',
      resolveId: source => source === 'virtual:posts' ? realpathSync(join(root, 'server/realtime/posts.ts')) : null,
    }],
    build: {
      write: false,
      sourcemap: true,
      minify: false,
      lib: { entry: join(root, 'client.ts'), formats: ['es'], fileName: 'client' },
      rollupOptions: { external: id => id.startsWith('@holo-js/') },
    },
  })
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(entry => 'output' in entry ? entry.output : [])
  return outputs.map(output => output.type === 'chunk'
    ? `${output.code}\n${JSON.stringify(output.map)}`
    : String(output.source)).join('\n')
}
