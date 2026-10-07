import type { WatchListener, watch } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { HoloProjectPrepareChange } from '@holo-js/kernel'
import { startDiscoveryWatch } from '../src/discovery-watch'
import { defaultProjectConfig } from '../src/project'
import type { LoadedProjectConfig } from '../src/types'

const temporaryRoots: string[] = []

async function write(root: string, path: string, content = ''): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), content)
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-discovery-watch-'))
  temporaryRoots.push(root)
  await write(root, 'package.json', '{"name":"watch-fixture","type":"module"}')
  await write(root, 'config/app.ts', 'export default {}')
  return root
}

function watchHarness(recursive: boolean) {
  const handles: { root: string, callback: WatchListener<string>, closes: number }[] = []
  const changes: HoloProjectPrepareChange[] = []
  const warnings: string[] = []
  const controller = new AbortController()
  let classification = Promise.resolve()
  const createWatcher = ((root: string, options: { recursive?: boolean }, callback: WatchListener<string>) => {
    if (options.recursive && !recursive) {
      throw Object.assign(new Error('unsupported'), { code: 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' })
    }
    const handle = { root, callback, closes: 0 }
    handles.push(handle)
    return { close() { handle.closes++ } }
  }) as unknown as typeof watch
  return {
    handles,
    changes,
    warnings,
    controller,
    options: {
      createWatcher,
      signal: controller.signal,
      writeWarning: (message: string) => { warnings.push(message) },
      observe(change: HoloProjectPrepareChange | (() => Promise<HoloProjectPrepareChange>)) {
        if (typeof change !== 'function') changes.push(change)
        else classification = classification.then(async () => { changes.push(await change()) })
      },
    },
    async emit(root: string, path: string, kind: 'change' | 'rename' = 'change') {
      const handle = handles.find(handle => handle.root === root && handle.closes === 0)
      if (!handle) throw new Error(`No active watch for ${root}`)
      handle.callback(kind, path)
      await classification
    },
  }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each([true, false])('observes discovery paths and excludes generated and escaped paths with recursive=%s', async (recursive) => {
  const projectRoot = await createProject()
  const project = {
    config: {
      ...defaultProjectConfig(),
      paths: {
        ...defaultProjectConfig().paths,
        authorizationPolicies: '',
        authorizationAbilities: '',
        broadcast: 'src/broadcast',
        channels: 'src/channels',
      },
    },
  }
  const included = [
    'config/app.ts', '.env.local', 'package.json', 'bun.lock', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
    'server/commands/hello.ts', 'server/jobs/send.ts', 'server/events/registered.ts', 'server/listeners/welcome.ts',
    'server/policies/admin/PostPolicy.ts', 'server/abilities/reports/export.ts', 'server/models/User.ts',
    'server/db/migrations/users.ts', 'server/db/seeders/UserSeeder.ts', 'server/realtime/socket.ts',
    'src/broadcast/orders/created.ts', 'src/channels/orders/private.ts', '.holo-js/generated/schema.generated.ts',
  ]
  await Promise.all(included.map(path => write(projectRoot, path)))
  const harness = watchHarness(recursive)
  const discoveryWatch = await startDiscoveryWatch({ projectRoot, project, ...harness.options })
  try {
    for (const path of included) {
      const root = recursive ? projectRoot : dirname(join(projectRoot, path))
      await harness.emit(root, recursive ? path : path.slice(path.lastIndexOf('/') + 1))
    }
    for (const path of ['.holo-js/generated/index.ts', 'node_modules/plugin/source.ts', '.next/server/app.js', 'README.md', '../config/app.ts', '/outside/config/app.ts', 'server/broadcast/orders.ts', 'server/channels/orders.ts']) {
      await harness.emit(projectRoot, path)
    }
    expect(harness.changes).toEqual(included.map(path => ({ path, kind: 'changed' })))
  } finally {
    discoveryWatch.close()
  }
  expect(harness.handles.every(handle => handle.closes === 1)).toBe(true)
  harness.handles[0]?.callback('change', 'config/app.ts')
  expect(harness.changes).toHaveLength(included.length)
})

it.each([true, false])('classifies saves, creation, deletion, and refreshed roots with recursive=%s', async (recursive) => {
  const projectRoot = await createProject()
  await write(projectRoot, 'server/models/User.ts', 'original')
  const project = { config: defaultProjectConfig() }
  const harness = watchHarness(recursive)
  const discoveryWatch = await startDiscoveryWatch({ projectRoot, project, ...harness.options })
  const emit = (path: string) => harness.emit(recursive ? projectRoot : dirname(join(projectRoot, path)), recursive ? path : path.slice(path.lastIndexOf('/') + 1), 'rename')
  try {
    await write(projectRoot, 'server/models/User.ts', 'saved')
    await emit('server/models/User.ts')
    await write(projectRoot, 'server/models/New.ts', 'created')
    await emit('server/models/New.ts')
    await rm(join(projectRoot, 'server/models/User.ts'))
    await emit('server/models/User.ts')
    await write(projectRoot, 'src/models/nested/Existing.ts', 'existing')
    const previousHandles = [...harness.handles]
    const refreshed = { config: { ...project.config, paths: { ...project.config.paths, models: 'src/models' } } }
    await discoveryWatch.refresh(refreshed)
    await emit('src/models/nested/Existing.ts')
    if (!recursive) {
      expect(previousHandles.every(handle => handle.closes === 1)).toBe(true)
      previousHandles[0]?.callback('change', 'config/app.ts')
      await write(projectRoot, 'src/models/new/nested/Added.ts', 'added')
      await discoveryWatch.refresh(refreshed)
      await emit('src/models/new/nested/Added.ts')
    }
    expect(harness.changes).toEqual([
      { path: 'server/models/User.ts', kind: 'changed' },
      { path: 'server/models/New.ts', kind: 'created' },
      { path: 'server/models/User.ts', kind: 'deleted' },
      { path: 'src/models/nested/Existing.ts', kind: 'changed' },
      ...(!recursive ? [{ path: 'src/models/new/nested/Added.ts', kind: 'created' }] : []),
    ])
    harness.controller.abort()
    discoveryWatch.close()
    expect(harness.handles.every(handle => handle.closes === 1)).toBe(true)
  } finally {
    discoveryWatch.close()
  }
})

it.each([true, false])('refreshes active plugin watch policy and protects core roots and plugin packages with recursive=%s', async (recursive) => {
  const projectRoot = await createProject()
  await write(projectRoot, 'config/app.ts', "export default { plugins: ['holo-plugin-demo'] }")
  await write(projectRoot, 'package.json', JSON.stringify({ name: 'watch-fixture', type: 'module', dependencies: { 'holo-plugin-demo': 'file:plugins/demo' } }))
  await write(projectRoot, 'plugins/demo/package.json', JSON.stringify({ name: 'holo-plugin-demo', type: 'module', holo: { plugin: './plugin.mjs' } }))
  await write(projectRoot, 'plugins/demo/plugin.mjs', "export default { id: 'demo', contributes: { project: { prepare: './prepare.mjs' } } }")
  await mkdir(join(projectRoot, 'node_modules'))
  await symlink(join(projectRoot, 'plugins/demo'), join(projectRoot, 'node_modules/holo-plugin-demo'))
  const manifestPath = '.holo-js/generated/.plugins/demo.json'
  await write(projectRoot, manifestPath, JSON.stringify({ watch: { roots: ['.'], excludes: ['extensions/cache', 'server/models'] } }))
  await write(projectRoot, '.holo-js/generated/.plugins/inactive.json', JSON.stringify({ watch: { roots: ['.'], excludes: [] } }))
  await write(projectRoot, '.holo-js/generated/.plugins/invalid.json', '{')
  for (const path of ['extensions/source/nested/widget.ts', 'extensions/cache/nested/widget.ts', 'server/models/nested/User.ts', 'extensions/replacement/widget.ts']) await write(projectRoot, path)
  const project = { config: defaultProjectConfig() }
  const harness = watchHarness(recursive)
  const discoveryWatch = await startDiscoveryWatch({ projectRoot, project, ...harness.options })
  try {
    await harness.emit(projectRoot, 'extensions/source/nested/widget.ts')
    await harness.emit(projectRoot, 'extensions/cache/nested/widget.ts')
    await harness.emit(projectRoot, 'server/models/nested/User.ts')
    await harness.emit(projectRoot, 'plugins/demo/plugin.mjs')
    await harness.emit(projectRoot, 'node_modules/holo-plugin-demo/plugin.mjs')
    await harness.emit(projectRoot, '.holo-js/generated/demo/registry.ts')
    if (!recursive) {
      expect(harness.handles.map(handle => handle.root)).toContain(join(projectRoot, 'extensions/source/nested'))
      expect(harness.handles.map(handle => handle.root)).not.toContain(join(projectRoot, 'extensions/cache/nested'))
      expect(harness.handles.map(handle => handle.root)).not.toContain(join(projectRoot, 'plugins/demo'))
    }
    await discoveryWatch.refresh(project)
    expect(harness.warnings).toHaveLength(1)
    await write(projectRoot, manifestPath, JSON.stringify({ watch: { roots: ['extensions/replacement'], excludes: [] } }))
    await discoveryWatch.refresh(project)
    await harness.emit(projectRoot, 'extensions/source/nested/widget.ts')
    await harness.emit(projectRoot, 'extensions/replacement/widget.ts')
    expect(harness.changes).toEqual([
      { path: 'extensions/source/nested/widget.ts', kind: 'changed' },
      { path: 'server/models/nested/User.ts', kind: 'changed' },
      { path: 'extensions/replacement/widget.ts', kind: 'changed' },
    ])
    if (!recursive) expect(harness.handles.filter(handle => !handle.closes).map(handle => handle.root)).not.toContain(join(projectRoot, 'extensions/source/nested'))
    for (const declaration of [
      { roots: ['../outside'], excludes: [] },
      { roots: ['extensions/replacement'], excludes: ['secrets'] },
      { roots: [42], excludes: [] },
    ]) {
      await write(projectRoot, manifestPath, JSON.stringify({ watch: declaration }))
      await discoveryWatch.refresh(project)
      await harness.emit(projectRoot, 'extensions/replacement/widget.ts')
      expect(harness.changes).toHaveLength(3)
    }
  } finally {
    discoveryWatch.close()
  }
})
