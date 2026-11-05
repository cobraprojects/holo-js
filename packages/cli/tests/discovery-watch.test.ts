import { writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { EventEmitter, once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { HoloProjectPrepareChange } from '@holo-js/kernel'
import { DISCOVERY_WATCH_PROBE_PATH, startDiscoveryWatch } from '../src/discovery-watch'
import { defaultProjectConfig } from '../src/project'
import { writeTextFile } from '../src/project/atomic-file'
import { isUnchangedWrittenOutput, recordPackageManifestBaseline, startRecordingWrittenOutputs, trackOutputWrites, trackPackageManifestRestores, trackPackageManifestWrites, writeOutputFile } from '../src/written-outputs'
import type { ObservedPrepareChange } from '../src/framework-restart'

beforeEach(() => {
  onTestFinished(startRecordingWrittenOutputs())
})

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
  await vi.waitFor(() => expect(captured.changes).toHaveLength(3))
  expect(captured.changes).toEqual(expect.arrayContaining([
    { path: 'src/models', kind: 'changed' },
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
  await writeOutputFile(join(root, 'package.json'), written)
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([])
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([{ path: 'package.json', kind: 'changed' }])
})

it('observes a user restoring a dependency manifest to content the CLI wrote earlier', async () => {
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
  await writeOutputFile(join(root, 'package.json'), written)
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
  emit('package.json')
  await captured.settled()
  await write(root, 'package.json', written)
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([
    { path: 'package.json', kind: 'changed' },
    { path: 'package.json', kind: 'changed' },
  ])
})

it('waits for a running dependency install to record its writes before judging manifest events', async () => {
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
  await trackPackageManifestWrites(root, async () => {
    await write(root, 'package.json', '{"name":"watch-fixture","type":"module","dependencies":{}}')
    emit('package.json')
    await write(root, 'package-lock.json', '{}')
    emit('package-lock.json')
  })
  await captured.settled()
  expect(captured.changes).toEqual([])
})

it('ignores the staging files of atomic writes in watched roots', async () => {
  const root = await createProject()
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
    deferred: true,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string) => listeners.forEach(listener => listener('rename', path))
  emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  emit(`server/models/User.ts.holo-${process.pid}-${randomUUID()}.tmp`)
  watcher.resume()
  emit(`config/app.ts.holo-${process.pid}-${randomUUID()}.tmp`)
  emit(`server/models/User.ts.holo-${process.pid}-${randomUUID()}.backup`)
  await captured.settled()
  expect(captured.changes).toEqual([])
})

it('judges a manifest event that arrives while the CLI is writing it against the finished write', async () => {
  const root = await createProject()
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
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
  const writing = writeOutputFile(join(root, 'package.json'), '{"name":"watch-fixture","type":"module","private":true}')
  emit('package.json')
  await writing
  emit('package.json')
  await captured.settled()
  expect(captured.changes).toEqual([])
})

it('ignores events for source files the CLI wrote or removed while they still match what it left', async () => {
  const root = await createProject()
  await write(root, 'server/models/Stale.ts', 'stale')
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
    deferred: true,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string) => listeners.forEach(listener => listener('rename', path))
  emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  await trackOutputWrites([join(root, 'server/models/Managed.ts'), join(root, 'server/models/Stale.ts')], async () => {
    await write(root, 'server/models/Managed.ts', 'managed')
    emit('server/models/Managed.ts')
    await rm(join(root, 'server/models/Stale.ts'))
    emit('server/models/Stale.ts')
  })
  watcher.resume()
  emit('server/models/Managed.ts')
  await captured.settled()
  expect(captured.changes).toEqual([])
  await write(root, 'server/models/Managed.ts', 'edited')
  emit('server/models/Managed.ts')
  await captured.settled()
  expect(captured.changes).toEqual([{ path: 'server/models/Managed.ts', kind: 'changed' }])
})

it('judges written content against a write that starts while the check is reading', async () => {
  const root = await createProject()
  const manifest = join(root, 'package.json')
  await writeOutputFile(manifest, '{"name":"watch-fixture","type":"module","private":true}')
  const checked = isUnchangedWrittenOutput(manifest)
  const installed = trackPackageManifestWrites(root, async () => {
    await writeFile(manifest, '{"name":"watch-fixture","type":"module","dependencies":{}}')
  })
  await installed
  await expect(checked).resolves.toBe(true)
})

it('shares the written-output ledger between separately loaded copies of the CLI modules', async () => {
  const root = await createProject()
  const manifest = join(root, 'package.json')
  await writeOutputFile(manifest, '{"name":"watch-fixture","type":"module","private":true}')
  vi.resetModules()
  const copy = await import('../src/written-outputs')
  await expect(copy.isUnchangedWrittenOutput(manifest)).resolves.toBe(true)
})

it('ignores events for files and new directories the CLI writes through its atomic writer', async () => {
  const root = await createProject()
  const listeners: ((eventType: string, fileName: string) => void)[] = []
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
    deferred: true,
    createWatcher: ((_path: string, _options: unknown, listener: (eventType: string, fileName: string) => void) => {
      listeners.push(listener)
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string) => listeners.forEach(listener => listener('rename', path))
  emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  await writeTextFile(join(root, 'config/plugin/nested/settings.ts'), 'export default {}')
  emit('config/plugin')
  emit('config/plugin/nested')
  emit('config/plugin/nested/settings.ts')
  watcher.resume()
  await captured.settled()
  expect(captured.changes).toEqual([])
})

it('observes a user replacing a directory the CLI created', async () => {
  const root = await createProject()
  const directory = join(root, 'config/plugin')
  await writeTextFile(join(directory, 'settings.ts'), 'export default {}')
  await expect(isUnchangedWrittenOutput(directory)).resolves.toBe(true)
  await rm(directory, { recursive: true })
  await write(root, 'config/plugin/other.ts', 'export default { other: true }')
  await expect(isUnchangedWrittenOutput(directory)).resolves.toBe(false)
})

it('records a write through a symbolic link under the file it changes', async () => {
  const root = await createProject()
  await write(root, 'config/linked.ts', 'export default {}')
  await mkdir(join(root, 'app'), { recursive: true })
  await symlink(join(root, 'config/linked.ts'), join(root, 'app/alias.ts'))
  await writeTextFile(join(root, 'app/alias.ts'), 'export default { linked: true }')
  await expect(isUnchangedWrittenOutput(join(root, 'config/linked.ts'))).resolves.toBe(true)
})

it('keeps a user edit to a manifest that a tracked CLI command leaves untouched', async () => {
  const root = await createProject()
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module","private":true}')
  await trackPackageManifestWrites(root, async () => {})
  await expect(isUnchangedWrittenOutput(join(root, 'package.json'))).resolves.toBe(false)
})

it('treats a manifest a tracked command rewrites and restores as unchanged since the prepare started', async () => {
  const root = await createProject()
  const manifest = join(root, 'package.json')
  const original = '{"name":"watch-fixture","type":"module"}'
  await write(root, 'package.json', original)
  await recordPackageManifestBaseline(root)
  await trackPackageManifestWrites(root, async () => {
    await writeFile(manifest, '{"name":"watch-fixture","type":"module","overlay":true}')
    await writeFile(manifest, original)
  })
  await expect(isUnchangedWrittenOutput(manifest)).resolves.toBe(true)
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module","private":true}')
  await expect(isUnchangedWrittenOutput(manifest)).resolves.toBe(false)
})

it('observes a manifest the user changes and restores after the prepare took its baseline', async () => {
  const root = await createProject()
  const manifest = join(root, 'package.json')
  const original = '{"name":"watch-fixture","type":"module"}'
  await write(root, 'package.json', original)
  await recordPackageManifestBaseline(root)
  await writeFile(manifest, '{"name":"watch-fixture","type":"module","private":true}')
  await writeFile(manifest, original)
  await expect(isUnchangedWrittenOutput(manifest)).resolves.toBe(false)
})

it('keeps a user manifest edit made while a framework sync that restores manifests runs', async () => {
  const root = await createProject()
  const manifest = join(root, 'package.json')
  const original = '{"name":"watch-fixture","type":"module"}'
  await write(root, 'package.json', original)
  await recordPackageManifestBaseline(root)
  await trackPackageManifestRestores(root, async () => {
    await writeFile(manifest, '{"name":"watch-fixture","type":"module","private":true}')
  })
  await expect(isUnchangedWrittenOutput(manifest)).resolves.toBe(false)
  await recordPackageManifestBaseline(root)
  await trackPackageManifestRestores(root, async () => {
    await writeFile(manifest, '{"name":"watch-fixture","type":"module","overlay":true}')
    await writeFile(manifest, '{"name":"watch-fixture","type":"module","private":true}')
  })
  await expect(isUnchangedWrittenOutput(manifest)).resolves.toBe(true)
})

type DeferredWatchListener = (eventType: string, fileName: string) => void

async function installWatchPlugin(root: string): Promise<void> {
  await rm(join(root, 'config/app.ts'))
  await write(root, 'config/app.mjs', "export default {\n  plugins: ['demo-watch-plugin'],\n}\n")
  await write(root, 'node_modules/demo-watch-plugin/package.json', JSON.stringify({ name: 'demo-watch-plugin', version: '1.0.0', type: 'module', holo: { plugin: './plugin.mjs' } }))
  await write(root, 'node_modules/demo-watch-plugin/plugin.mjs', "export default { id: 'demo', name: 'Demo' }")
}

async function declarePluginWatchRoots(root: string, roots: readonly string[]): Promise<void> {
  await writeOutputFile(join(root, '.holo-js/generated/.plugins/demo.json'), JSON.stringify({ watch: { roots, excludes: [] } }))
}

async function startDeferredWatch(root: string, recursive: boolean) {
  const listeners = new Map<string, DeferredWatchListener[]>()
  const captured = captureChanges()
  const watcher = await startDiscoveryWatch({
    projectRoot: root,
    signal: new AbortController().signal,
    writeWarning: message => { throw new Error(message) },
    project: { config: defaultProjectConfig() },
    observe: captured.observe,
    deferred: true,
    createWatcher: ((path: string, options: { recursive: boolean }, listener: DeferredWatchListener) => {
      if (options.recursive && !recursive) {
        throw Object.assign(new Error('recursive watch unavailable'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
      }
      listeners.set(path, [...listeners.get(path) ?? [], listener])
      return { close() {} }
    }) as unknown as NonNullable<Parameters<typeof startDiscoveryWatch>[0]['createWatcher']>,
  })
  onTestFinished(() => watcher.close())
  const emit = (path: string, eventType = 'rename') => {
    for (const [directory, directoryListeners] of listeners) {
      const fileName = recursive ? path : relative(directory, join(root, path))
      if (!recursive && dirname(join(root, path)) !== directory) continue
      directoryListeners.forEach(listener => listener(eventType, fileName))
    }
  }
  if (recursive) emit(DISCOVERY_WATCH_PROBE_PATH)
  await watcher.ready
  return { ...captured, watcher, emit }
}

it('replays a file created during startup as created when the watch policy changes', async () => {
  const root = await createProject()
  await installWatchPlugin(root)
  await write(root, 'resources/demo/Existing.ts')
  const config = defaultProjectConfig()
  const { watcher, emit, changes, settled } = await startDeferredWatch(root, true)
  await write(root, 'server/models/New.ts')
  emit('server/models/New.ts')
  await write(root, 'resources/demo/Added.ts')
  emit('resources/demo/Added.ts')
  await declarePluginWatchRoots(root, ['resources/demo'])
  await watcher.refresh({ config })
  watcher.resume()
  await settled()
  expect(changes).toEqual(expect.arrayContaining([
    { path: 'resources/demo', kind: 'changed' },
    { path: 'server/models/New.ts', kind: 'created' },
    { path: 'resources/demo/Added.ts', kind: 'created' },
  ]))
  expect(changes).toHaveLength(3)
})

it('replays a startup edit to a file that existed before startup as changed when the watch policy changes', async () => {
  const root = await createProject()
  await installWatchPlugin(root)
  await write(root, 'server/models/User.ts')
  const config = defaultProjectConfig()
  const { watcher, emit, changes, settled } = await startDeferredWatch(root, true)
  await rm(join(root, 'server/models/User.ts'))
  await write(root, 'server/models/User.ts', 'replaced')
  emit('server/models/User.ts')
  await declarePluginWatchRoots(root, ['resources/demo'])
  await watcher.refresh({ config })
  watcher.resume()
  await settled()
  expect(changes).toEqual([{ path: 'resources/demo', kind: 'changed' }, { path: 'server/models/User.ts', kind: 'changed' }])
})

it('replays a startup edit to a file that existed before startup in a newly watched root as changed', async () => {
  const root = await createProject()
  await installWatchPlugin(root)
  await write(root, 'resources/demo/Existing.ts')
  const config = defaultProjectConfig()
  const { watcher, emit, changes, settled } = await startDeferredWatch(root, true)
  await write(root, 'resources/demo/Existing.ts', 'edited')
  emit('resources/demo/Existing.ts')
  await declarePluginWatchRoots(root, ['resources/demo'])
  await watcher.refresh({ config })
  watcher.resume()
  await settled()
  expect(changes).toEqual([{ path: 'resources/demo', kind: 'changed' }, { path: 'resources/demo/Existing.ts', kind: 'changed' }])
})

it('replays each watch root gained during startup as changed when only the non-recursive watcher is available', async () => {
  const root = await createProject()
  await installWatchPlugin(root)
  await write(root, 'resources/legacy/Removed.ts')
  const config = defaultProjectConfig()
  const { watcher, changes, settled } = await startDeferredWatch(root, false)
  await writeOutputFile(join(root, 'resources/demo/Generated.ts'), 'generated')
  await write(root, 'resources/demo/nested/Edited.ts')
  await rm(join(root, 'resources/legacy/Removed.ts'))
  await declarePluginWatchRoots(root, ['resources/demo', 'resources/legacy'])
  await watcher.refresh({ config })
  watcher.resume()
  await settled()
  expect(changes).toEqual(expect.arrayContaining([
    { path: 'resources/demo', kind: 'changed' },
    { path: 'resources/legacy', kind: 'changed' },
  ]))
  expect(changes).toHaveLength(2)
})

it('replays no change at resume when the watch policy kept its roots during startup', async () => {
  const root = await createProject()
  await installWatchPlugin(root)
  await declarePluginWatchRoots(root, ['resources/demo'])
  await write(root, 'resources/demo/Existing.ts')
  const config = defaultProjectConfig()
  const { watcher, changes, settled } = await startDeferredWatch(root, false)
  await declarePluginWatchRoots(root, ['resources/demo'])
  await writeOutputFile(join(root, 'resources/demo/Generated.ts'), 'generated')
  await watcher.refresh({ config })
  watcher.resume()
  await settled()
  expect(changes).toEqual([])
})
