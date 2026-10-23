import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as holoConfig from '@holo-js/config'
import * as holoDb from '@holo-js/db'
import { importBundledRuntimeModule, loadProjectDefinitionRuntimeModules, runtimeModuleInternals } from '../src/runtimeModule'
import type * as runtimeModuleInternalsModule from '../src/runtimeModule'

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

async function createDependencyDefinitionFixture(): Promise<{ projectRoot: string, definitionPath: string }> {
  const projectRoot = await createTempProject()
  await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../..'), join(projectRoot, 'node_modules/@holo-js'), 'dir')
  const jobsRoot = join(projectRoot, 'node_modules/@acme/jobs')
  const nestedCopyRoot = join(jobsRoot, 'node_modules/@holo-js/config')
  await mkdir(nestedCopyRoot, { recursive: true })
  await writeFile(join(jobsRoot, 'package.json'), JSON.stringify({ name: '@acme/jobs', type: 'module', exports: { '.': './job.mjs' } }))
  await writeFile(join(nestedCopyRoot, 'package.json'), JSON.stringify({ name: '@holo-js/config', type: 'module', exports: { '.': './index.mjs' } }))
  await writeFile(join(nestedCopyRoot, 'index.mjs'), 'export const defineAppConfig = "nested copy"\n')
  const definitionPath = join(jobsRoot, 'job.mjs')
  await writeFile(definitionPath, "export { defineAppConfig } from '@holo-js/config'\n")
  return { projectRoot, definitionPath }
}

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

  it('bundles app imports of a holo package to the instance the runtime itself uses', async () => {
    const projectRoot = await createTempProject()
    const appCopyRoot = join(projectRoot, 'node_modules/@holo-js/db')
    await mkdir(appCopyRoot, { recursive: true })
    await writeFile(join(appCopyRoot, 'package.json'), JSON.stringify({
      name: '@holo-js/db',
      type: 'module',
      exports: { '.': './index.mjs' },
    }))
    await writeFile(join(appCopyRoot, 'index.mjs'), 'export const Entity = "app copy"\n')
    await writeFile(join(projectRoot, 'model.ts'), "export { Entity } from '@holo-js/db'\n")

    const bundled = await runtimeModuleInternals.bundleRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))
    const source = await readFile(bundled.path, 'utf8')
    const model = await runtimeModuleInternals.importModule<{ Entity: unknown }>(pathToFileURL(bundled.path).href)
    await bundled.cleanup()

    expect(source).not.toContain('from "@holo-js/db"')
    expect(model.Entity).toBe(holoDb.Entity)
  })

  it('bundles unregistered holo packages from the runtime root, not the app copy', async () => {
    const projectRoot = await createTempProject()
    const appMediaRoot = join(projectRoot, 'node_modules/@holo-js/media')
    await mkdir(appMediaRoot, { recursive: true })
    await writeFile(join(appMediaRoot, 'package.json'), JSON.stringify({
      name: '@holo-js/media',
      type: 'module',
      exports: { '.': './index.mjs' },
    }))
    await writeFile(join(appMediaRoot, 'index.mjs'), 'export const source = "app copy"\n')
    await writeFile(join(projectRoot, 'model.ts'), "export { source } from '@holo-js/media'\n")

    const bundled = await runtimeModuleInternals.bundleRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))
    const source = await readFile(bundled.path, 'utf8')
    await bundled.cleanup()

    expect(source).not.toContain('"@holo-js/media"')
    expect(source).not.toContain(appMediaRoot)
    expect(source).toContain('/packages/media/')
  })

  it('fails loudly when app code imports a holo package the runtime cannot resolve', async () => {
    const projectRoot = await createTempProject()
    await writeFile(join(projectRoot, 'model.ts'), "export { nothing } from '@holo-js/not-installed-anywhere'\n")

    await expect(runtimeModuleInternals.bundleRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))).rejects.toThrow(/alongside the Holo runtime/)
  })

  it('binds each runtime copy to the instances that copy registered', async () => {
    const projectRoot = await createTempProject()
    await writeFile(join(projectRoot, 'model.ts'), "export { marker } from '@holo-js/fixture-instance'\n")
    const runtimeModulePath = resolve(import.meta.dirname, '../src/runtimeModule.ts')
    const firstCopy = await import(`${runtimeModulePath}?copy=first`) as typeof runtimeModuleInternalsModule
    const secondCopy = await import(`${runtimeModulePath}?copy=second`) as typeof runtimeModuleInternalsModule
    firstCopy.runtimeModuleInternals.registerRuntimeModuleInstance('@holo-js/fixture-instance', { marker: 'first' })
    secondCopy.runtimeModuleInternals.registerRuntimeModuleInstance('@holo-js/fixture-instance', { marker: 'second' })

    const firstBundle = await firstCopy.runtimeModuleInternals.bundleRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))
    const firstModel = await firstCopy.runtimeModuleInternals.importModule<{ marker: string }>(pathToFileURL(firstBundle.path).href)
    await firstBundle.cleanup()
    const secondBundle = await secondCopy.runtimeModuleInternals.bundleRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))
    const secondModel = await secondCopy.runtimeModuleInternals.importModule<{ marker: string }>(pathToFileURL(secondBundle.path).href)
    await secondBundle.cleanup()

    expect(firstModel.marker).toBe('first')
    expect(secondModel.marker).toBe('second')
  })

  it('binds a definition shipped in a dependency to the runtime when the dependency has its own holo copy', async () => {
    const { projectRoot, definitionPath } = await createDependencyDefinitionFixture()

    const importDefinition = await loadProjectDefinitionRuntimeModules(projectRoot, [definitionPath])
    const definition = await importDefinition(definitionPath) as { defineAppConfig: unknown }

    expect(definition.defineAppConfig).toBe(holoConfig.defineAppConfig)
  })

  it('checks dependency-shipped definitions under a source loader too', async () => {
    const { projectRoot, definitionPath } = await createDependencyDefinitionFixture()
    vi.stubGlobal('Bun', {})

    try {
      const importDefinition = await loadProjectDefinitionRuntimeModules(projectRoot, [definitionPath])
      const definition = await importDefinition(definitionPath) as { defineAppConfig: unknown }

      expect(definition.defineAppConfig).toBe(holoConfig.defineAppConfig)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('loads app definitions natively under a source loader so the runtime and the app share each definition object', async () => {
    const projectRoot = await realpath(await createTempProject())
    await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../..'), join(projectRoot, 'node_modules/@holo-js'), 'dir')
    const jobsRoot = join(projectRoot, 'server/jobs')
    await mkdir(jobsRoot, { recursive: true })
    await writeFile(join(jobsRoot, 'label.ts'), "export const label = 'report'\n")
    const definitionPath = join(jobsRoot, 'report.ts')
    await writeFile(definitionPath, "import { label } from './label'\nexport const job = { label }\n")
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, [${JSON.stringify(definitionPath)}])
const loaded = await importDefinition(${JSON.stringify(definitionPath)})
const direct = await import(${JSON.stringify(pathToFileURL(definitionPath).href)})
console.log(JSON.stringify({ shared: loaded.job === direct.job }))
`)
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', tsxLoaderUrl, childPath], {
      cwd: projectRoot,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '' },
    })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { shared: boolean }

    expect(result.shared).toBe(true)
  }, 30_000)

  it('bundles app definitions that import a path alias when the project has no root tsconfig', async () => {
    const projectRoot = await realpath(await createTempProject())
    await mkdir(join(projectRoot, 'models'), { recursive: true })
    await mkdir(join(projectRoot, 'jobs'), { recursive: true })
    await writeFile(join(projectRoot, 'models/Post.ts'), "export const Post = { title: 'post' }\n")
    const definitionPath = join(projectRoot, 'jobs/report.ts')
    await writeFile(definitionPath, "import { Post } from '@/models/Post'\nexport const job = { title: Post.title }\n")
    vi.stubGlobal('Bun', {})

    try {
      const importDefinition = await loadProjectDefinitionRuntimeModules(projectRoot, [definitionPath])
      const definition = await importDefinition(definitionPath) as { job: { title: string } }

      expect(definition.job.title).toBe('post')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    { label: 'the root tsconfig defines the alias', tsconfig: true, override: false, bundled: false },
    { label: 'the project has no root tsconfig', tsconfig: false, override: false, bundled: true },
    { label: 'TSX_TSCONFIG_PATH points tsx at another tsconfig', tsconfig: true, override: true, bundled: true },
  ])('loads a definition that imports a path alias under tsx when $label', async ({ tsconfig, override, bundled }) => {
    const projectRoot = await realpath(await createTempProject())
    await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../..'), join(projectRoot, 'node_modules/@holo-js'), 'dir')
    await mkdir(join(projectRoot, 'models'), { recursive: true })
    await mkdir(join(projectRoot, 'jobs'), { recursive: true })
    await writeFile(join(projectRoot, 'models/Post.ts'), "export const Post = { title: 'post' }\n")
    const definitionPath = join(projectRoot, 'jobs/report.ts')
    await writeFile(definitionPath, "import { Post } from '@/models/Post'\nexport const job = { title: Post.title }\n")
    if (tsconfig) {
      await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }))
    }
    await writeFile(join(projectRoot, 'tsconfig.tsx.json'), JSON.stringify({ compilerOptions: {} }))
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, [${JSON.stringify(definitionPath)}])
const loaded = await importDefinition(${JSON.stringify(definitionPath)})
let direct
try {
  direct = await import(${JSON.stringify(pathToFileURL(definitionPath).href)})
} catch {}
console.log(JSON.stringify({ title: loaded.job.title, shared: direct !== undefined && loaded.job === direct.job }))
`)
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '' }
    delete env.TSX_TSCONFIG_PATH
    if (override) env.TSX_TSCONFIG_PATH = join(projectRoot, 'tsconfig.tsx.json')
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', tsxLoaderUrl, childPath], { cwd: projectRoot, env })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { title: string, shared: boolean }

    expect(result.title).toBe('post')
    expect(result.shared).toBe(!bundled)
  }, 30_000)

  it.each([
    { label: 'no preservation', args: [] as string[], env: {} as Record<string, string>, bundled: false },
    { label: '--preserve-symlinks', args: ['--preserve-symlinks'], env: {}, bundled: true },
    { label: '--preserve_symlinks', args: ['--preserve_symlinks'], env: {}, bundled: true },
    { label: 'NODE_PRESERVE_SYMLINKS=1', args: [], env: { NODE_PRESERVE_SYMLINKS: '1' }, bundled: true },
  ])('loads a dependency-shipped definition from the runtime instance under ', async ({ args, env, bundled }) => {
    const projectRoot = await createTempProject()
    await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
    await symlink(resolve(import.meta.dirname, '../..'), join(projectRoot, 'node_modules/@holo-js'), 'dir')
    const jobsRoot = join(projectRoot, 'node_modules/@acme/jobs')
    await mkdir(jobsRoot, { recursive: true })
    await writeFile(join(jobsRoot, 'package.json'), JSON.stringify({ name: '@acme/jobs', type: 'module', exports: { '.': './job.mjs' } }))
    const definitionPath = join(jobsRoot, 'job.mjs')
    await writeFile(definitionPath, "export { defineAppConfig } from '@holo-js/config'\nexport const source = import.meta.url\n")
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const runtimeConfigUrl = pathToFileURL(resolve(import.meta.dirname, '../node_modules/@holo-js/config/dist/index.mjs')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const runtimeConfig = await import(${JSON.stringify(runtimeConfigUrl)})
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, [${JSON.stringify(definitionPath)}])
const definition = await importDefinition(${JSON.stringify(definitionPath)})
console.log(JSON.stringify({ bridged: definition.defineAppConfig === runtimeConfig.defineAppConfig, source: definition.source }))
`)
    const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
    const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
    const childEnv: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '', ESBUILD_BINARY_PATH: esbuildBinary, ...env }
    const { stdout } = await promisify(execFile)(process.execPath, [...args, '--experimental-strip-types', childPath], { cwd: projectRoot, env: childEnv })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { bridged: boolean, source: string }

    expect(result.bridged).toBe(true)
    expect(result.source.endsWith('/job.mjs')).toBe(!bundled)
  }, 30_000)

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
