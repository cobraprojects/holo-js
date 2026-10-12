import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { HoloProjectPrepareChange } from '@holo-js/kernel'
import { startDiscoveryWatch } from '../src/discovery-watch'
import { defaultProjectConfig } from '../src/project'

async function write(root: string, path: string, content = 'original'): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-discovery-watch-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
  await write(root, 'config/app.ts', 'export default {}')
  return root
}

it('observes real source edits and excludes generated artifacts, dependency files, and symlink escapes', async () => {
  const root = await createProject()
  const outside = await createProject()
  const included = ['config/app.ts', '.env.local', 'server/models/User.ts', 'server/jobs/send.ts', 'server/events/registered.ts', 'server/listeners/welcome.ts', 'server/policies/admin/PostPolicy.ts', 'server/abilities/reports/export.ts', 'server/broadcast/orders.ts', 'server/channels/orders.ts', '.holo-js/generated/schema.generated.ts']
  const excluded = ['.holo-js/generated/index.ts', 'node_modules/plugin/source.ts', '.next/server/app.js', 'README.md']
  for (const path of [...included, ...excluded]) await write(root, path)
  await write(outside, 'Outside.ts')
  await symlink(outside, join(root, 'server/models/escaped'), 'dir')
  const changes: HoloProjectPrepareChange[] = []
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: async change => { changes.push(typeof change === 'function' ? await change() : change) },
  })
  onTestFinished(() => watcher.close())
  for (const path of included) {
    await write(root, path, 'edited')
    await expect.poll(() => changes.some(change => change.path === path && change.kind === 'changed')).toBe(true)
  }
  for (const path of excluded) await write(root, path, 'excluded')
  await write(root, 'server/models/escaped/Outside.ts', 'escaped')
  await new Promise(resolve => setTimeout(resolve, 300))
  const unexpected = changes.filter(change => !included.includes(change.path))
  expect(unexpected, JSON.stringify(unexpected)).toEqual([])
  watcher.close()
  await new Promise(resolve => setTimeout(resolve, 100))
  const observed = changes.length
  await write(root, 'config/app.ts', 'after close')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(changes).toHaveLength(observed)
})

it('observes real file creation and deletion and switches to newly configured discovery roots', async () => {
  const root = await createProject()
  await write(root, 'server/models/User.ts')
  await write(root, 'src/models/nested/Existing.ts')
  const changes: HoloProjectPrepareChange[] = []
  const config = defaultProjectConfig()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config },
    observe: async change => { changes.push(typeof change === 'function' ? await change() : change) },
  })
  onTestFinished(() => watcher.close())
  await write(root, 'server/models/New.ts')
  await expect.poll(() => changes.some(change => change.path === 'server/models/New.ts' && change.kind === 'created')).toBe(true)
  await rm(join(root, 'server/models/User.ts'))
  await expect.poll(() => changes.some(change => change.path === 'server/models/User.ts' && change.kind === 'deleted')).toBe(true)
  await watcher.refresh({ config: { ...config, paths: { ...config.paths, models: 'src/models' } } })
  await write(root, 'src/models/nested/Existing.ts', 'updated')
  await expect.poll(() => changes.some(change => change.path === 'src/models/nested/Existing.ts' && change.kind === 'changed')).toBe(true)
  await write(root, 'src/models/new/nested/Added.ts')
  await expect.poll(() => changes.some(change => change.path === 'src/models/new/nested/Added.ts' && change.kind === 'created')).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 100))
  changes.length = 0
  await write(root, 'server/models/New.ts', 'obsolete')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(changes).toEqual([])
})
