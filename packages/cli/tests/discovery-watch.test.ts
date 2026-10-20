import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter, once } from 'node:events'
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

function captureChanges() {
  const changes: HoloProjectPrepareChange[] = []
  const events = new EventEmitter()
  return {
    changes,
    async observe(change: HoloProjectPrepareChange | (() => Promise<HoloProjectPrepareChange>)): Promise<void> {
      const observed = typeof change === 'function' ? await change() : change
      changes.push(observed)
      events.emit(`${observed.path}:${observed.kind}`)
    },
    async waitForChange(path: string, kind: HoloProjectPrepareChange['kind']): Promise<void> {
      await once(events, `${path}:${kind}`)
    },
  }
}

it('observes real source edits and excludes generated artifacts, dependency files, and symlink escapes', async () => {
  const root = await createProject()
  const outside = await createProject()
  const included = ['config/app.ts', '.env.local', 'server/models/User.ts', 'server/jobs/send.ts', 'server/events/registered.ts', 'server/listeners/welcome.ts', 'server/policies/admin/PostPolicy.ts', 'server/abilities/reports/export.ts', 'server/broadcast/orders.ts', 'server/channels/orders.ts', '.holo-js/generated/schema.generated.ts']
  const excluded = ['.holo-js/generated/index.ts', 'node_modules/plugin/source.ts', '.next/server/app.js', 'README.md']
  for (const path of [...included, ...excluded]) await write(root, path)
  await write(outside, 'Outside.ts')
  await symlink(outside, join(root, 'server/models/escaped'), 'dir')
  const { changes, observe, waitForChange } = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe,
  })
  onTestFinished(() => watcher.close())
  for (const path of included) {
    const changed = waitForChange(path, 'changed')
    await write(root, path, 'edited')
    await changed
  }
  for (const path of excluded) await write(root, path, 'excluded')
  await write(root, 'server/models/escaped/Outside.ts', 'escaped')
  const barrier = waitForChange('server/models/Barrier.ts', 'created')
  await write(root, 'server/models/Barrier.ts')
  await barrier
  const unexpected = changes.filter(change => ![...included, 'server/models/Barrier.ts'].includes(change.path))
  expect(unexpected, JSON.stringify(unexpected)).toEqual([])
  watcher.close()
  const observed = changes.length
  await write(root, 'config/app.ts', 'after close')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(changes).toHaveLength(observed)
})

it('observes real file creation and deletion and switches to newly configured discovery roots', async () => {
  const root = await createProject()
  await write(root, 'server/models/User.ts')
  await write(root, 'src/models/nested/Existing.ts')
  const { changes, observe, waitForChange } = captureChanges()
  const config = defaultProjectConfig()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config },
    observe,
  })
  onTestFinished(() => watcher.close())
  const created = waitForChange('server/models/New.ts', 'created')
  await write(root, 'server/models/New.ts')
  await created
  const deleted = waitForChange('server/models/User.ts', 'deleted')
  await rm(join(root, 'server/models/User.ts'))
  await deleted
  await watcher.refresh({ config: { ...config, paths: { ...config.paths, models: 'src/models' } } })
  const changed = waitForChange('src/models/nested/Existing.ts', 'changed')
  await write(root, 'src/models/nested/Existing.ts', 'updated')
  await changed
  const nestedCreated = waitForChange('src/models/new/nested/Added.ts', 'created')
  await write(root, 'src/models/new/nested/Added.ts')
  await nestedCreated
  const observedBefore = changes.length
  const barrier = waitForChange('src/models/new/nested/Barrier.ts', 'created')
  await write(root, 'server/models/New.ts', 'obsolete')
  await write(root, 'src/models/new/nested/Barrier.ts')
  await barrier
  expect(changes.slice(observedBefore).map(change => change.path)).toEqual(['src/models/new/nested/Barrier.ts'])
})
