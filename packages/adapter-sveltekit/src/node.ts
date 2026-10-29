import { lstatSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Adapter } from '@sveltejs/kit'

export default function adapter(options: { readonly out?: string } = {}): Adapter {
  const root = process.cwd()
  const outputPath = options.out ?? 'build'
  const out = resolve(outputPath)
  const localPath = relative(root, out)
  if (!outputPath.trim() || !localPath || localPath.startsWith(`..${sep}`) || localPath === '..' || isAbsolute(localPath)) {
    throw new Error('out must name a directory inside the project')
  }
  let directory = root
  for (const segment of localPath.split(sep)) {
    directory = join(directory, segment)
    const entry = lstatSync(directory, { throwIfNoEntry: false })
    if (!entry) break
    if (!entry.isDirectory()) {
      throw new Error('out must not contain files or symbolic links')
    }
  }
  return {
    name: '@holo-js/adapter-sveltekit/node',
    supports: { read: () => true },
    async adapt(builder) {
      const sources = [
        ...Object.values(builder.config.files).filter((source): source is string => typeof source === 'string'),
        builder.config.outDir, 'node_modules', '.git', '.holo-js', 'config', 'server',
      ]
      if (sources.some((source) => {
        const sourcePath = resolve(source)
        return sourcePath === out || sourcePath.startsWith(`${out}${sep}`) || out.startsWith(`${sourcePath}${sep}`)
      })) {
        throw new Error('out must not overlap source or framework directories')
      }
      const base = builder.config.paths.base
      await rm(out, { recursive: true, force: true })
      await Promise.all(['client', 'prerendered'].map(directory => mkdir(join(out, directory), { recursive: true })))
      builder.writeClient(join(out, 'client', base))
      builder.writePrerendered(join(out, 'prerendered', base))
      builder.generateServerInstance(join(builder.getServerDirectory(), 'server.js'))
      builder.writeServer(join(out, 'server'))
      await Promise.all(['client', 'prerendered'].map(directory => builder.compress(join(out, directory))))
      await writeFile(join(out, 'index.js'), [
        "import { server as application } from './server/server.js'",
        "import { startNodeServer } from '@holo-js/adapter-sveltekit/internal/node-server'",
        `export const server = await startNodeServer(application, { directory: new URL('.', import.meta.url), base: ${JSON.stringify(base)}, appPath: ${JSON.stringify(builder.getAppPath())}, canonicalOrigin: ${JSON.stringify(builder.config.paths.origin)}, prerenderedPaths: ${JSON.stringify(builder.prerendered.paths)} })`,
        '',
      ].join('\n'))
    },
  }
}
