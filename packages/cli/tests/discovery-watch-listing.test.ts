import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DISCOVERY_WATCH_PROBE_PATH, startDiscoveryWatch } from '../src/discovery-watch'
import { defaultProjectConfig } from '../src/project'

const listed = vi.hoisted(() => [] as string[])

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    readdir: ((path: Parameters<typeof original.readdir>[0], ...rest: unknown[]) => {
      listed.push(String(path))
      return (original.readdir as (...args: unknown[]) => unknown)(path, ...rest)
    }) as typeof original.readdir,
  }
})

async function write(root: string, path: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), 'original')
}

it('lists only the folders the discovery policy can watch when holo dev starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'holo-discovery-listing-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await write(root, 'package.json')
  await write(root, 'config/app.ts')
  await write(root, 'server/models/User.ts')
  for (let index = 0; index < 20; index++) await write(root, `storage/app/uploads/${index}/file.txt`)
  await write(root, 'public/uploads/image.png')
  listed.length = 0
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: () => {},
    deferred: true,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  listeners.forEach(listener => listener('rename', DISCOVERY_WATCH_PROBE_PATH))
  await watcher.ready
  const outsidePolicy = listed.filter(path => [join(root, 'storage'), join(root, 'public')].some(excluded => path === excluded || path.startsWith(`${excluded}${sep}`)))
  expect(outsidePolicy).toEqual([])
  expect(listed).toContain(join(root, 'server/models'))
})
