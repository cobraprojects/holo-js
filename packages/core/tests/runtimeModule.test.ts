import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeModuleInternals } from '../src/runtimeModule'

vi.mock('esbuild', () => ({
  default: {
    build: vi.fn(async () => ({ warnings: [], outputFiles: [] })),
  },
}))

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
  it('keeps installed runtime dependencies in the same module tree', () => {
    expect(runtimeModuleInternals.resolveRuntimeModuleSearchPaths(
      '/app',
      'file:///app/node_modules/@holo-js/core/dist/index.mjs',
    )).toBeUndefined()
    expect(runtimeModuleInternals.resolveRuntimeModuleSearchPaths(
      'C:\\app',
      'file:///C:/app/node_modules/@holo-js/core/dist/index.mjs',
    )).toBeUndefined()
    expect(runtimeModuleInternals.resolveRuntimeModuleSearchPaths(
      '/app',
      'file:///workspace/packages/core/src/runtimeModule.ts',
    )).toEqual(['/app'])
  })

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

  it('imports runtime modules through the webpackIgnore branch outside Vitest', async () => {
    const projectRoot = await createTempProject()
    const entryPath = join(projectRoot, 'module.mjs')

    await writeFile(entryPath, 'export default "loaded"\nexport const value = 42\n', 'utf8')

    const originalVitest = process.env.VITEST
    delete process.env.VITEST
    try {
      const loaded = await runtimeModuleInternals.importModule<{
        default: string
        value: number
      }>(pathToFileURL(entryPath).href)

      expect(loaded.default).toBe('loaded')
      expect(loaded.value).toBe(42)
    } finally {
      if (typeof originalVitest === 'string') {
        process.env.VITEST = originalVitest
      } else {
        delete process.env.VITEST
      }
    }
  })

  it('does not hide missing transitive dependencies in optional runtime modules', async () => {
    const projectRoot = await createTempProject()
    const missingPath = join(projectRoot, 'missing.mjs')
    const entryPath = join(projectRoot, 'optional.mjs')

    await expect(
      runtimeModuleInternals.importOptionalRuntimeModule(pathToFileURL(missingPath).href),
    ).resolves.toBeUndefined()

    await writeFile(entryPath, 'import "./missing-child.mjs"\nexport const loaded = true\n', 'utf8')

    await expect(
      runtimeModuleInternals.importOptionalRuntimeModule(pathToFileURL(entryPath).href),
    ).rejects.toThrow()
  })

  it('recognizes missing package roots for every optional package subpath', () => {
    const optionalSubpaths = [
      '@holo-js/auth/config',
      '@holo-js/broadcast/config',
      '@holo-js/cache/config',
      '@holo-js/mail/config',
      '@holo-js/media/config',
      '@holo-js/notifications/config',
      '@holo-js/queue/config',
      '@holo-js/security/config',
      '@holo-js/security/drivers/redis-adapter',
      '@holo-js/session/config',
      '@holo-js/session/drivers/redis-adapter',
      '@holo-js/storage/config',
      '@holo-js/storage/runtime',
    ] as const

    for (const specifier of optionalSubpaths) {
      const [scope, packageName] = specifier.split('/')
      const packageRoot = `${scope}/${packageName}`
      const error = Object.assign(
        new Error(`Cannot find package '${packageRoot}' imported from /app/node_modules/@holo-js/core/dist/index.mjs`),
        { code: 'ERR_MODULE_NOT_FOUND' },
      )

      expect(runtimeModuleInternals.isMissingOptionalModule(error, specifier, specifier)).toBe(true)
    }

    const transitiveError = Object.assign(
      new Error("Cannot find package 'missing-transitive-package' imported from /app/node_modules/@holo-js/mail/dist/config.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(runtimeModuleInternals.isMissingOptionalModule(
      transitiveError,
      '@holo-js/mail/config',
      '@holo-js/mail/config',
    )).toBe(false)

    const relativeError = Object.assign(
      new Error("Cannot find module '/app/optional-runtime.mjs' imported from /app/index.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(runtimeModuleInternals.isMissingOptionalModule(
      relativeError,
      './optional-runtime.mjs',
      './optional-runtime.mjs',
    )).toBe(true)
    expect(runtimeModuleInternals.isMissingOptionalModule(
      relativeError,
      '../optional-runtime.mjs',
      '../optional-runtime.mjs',
    )).toBe(false)

    const unscopedError = Object.assign(
      new Error("Cannot find package 'optional-package' imported from /app/index.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(runtimeModuleInternals.isMissingOptionalModule(
      unscopedError,
      'optional-package/subpath',
      'optional-package/subpath',
    )).toBe(true)

    const malformedScopedError = Object.assign(
      new Error("Cannot find package '@holo-js' imported from /app/index.mjs"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(runtimeModuleInternals.isMissingOptionalModule(
      malformedScopedError,
      '@holo-js',
      '@holo-js',
    )).toBe(true)
    expect(runtimeModuleInternals.isMissingOptionalModule('missing', '@holo-js/mail', '@holo-js/mail')).toBe(false)
  })

  it('returns the default esbuild export when the imported module does not expose build directly', async () => {
    await expect(runtimeModuleInternals.loadEsbuild()).resolves.toEqual(expect.objectContaining({
      build: expect.any(Function),
    }))
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

    vi.spyOn(runtimeModuleInternals, 'runEsbuild').mockRejectedValueOnce({})
    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)).rejects.toThrow(
      `Failed to load ${entryPath}.`,
    )

    vi.spyOn(runtimeModuleInternals, 'runEsbuild').mockRejectedValueOnce({
      errors: 'boom',
    })
    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)).rejects.toThrow(
      `Failed to load ${entryPath}.`,
    )
  })
})
