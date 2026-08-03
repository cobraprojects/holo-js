import { mkdir, mkdtemp, readFile, type rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHoloProjectConfig, type HoloProjectPreparer } from '@holo-js/kernel'
import { afterEach, describe, expect, it, vi } from 'vitest'

const staleReplacement = vi.hoisted(() => ({
  enabled: false,
  firstReclaimWaiting: false,
  lockPath: undefined as string | undefined,
  replacementAcquired: false,
  secondReclaimWaiting: false,
  staleMoved: false,
}))

type FileSystem = Record<string, unknown> & {
  mkdir: typeof mkdir
  rename: typeof rename
}

vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<FileSystem>()
  return {
    ...filesystem,
    async mkdir(path: Parameters<typeof filesystem.mkdir>[0], options?: Parameters<typeof filesystem.mkdir>[1]) {
      const result = await filesystem.mkdir(path, options)
      if (staleReplacement.enabled && String(path) === staleReplacement.lockPath && staleReplacement.staleMoved) {
        staleReplacement.replacementAcquired = true
      }
      return result
    },
    async rename(oldPath: Parameters<typeof filesystem.rename>[0], newPath: Parameters<typeof filesystem.rename>[1]) {
      if (
        staleReplacement.enabled
        && String(oldPath) === staleReplacement.lockPath
        && String(newPath).endsWith('.abandoned')
      ) {
        if (!staleReplacement.firstReclaimWaiting) {
          staleReplacement.firstReclaimWaiting = true
          while (!staleReplacement.secondReclaimWaiting) await new Promise(resolve => setTimeout(resolve, 0))
          await filesystem.rename(oldPath, newPath)
          staleReplacement.staleMoved = true
          return
        }

        staleReplacement.secondReclaimWaiting = true
        while (!staleReplacement.staleMoved || !staleReplacement.replacementAcquired) {
          await new Promise(resolve => setTimeout(resolve, 0))
        }
      }
      return filesystem.rename(oldPath, newPath)
    },
  }
})

vi.mock('../src/project/plugins', () => ({
  loadProjectPluginPreparation: vi.fn(),
}))

import { type LoadedProjectPreparer, loadProjectPluginPreparation } from '../src/project/plugins'
import { runPluginProjectPreparers } from '../src/project/plugin-prepare/coordinator'

const temporaryDirectories: string[] = []
const mockedLoadPreparation = vi.mocked(loadProjectPluginPreparation)

function loadedPreparer(root: string, preparer: HoloProjectPreparer): LoadedProjectPreparer {
  return {
    plugin: {
      packageName: 'holo-lock-test',
      packageRoot: join(root, 'node_modules/holo-lock-test'),
      entryPath: join(root, 'node_modules/holo-lock-test/plugin.mjs'),
      definition: {
        id: 'lock-test',
        contributes: { project: { prepare: './prepare.mjs' } },
      },
    },
    specifier: './prepare.mjs',
    preparer,
  }
}

afterEach(async () => {
  staleReplacement.enabled = false
  staleReplacement.firstReclaimWaiting = false
  staleReplacement.lockPath = undefined
  staleReplacement.replacementAcquired = false
  staleReplacement.secondReclaimWaiting = false
  staleReplacement.staleMoved = false
  mockedLoadPreparation.mockReset()
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('plugin project preparation locking', () => {
  it('does not reclaim a stale lock owned by a live local preparer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-live-owner-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    let activePreparers = 0
    let maximumActivePreparers = 0
    let releaseFirst: () => void = () => undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let calls = 0
    const preparer = loadedPreparer(root, {
      apiVersion: 1,
      async prepare() {
        calls += 1
        activePreparers += 1
        maximumActivePreparers = Math.max(maximumActivePreparers, activePreparers)
        if (calls === 1) {
          firstEntered()
          await firstBlocked
        }
        activePreparers -= 1
        return { kind: 'prepared' }
      },
    })
    mockedLoadPreparation.mockResolvedValue({ activePlugins: [preparer.plugin], preparers: [preparer] })
    const options = {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    } as const

    const first = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    await firstStarted
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(join(lockPath, 'owner.json'), staleTime, staleTime)
    const second = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    await new Promise(resolve => setTimeout(resolve, 20))
    const replacementWasEnteredConcurrently = maximumActivePreparers > 1

    releaseFirst()
    await Promise.all([first, second])

    expect(replacementWasEnteredConcurrently).toBe(false)
  })

  it('does not let a delayed stale contender prepare beside a replacement owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-stale-replacement-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    await mkdir(lockPath, { recursive: true })
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(lockPath, staleTime, staleTime)
    staleReplacement.lockPath = lockPath

    let activePreparers = 0
    let maximumActivePreparers = 0
    let releaseFirst: () => void = () => undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let calls = 0
    const preparer = loadedPreparer(root, {
      apiVersion: 1,
      async prepare() {
        calls += 1
        activePreparers += 1
        maximumActivePreparers = Math.max(maximumActivePreparers, activePreparers)
        if (calls === 1) {
          firstEntered()
          await firstBlocked
        }
        activePreparers -= 1
        return {
          kind: 'prepared',
          generatedArtifacts: [{ path: 'registry.json', contents: `v${calls}` }],
        }
      },
    })
    mockedLoadPreparation.mockResolvedValue({ activePlugins: [preparer.plugin], preparers: [preparer] })
    const options = {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    } as const
    staleReplacement.enabled = true

    const first = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    const second = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    await firstStarted
    await new Promise(resolve => setTimeout(resolve, 20))
    const replacementWasEnteredConcurrently = maximumActivePreparers > 1

    releaseFirst()
    await Promise.all([first, second])

    expect(replacementWasEnteredConcurrently).toBe(false)
    expect(await readFile(join(root, '.holo-js/generated/lock-test/registry.json'), 'utf8')).toBe('v2')
  })
})
