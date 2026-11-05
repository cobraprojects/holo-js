import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { HoloProjectPrepareChange } from '@holo-js/kernel'
import { DISCOVERY_WATCH_PROBE_PATH, startDiscoveryWatch } from '../src/discovery-watch'
import { defaultProjectConfig } from '../src/project'
import { recordWrittenOutput } from '../src/written-outputs'
import type { ObservedPrepareChange } from '../src/framework-restart'

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

async function startCapturedWatch(root: string, config = defaultProjectConfig()) {
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config },
    observe: captured.observe,
  })
  onTestFinished(() => watcher.close())
  await vi.waitFor(async () => {
    await write(root, 'config/app.ts', randomUUID())
    expect(captured.changes.map(change => change.path)).toContain('config/app.ts')
  }, { interval: 50, timeout: 3_000 })
  return { ...captured, watcher }
}

async function editAndObserve(root: string, path: string, waitForChange: (path: string, kind: 'changed') => Promise<void>): Promise<void> {
  const changed = waitForChange(path, 'changed')
  await write(root, path, randomUUID())
  await changed
}

function captureChanges() {
  const changes: HoloProjectPrepareChange[] = []
  const pending: Promise<void>[] = []
  const events = new EventEmitter()
  const record = async (change: ObservedPrepareChange): Promise<void> => {
    const observed = typeof change === 'function' ? await change() : change
    for (const item of Array.isArray(observed) ? observed : [observed]) {
      changes.push(item)
      events.emit(`${item.path}:${item.kind}`)
    }
  }
  return {
    changes,
    observe(change: ObservedPrepareChange): void {
      pending.push(record(change))
    },
    async settled(): Promise<void> {
      await Promise.all(pending)
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
  const { changes, waitForChange, watcher } = await startCapturedWatch(root)
  for (const path of included) await editAndObserve(root, path, waitForChange)
  for (const path of excluded) await write(root, path, 'excluded')
  await write(root, 'server/models/escaped/Outside.ts', 'escaped')
  await editAndObserve(root, 'config/app.ts', waitForChange)
  const unexpected = changes.filter(change => !included.includes(change.path))
  expect(unexpected, JSON.stringify(unexpected)).toEqual([])
  const observedBeforeClose = changes.length
  watcher.close()
  const witness = await startCapturedWatch(root)
  await editAndObserve(root, 'server/jobs/send.ts', witness.waitForChange)
  await editAndObserve(root, 'config/app.ts', witness.waitForChange)
  expect(changes.slice(observedBeforeClose).map(change => change.path)).not.toContain('server/jobs/send.ts')
})

it('observes real file creation and deletion and switches to newly configured discovery roots', async () => {
  const root = await createProject()
  await write(root, 'server/models/User.ts')
  await write(root, 'src/models/nested/Existing.ts')
  const config = defaultProjectConfig()
  const { changes, waitForChange, watcher } = await startCapturedWatch(root, config)
  const created = waitForChange('server/models/New.ts', 'created')
  await write(root, 'server/models/New.ts')
  await created
  const deleted = waitForChange('server/models/User.ts', 'deleted')
  await rm(join(root, 'server/models/User.ts'))
  await deleted
  await watcher.refresh({ config: { ...config, paths: { ...config.paths, models: 'src/models' } } })
  const observedAfterRefresh = changes.length
  const changed = waitForChange('src/models/nested/Existing.ts', 'changed')
  await write(root, 'src/models/nested/Existing.ts', 'updated')
  await changed
  const nestedCreated = waitForChange('src/models/new/nested/Added.ts', 'created')
  await write(root, 'src/models/new/nested/Added.ts')
  await nestedCreated
  await write(root, 'server/models/New.ts', 'obsolete')
  await editAndObserve(root, 'config/app.ts', waitForChange)
  expect(changes.slice(observedAfterRefresh).map(change => change.path)).not.toContain('server/models/New.ts')
})

it('observes an edit made immediately after the watcher reports it is ready and removes its liveness probe', async () => {
  const root = await createProject()
  await write(root, 'server/models/User.ts')
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
  })
  onTestFinished(() => watcher.close())
  await watcher.ready
  const changed = captured.waitForChange('server/models/User.ts', 'changed')
  writeFileSync(join(root, 'server/models/User.ts'), randomUUID())
  await changed
  await expect(stat(join(root, DISCOVERY_WATCH_PROBE_PATH))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('defers observed edits until it is resumed and judges them by the policy in effect then', async () => {
  const root = await createProject()
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const config = defaultProjectConfig()
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config },
    observe: captured.observe,
    deferred: true,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string) => listeners.forEach(listener => listener('change', path))
  emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  emit('src/models/User.ts')
  emit('src/models/User.ts')
  emit('README.md')
  await watcher.refresh({ config: { ...config, paths: { ...config.paths, models: 'src/models' } } })
  expect(captured.changes).toEqual([])
  watcher.resume()
  emit('config/app.ts')
  await vi.waitFor(() => expect(captured.changes).toHaveLength(2))
  expect(captured.changes).toEqual(expect.arrayContaining([
    { path: 'src/models/User.ts', kind: 'changed' },
    { path: 'config/app.ts', kind: 'changed' },
  ]))
})

it('ignores events for a dependency manifest that still holds the content the CLI wrote', async () => {
  const root = await createProject()
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string) => listeners.forEach(listener => listener('change', path))
  emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  const written = '{"name":"watch-fixture","type":"module","private":true}'
  await write(root, 'package.json', written)
  recordWrittenOutput(join(root, 'package.json'), written)
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([])
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([{ path: 'package.json', kind: 'changed' }])
})
