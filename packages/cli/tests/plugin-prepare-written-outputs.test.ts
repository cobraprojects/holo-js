import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHoloProjectConfig, type HoloProjectPreparer } from '@holo-js/kernel'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { LoadedProjectPreparer } from '../src/project/plugins'
import type * as WrittenOutputs from '../src/written-outputs'
import { installPreparers } from './support/native-preparers'

const tracked = vi.hoisted(() => [] as string[])

vi.mock('../src/written-outputs', async (importOriginal) => {
  const original = await importOriginal<typeof WrittenOutputs>()
  return {
    ...original,
    trackOutputWrites: (paths: readonly string[], write: () => Promise<unknown>) => {
      tracked.push(...paths)
      return original.trackOutputWrites(paths, write)
    },
    trackOutputWrite: (path: string, contents: string | Uint8Array, write: () => Promise<unknown>) => {
      tracked.push(path)
      return original.trackOutputWrite(path, contents, write)
    },
  }
})

const { runPluginProjectPreparers } = await import('../src/project/plugin-prepare/coordinator')

function loadedPreparer(root: string, preparer: HoloProjectPreparer): LoadedProjectPreparer {
  return {
    plugin: {
      packageName: 'holo-demo',
      packageRoot: join(root, 'node_modules', 'holo-demo'),
      entryPath: join(root, 'node_modules', 'holo-demo', 'plugin.mjs'),
      definition: { id: 'demo', name: 'Plugin demo', contributes: { project: { prepare: './prepare.mjs' } } },
    },
    specifier: './prepare.mjs',
    preparer,
  }
}

it('tracks only the managed artifacts a preparation run actually changes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-plugin-written-outputs-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  let version = 1
  await installPreparers(root, [loadedPreparer(root, {
    apiVersion: 1,
    prepare: () => ({
      kind: 'prepared',
      generatedArtifacts: [],
      managedArtifacts: [
        { path: 'app/stable.ts', contents: 'stable' },
        { path: 'app/changing.ts', contents: `v${version}` },
      ],
    }),
  })])
  const options = { run: { kind: 'full', command: 'prepare', reason: 'explicit' } } as const
  await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
  version = 2
  tracked.length = 0
  await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
  expect(await readFile(join(root, 'app/changing.ts'), 'utf8')).toBe('v2')
  expect(tracked).toContain(join(root, 'app/changing.ts'))
  expect(tracked).not.toContain(join(root, 'app/stable.ts'))
})

it('reports whether a preparation run changed managed artifacts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-plugin-managed-changes-')))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  let managed = 'v1'
  let generated = 'g1'
  await installPreparers(root, [loadedPreparer(root, {
    apiVersion: 1,
    prepare: () => ({
      kind: 'prepared',
      generatedArtifacts: [{ path: 'registry.json', contents: generated }],
      managedArtifacts: managed ? [{ path: 'server/models/Generated.ts', contents: managed }] : [],
    }),
  })])
  const options = { run: { kind: 'full', command: 'prepare', reason: 'explicit' } } as const
  await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)).resolves.toBe(true)
  await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)).resolves.toBe(false)
  generated = 'g2'
  await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)).resolves.toBe(false)
  managed = ''
  await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)).resolves.toBe(true)
})
