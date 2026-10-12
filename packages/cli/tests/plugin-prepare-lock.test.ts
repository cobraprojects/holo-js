import { installPreparers } from './support/native-preparers'
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHoloProjectConfig, type HoloProjectPreparer } from '@holo-js/kernel'
import { afterEach, describe, expect, it } from 'vitest'
import { runPluginProjectPreparers } from '../src/project/plugin-prepare/coordinator'
import type { LoadedProjectPreparer } from '../src/project/plugins'

const temporaryDirectories: string[] = []

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
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('plugin project preparation locking', () => {
  it('does not reclaim a stale lock owned by a live local preparer', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-live-owner-')))
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
    await installPreparers(root, [preparer])
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

  it('serializes native contenders reclaiming an abandoned stale lock', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-stale-replacement-')))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    await mkdir(lockPath, { recursive: true })
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(lockPath, staleTime, staleTime)

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
    await installPreparers(root, [preparer])
    const options = {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    } as const

    const contenders = Array.from({ length: 2 }, () => runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options))
    await firstStarted
    await new Promise(resolve => setTimeout(resolve, 20))
    const replacementWasEnteredConcurrently = maximumActivePreparers > 1

    releaseFirst()
    await Promise.all(contenders)

    expect(replacementWasEnteredConcurrently).toBe(false)
    expect(maximumActivePreparers).toBe(1)
    expect(calls).toBe(2)
    expect(await readFile(join(root, '.holo-js/generated/lock-test/registry.json'), 'utf8')).toBe('v2')
  })
})
