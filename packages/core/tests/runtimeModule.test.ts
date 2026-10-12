import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { importBundledRuntimeModule, runtimeModuleInternals } from '../src/runtimeModule'

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-runtime-module-'))
  tempDirs.push(root)
  await mkdir(root, { recursive: true })
  return root
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('@holo-js/core runtime module helpers', () => {
  it('loads installed storage modules in a client module graph', async () => {
    const projectRoot = await realpath(await createTempProject())
    const repoRoot = resolve(import.meta.dirname, '../../..')
    await writeFile(join(projectRoot, 'environment.mjs'), `export default {
      name: 'runtime-client', viteEnvironment: 'client',
      setup() { return { teardown() {} } },
    }`)
    await writeFile(join(projectRoot, 'vitest.config.mjs'), `export default {
      test: { include: ['storage.test.mjs'], environment: './environment.mjs' },
    }`)
    await writeFile(join(projectRoot, 'storage.test.mjs'), `
      import { expect, it } from ${JSON.stringify(join(repoRoot, 'node_modules/vitest/dist/index.js'))}
      import { importOptionalRuntimeModule } from ${JSON.stringify(join(repoRoot, 'packages/core/src/runtimeModule.ts'))}
      it('loads installed storage exports', async () => {
        const storage = await importOptionalRuntimeModule('@holo-js/storage')
        const runtime = await importOptionalRuntimeModule('@holo-js/storage/runtime')
        expect(storage.normalizeModuleOptions({})).toHaveProperty('defaultDisk')
        expect(runtime.Storage.disk).toBeTypeOf('function')
      })
    `)
    const resultPath = join(projectRoot, 'results.json')
    await promisify(execFile)(process.execPath, [
      join(repoRoot, 'node_modules/vitest/vitest.mjs'), 'run',
      '--root', projectRoot, '--config', join(projectRoot, 'vitest.config.mjs'),
      '--fileParallelism', '--maxWorkers=2', '--reporter=json', `--outputFile=${resultPath}`,
    ], { cwd: projectRoot })
  })

  it('does not import package export targets pruned from a production artifact', async () => {
    const projectRoot = await createTempProject()
    const packageRoot = join(projectRoot, 'node_modules/@fixture/optional')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/optional',
      type: 'module',
      exports: {
        './config': './dist/config.mjs',
      },
    }), 'utf8')

    expect(runtimeModuleInternals.resolveOptionalImportSpecifier(
      '@fixture/optional/config',
      projectRoot,
    )).toBeUndefined()
    await expect(runtimeModuleInternals.importOptionalRuntimeModule(
      '@fixture/optional/config',
      { projectRoot },
    )).resolves.toBeUndefined()
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

    const packageRoot = join(projectRoot, 'node_modules/@fixture/optional')
    await mkdir(join(packageRoot, 'dist'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: '@fixture/optional',
      type: 'module',
      exports: {
        './config': './dist/config.mjs',
      },
    }), 'utf8')
    await writeFile(join(packageRoot, 'dist/config.mjs'), 'import "./missing-child.mjs"\nexport const loaded = true\n', 'utf8')

    await expect(runtimeModuleInternals.importOptionalRuntimeModule(
      '@fixture/optional/config',
      { projectRoot },
    )).rejects.toThrow('missing-child.mjs')
  })

  it('reports native TypeScript bundling failures and loads repaired modules with project aliases', async () => {
    const projectRoot = await createTempProject()
    const entryPath = join(projectRoot, 'server/jobs/report.ts')
    await mkdir(join(projectRoot, 'server/jobs'), { recursive: true })
    await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['./server/*'] } },
    }))
    await writeFile(join(projectRoot, 'server/value.ts'), 'export const value = 42\n')
    await writeFile(entryPath, 'export const value = {\n')
    await expect(importBundledRuntimeModule(projectRoot, entryPath)).rejects.toThrow()
    await writeFile(entryPath, 'import { value } from "@/value"\nexport default { value }\n')
    const loaded = await importBundledRuntimeModule(projectRoot, entryPath) as { default: { value: number } }
    expect(loaded.default).toEqual({ value: 42 })
  })
})
