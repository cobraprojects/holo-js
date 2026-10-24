import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build, type Plugin } from 'vite'

export const browserBuildSecret = 'sk_live_browser_build'

export async function createSecretRealtimeProject(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-realtime-browser-build-')))
  await mkdir(join(root, 'server/realtime'), { recursive: true })
  await writeFile(join(root, 'server/realtime/posts.ts'), [
    `import { query } from '@holo-js/realtime'`,
    `const SECRET = '${browserBuildSecret}'`,
    `export const posts = query({ name: 'posts.list', handler: async () => SECRET })`,
    '',
  ].join('\n'))
  await writeFile(join(root, 'client.ts'), [
    `import { posts } from './server/realtime/posts'`,
    `import { posts as aliased } from '#realtime/posts'`,
    `import { posts as resolved } from 'virtual:posts'`,
    'export default [posts, aliased, resolved]',
    '',
  ].join('\n'))
  return root
}

export async function buildBrowserBundleWithVite(root: string, plugin: unknown): Promise<string> {
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '#realtime': join(root, 'server/realtime') } },
    plugins: [plugin as Plugin, {
      name: 'resolve-virtual-posts',
      resolveId: source => source === 'virtual:posts' ? join(root, 'server/realtime/posts.ts') : null,
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
