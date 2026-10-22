import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyWorkspaceDist, isWorkspaceDistCurrent, rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'
import { writeWorkspaceBuildMarker } from '../../../scripts/workspace-build-fingerprint.mjs'

const roots: string[] = []
const BASE_TIME = Math.floor(Date.now() / 1000) - 1000

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createWorkspace(): Promise<{ root: string, directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'holo-workspace-dist-'))
  roots.push(root)
  const directory = join(root, 'packages', 'example')
  await mkdir(join(directory, 'src'), { recursive: true })
  await mkdir(join(directory, 'tests'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@holo-js/example', main: './dist/index.mjs' }))
  await writeFile(join(directory, 'src', 'index.ts'), 'export const value = 1\n')
  await writeFile(join(directory, 'src', 'extra.ts'), 'export const extra = 1\n')
  await writeFile(join(directory, 'build.config.ts'), 'export default { entry: "src/index.ts" }\n')
  await writeFile(join(directory, 'tests', 'example.test.ts'), 'export {}\n')
  return { root, directory }
}

// Writes a dist and its marker, as a successful build does.
async function buildDist(directory: string): Promise<void> {
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'dist', 'index.mjs'), 'export const value = 1\n')
  writeWorkspaceBuildMarker(directory)
}

async function setTime(path: string, at: number): Promise<void> {
  await utimes(path, at, at)
}

describe('workspace dist freshness', () => {
  it('stays current after a touch that changes no content', async () => {
    const { directory } = await createWorkspace()
    await buildDist(directory)
    const future = Date.now() / 1000 + 100
    await setTime(join(directory, 'src', 'index.ts'), future)

    expect(isWorkspaceDistCurrent(directory)).toBe(true)
    const build = vi.fn(async () => {})
    const rebuilt = await rebuildStaleWorkspacePackages('/unused', [{ name: '@holo-js/example', directory }], build)
    expect(build).not.toHaveBeenCalled()
    expect(rebuilt).toEqual([])
  })

  it('is stale when a source file is deleted', async () => {
    const { directory } = await createWorkspace()
    await buildDist(directory)
    await rm(join(directory, 'src', 'extra.ts'))

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
  })

  it('is stale when build.config.ts changes, even with an older modification time', async () => {
    const { directory } = await createWorkspace()
    await buildDist(directory)
    await writeFile(join(directory, 'build.config.ts'), 'export default { entry: "src/other.ts" }\n')
    await setTime(join(directory, 'build.config.ts'), BASE_TIME)

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
  })

  it('ignores edits under tests', async () => {
    const { directory } = await createWorkspace()
    await buildDist(directory)
    await writeFile(join(directory, 'tests', 'example.test.ts'), 'export const changed = true\n')

    expect(isWorkspaceDistCurrent(directory)).toBe(true)
  })

  it('is stale when a manifest entry point is missing from dist', async () => {
    const { directory } = await createWorkspace()
    await buildDist(directory)
    await rm(join(directory, 'dist', 'index.mjs'))

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
  })

  it('is stale without a build marker', async () => {
    const { directory } = await createWorkspace()
    await mkdir(join(directory, 'dist'), { recursive: true })
    await writeFile(join(directory, 'dist', 'index.mjs'), 'export const value = 1\n')

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
  })

  it('rebuilds a package whose source content changed and records a marker after the build', async () => {
    const { root, directory } = await createWorkspace()
    await buildDist(directory)
    await writeFile(join(directory, 'src', 'index.ts'), 'export const value = 2\n')

    const build = vi.fn(async () => {
      await buildDist(directory)
    })
    const rebuilt = await rebuildStaleWorkspacePackages(root, [{ name: '@holo-js/example', directory }], build)
    expect(build).toHaveBeenCalledWith('@holo-js/example', root)
    expect(rebuilt).toEqual(['@holo-js/example'])
    expect(isWorkspaceDistCurrent(directory)).toBe(true)
  })

  it('rebuilds a package with no dist yet', async () => {
    const { root, directory } = await createWorkspace()

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
    const build = vi.fn(async () => {})
    await rebuildStaleWorkspacePackages(root, [{ name: '@holo-js/example', directory }], build)
    expect(build).toHaveBeenCalledWith('@holo-js/example', root)
  })
})

describe('staged workspace dist', () => {
  it('copies the dist into the staged package as real files instead of linking to the workspace', async () => {
    const { root, directory } = await createWorkspace()
    await buildDist(directory)
    await writeFile(join(root, 'outside.mjs'), 'export const outside = true\n')
    await symlink(join(root, 'outside.mjs'), join(directory, 'dist', 'linked.mjs'))

    const staged = join(root, 'staged', 'example')
    await mkdir(staged, { recursive: true })
    copyWorkspaceDist(join(directory, 'dist'), join(staged, 'dist'))

    expect((await lstat(join(staged, 'dist'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(staged, 'dist', 'index.mjs'))).isSymbolicLink()).toBe(false)
    expect((await lstat(join(staged, 'dist', 'linked.mjs'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(staged, 'dist', 'linked.mjs'), 'utf8')).toBe('export const outside = true\n')
  })
})
