import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyWorkspaceDist, isWorkspaceDistCurrent, rebuildStaleWorkspacePackages } from '../../../tests/support/workspace-dist'

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
  await writeFile(join(directory, 'package.json'), '{"name":"@holo-js/example"}')
  await writeFile(join(directory, 'src', 'index.ts'), 'export const value = 1\n')
  return { root, directory }
}

async function buildDist(directory: string, at: number): Promise<void> {
  await mkdir(join(directory, 'dist'), { recursive: true })
  await writeFile(join(directory, 'dist', 'index.mjs'), 'export const value = 1\n')
  await utimes(join(directory, 'dist', 'index.mjs'), at, at)
}

async function touch(path: string, at: number): Promise<void> {
  await utimes(path, at, at)
}

describe('workspace dist reuse', () => {
  it('treats a dist built after every source input as current and rebuilds nothing', async () => {
    const { root, directory } = await createWorkspace()
    await touch(join(directory, 'src', 'index.ts'), BASE_TIME)
    await touch(join(directory, 'package.json'), BASE_TIME)
    await buildDist(directory, BASE_TIME + 10)

    expect(isWorkspaceDistCurrent(directory)).toBe(true)
    const build = vi.fn(async () => {})
    const rebuilt = await rebuildStaleWorkspacePackages(root, [{ name: '@holo-js/example', directory }], build)
    expect(build).not.toHaveBeenCalled()
    expect(rebuilt).toEqual([])
  })

  it('rebuilds a package whose source changed after its dist was built', async () => {
    const { root, directory } = await createWorkspace()
    await touch(join(directory, 'src', 'index.ts'), BASE_TIME)
    await buildDist(directory, BASE_TIME + 10)
    await touch(join(directory, 'src', 'index.ts'), BASE_TIME + 20)

    expect(isWorkspaceDistCurrent(directory)).toBe(false)
    const build = vi.fn(async () => {})
    const rebuilt = await rebuildStaleWorkspacePackages(root, [{ name: '@holo-js/example', directory }], build)
    expect(build).toHaveBeenCalledWith('@holo-js/example', root)
    expect(rebuilt).toEqual(['@holo-js/example'])
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
    await buildDist(directory, BASE_TIME + 10)
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
