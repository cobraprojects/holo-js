import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeModuleInternals } from '../src/runtimeModule'

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-runtime-module-'))
  tempDirs.push(root)
  await mkdir(root, { recursive: true })
  return root
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('@holo-js/core runtime module helpers', () => {
  it('detects existing paths and reuses the project tsconfig when present', async () => {
    const projectRoot = await createTempProject()
    const tempDir = await createTempProject()
    const tsconfigPath = join(projectRoot, 'tsconfig.json')

    await writeFile(tsconfigPath, '{ "compilerOptions": {} }\n', 'utf8')

    await expect(runtimeModuleInternals.pathExists(tsconfigPath)).resolves.toBe(true)
    await expect(runtimeModuleInternals.pathExists(join(projectRoot, 'missing.ts'))).resolves.toBe(false)
    await expect(runtimeModuleInternals.writeLoaderTsconfig(projectRoot, tempDir)).resolves.toBe(tsconfigPath)
  })

  it('writes a loader tsconfig with default project aliases when no tsconfig exists', async () => {
    const projectRoot = await createTempProject()
    const tempDir = await createTempProject()

    const tsconfigPath = await runtimeModuleInternals.writeLoaderTsconfig(projectRoot, tempDir)
    const contents = await readFile(tsconfigPath, 'utf8')

    expect(tsconfigPath).toBe(join(tempDir, 'tsconfig.json'))
    expect(contents).toContain(`"baseUrl": "${projectRoot}"`)
    expect(contents).toContain('"~/*"')
    expect(contents).toContain('"@/*"')
  })

  it('imports runtime modules through the direct Vitest loader branch', async () => {
    const projectRoot = await createTempProject()
    const entryPath = join(projectRoot, 'module.mjs')

    await writeFile(entryPath, 'export default "loaded"\nexport const value = 42\n', 'utf8')

    const loaded = await runtimeModuleInternals.importModule<{
      default: string
      value: number
    }>(pathToFileURL(entryPath).href)

    expect(loaded.default).toBe('loaded')
    expect(loaded.value).toBe(42)
  })

  it('surfaces bundled runtime build failures clearly', async () => {
    const projectRoot = await createTempProject()
    const entryPath = join(projectRoot, 'server/jobs/report.ts')

    vi.spyOn(runtimeModuleInternals, 'runEsbuild').mockRejectedValueOnce({
      errors: [
        { text: 'bad build' },
        { message: 'next failure' },
        {},
      ],
    })

    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)).rejects.toThrow(
      'bad build\nnext failure\nUnknown build error.',
    )

    vi.spyOn(runtimeModuleInternals, 'runEsbuild').mockRejectedValueOnce(new Error('plain build failure'))
    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)).rejects.toThrow(
      'plain build failure',
    )

    vi.spyOn(runtimeModuleInternals, 'runEsbuild').mockRejectedValueOnce('boom')
    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)).rejects.toThrow(
      `Failed to load ${entryPath}.`,
    )
  })
})
