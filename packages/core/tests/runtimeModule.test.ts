import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as holoConfig from '@holo-js/config'
import * as holoDb from '@holo-js/db'
import { importBundledRuntimeModule, loadProjectDefinitionRuntimeModules, runtimeModuleInternals, sourceModuleUrlInternals } from '../src/runtimeModule'
import type * as runtimeModuleInternalsModule from '../src/runtimeModule'

const postModule = "export const Post = { title: 'post' }\n"
const esmOnlyManifest = JSON.stringify({ name: 'esm-only-pkg', type: 'module', exports: { '.': { import: './index.mjs' } } })
const aliasConfig = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } })
const noAliasConfig = JSON.stringify({ compilerOptions: {} })
const bunAvailable = spawnSync('bun', ['--version']).status === 0

type AliasProjectOptions = {
  readonly specifier?: string
  readonly scope?: 'module' | 'commonjs'
  readonly files?: Partial<Record<string, string>>
  readonly definition?: string
}

async function createAliasDefinitionProject(options: AliasProjectOptions = {}): Promise<{ projectRoot: string, definitionPath: string }> {
  const projectRoot = await realpath(await createTempProject())
  await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../..'), join(projectRoot, 'node_modules/@holo-js'), 'dir')
  if (options.scope !== 'commonjs') await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n')
  await mkdir(join(projectRoot, 'jobs'), { recursive: true })
  const definitionPath = join(projectRoot, 'jobs/report.ts')
  await writeFile(definitionPath, options.definition ?? `import { Post } from '${options.specifier ?? '@/models/Post'}'\nexport const job = { title: Post.title }\n`)
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    if (contents === undefined) continue
    await mkdir(join(projectRoot, dirname(name)), { recursive: true })
    await writeFile(join(projectRoot, name), contents)
  }
  return { projectRoot, definitionPath }
}

async function runAliasDefinitionChild(
  projectRoot: string,
  definitionPath: string,
  runtime: { readonly command: string, readonly args: readonly string[], readonly env: Record<string, string> },
): Promise<{ title: string, shared: boolean }> {
  const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
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
  const { stdout } = await promisify(execFile)(runtime.command, [...runtime.args, childPath], { cwd: projectRoot, env: { ...env, HOLO_SIDE_EFFECT_LOG: join(projectRoot, 'side-effects.log'), ...runtime.env } })
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { title: string, shared: boolean }
}

async function readSideEffectLog(projectRoot: string): Promise<string[]> {
  const contents = (await readFile(join(projectRoot, 'side-effects.log'), 'utf8').catch(() => '')).trim()
  return contents ? contents.split('\n') : []
}

async function loadDefinitionChildOutcome(
  projectRoot: string,
  definitionPaths: readonly string[],
  runtime: { readonly command: string, readonly args: readonly string[], readonly env: Record<string, string> },
): Promise<{ loaded: boolean, code?: string, message?: string }> {
  const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
  const childPath = join(projectRoot, 'child.mjs')
  await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
try {
  const paths = ${JSON.stringify(definitionPaths)}
  const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, paths)
  for (const path of paths) await importDefinition(path)
  console.log(JSON.stringify({ loaded: true }))
} catch (error) {
  console.log(JSON.stringify({ loaded: false, code: error.code ?? null, message: String(error.message) }))
}
`)
  const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '' }
  delete env.TSX_TSCONFIG_PATH
  const { stdout } = await promisify(execFile)(runtime.command, [...runtime.args, childPath], { cwd: projectRoot, env: { ...env, HOLO_SIDE_EFFECT_LOG: join(projectRoot, 'side-effects.log'), ...runtime.env } })
  const outcome = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { loaded: boolean, code?: string, message?: string }
  return { ...outcome, code: outcome.code ?? undefined }
}

const sideEffectDefinition = "import { appendFileSync } from 'node:fs'\nimport { Post } from '@/models/Post'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'ran\\n')\nexport const job = { title: Post.title }\n"

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

  it('fails loudly when app code imports a holo package that is installed nowhere', async () => {
    const projectRoot = await createTempProject()
    await writeFile(join(projectRoot, 'model.ts'), "export { nothing } from '@holo-js/not-installed-anywhere'\n")

    await expect(importBundledRuntimeModule(projectRoot, join(projectRoot, 'model.ts'))).rejects.toThrow(/Cannot find package '@holo-js\/not-installed-anywhere'/)
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

  it.each([
    { label: 'the root tsconfig defines the alias', options: { files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig } }, tsxConfig: undefined, bundled: false },
    { label: 'the project has no root tsconfig', options: { files: { 'models/Post.ts': postModule } }, tsxConfig: undefined, bundled: true },
    { label: 'TSX_TSCONFIG_PATH points tsx at a tsconfig without the alias', options: { files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig, 'tsconfig.tsx.json': noAliasConfig } }, tsxConfig: 'tsconfig.tsx.json', bundled: true },
    { label: 'the alias targets a directory index', options: { specifier: '@/lib/util', files: { 'lib/util/index.ts': postModule, 'tsconfig.json': aliasConfig } }, tsxConfig: undefined, bundled: false },
    { label: 'the alias has no scope and targets a directory index', options: { specifier: '@util', files: { 'lib/util/index.ts': postModule, 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@util': ['./lib/util'] } } }) } }, tsxConfig: undefined, bundled: false },
    { label: 'the root tsconfig defines the alias in a CommonJS project', options: { scope: 'commonjs' as const, files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig } }, tsxConfig: undefined, bundled: false },
    { label: 'the project has no root tsconfig in a CommonJS project', options: { scope: 'commonjs' as const, files: { 'models/Post.ts': postModule } }, tsxConfig: undefined, bundled: true },
  ])('loads a definition that imports a path alias under tsx when $label', async ({ options, tsxConfig, bundled }) => {
    const { projectRoot, definitionPath } = await createAliasDefinitionProject(options)
    const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

    const result = await runAliasDefinitionChild(projectRoot, definitionPath, {
      command: process.execPath,
      args: ['--import', tsxLoaderUrl],
      env: tsxConfig ? { TSX_TSCONFIG_PATH: join(projectRoot, tsxConfig) } : {},
    })

    expect(result.title).toBe('post')
    expect(result.shared).toBe(!bundled)
  }, 30_000)

  describe.skipIf(!bunAvailable)('under Bun', () => {
    it.each([
      { label: 'only a jsconfig defines the alias', files: { 'models/Post.ts': postModule, 'jsconfig.json': aliasConfig }, args: [] as string[], specifier: '@/models/Post', bundled: false },
      { label: 'the root tsconfig defines the alias', files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig }, args: [] as string[], specifier: '@/models/Post', bundled: false },
      { label: '--tsconfig-override points Bun at a tsconfig without the alias', files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig, 'tsconfig.none.json': noAliasConfig }, args: ['--tsconfig-override', 'tsconfig.none.json'], specifier: '@/models/Post', bundled: true },
      { label: 'the alias targets an import-only package', files: { 'vendor/esm-only/package.json': esmOnlyManifest, 'vendor/esm-only/index.mjs': postModule, 'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./vendor/*'] } } }) }, args: [] as string[], specifier: '@/esm-only', bundled: false },
    ])('loads a definition that imports a path alias when $label', async ({ files, args, bundled, specifier }) => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ files, specifier })

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: 'bun', args, env: {} })

      expect(result.title).toBe('post')
      expect(result.shared).toBe(!bundled)
    }, 30_000)
  })

  describe('evaluates a definition once when its alias needs the bundle', () => {
    it.each([
      { label: 'under tsx in a module project', scope: 'module' as const },
      { label: 'under tsx in a CommonJS project', scope: 'commonjs' as const },
    ])('$label', async ({ scope }) => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ scope, definition: sideEffectDefinition, files: { 'models/Post.ts': postModule } })
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result.title).toBe('post')
      expect(await readSideEffectLog(projectRoot)).toEqual(['ran'])
    }, 30_000)

    it.skipIf(!bunAvailable)('under Bun', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        definition: sideEffectDefinition,
        files: { 'models/Post.ts': postModule, 'tsconfig.json': aliasConfig, 'tsconfig.none.json': noAliasConfig },
      })

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: 'bun', args: ['--tsconfig-override', 'tsconfig.none.json'], env: {} })

      expect(result.title).toBe('post')
      expect(await readSideEffectLog(projectRoot)).toEqual(['ran'])
    }, 30_000)

    it('bundles every definition together when a later one needs the fallback, so they share one module instance', async () => {
      const sharedSource = "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'shared ran\\n')\nexport const shared = { name: 'shared' }\n"
      const reportSource = "import { shared } from './shared'\nexport const job = { name: 'report', shared }\n"
      const listenerSource = "import { job } from './report'\nimport { Post } from '@/models/Post'\nexport const listener = { job, title: Post.title }\n"
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: reportSource, files: { 'models/Post.ts': postModule } })
      await writeFile(join(projectRoot, 'jobs/shared.ts'), sharedSource)
      const listenerPath = join(projectRoot, 'jobs/listener.ts')
      await writeFile(listenerPath, listenerSource)
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href
      const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
      const childPath = join(projectRoot, 'child.mjs')
      await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, [${JSON.stringify(definitionPath)}, ${JSON.stringify(listenerPath)}])
const reportModule = await importDefinition(${JSON.stringify(definitionPath)})
const listenerModule = await importDefinition(${JSON.stringify(listenerPath)})
console.log(JSON.stringify({ sameJob: listenerModule.listener.job === reportModule.job, name: listenerModule.listener.job.name, title: listenerModule.listener.title }))
`)
      const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '', HOLO_SIDE_EFFECT_LOG: join(projectRoot, 'side-effects.log') }
      const { stdout } = await promisify(execFile)(process.execPath, ['--import', tsxLoaderUrl, childPath], { cwd: projectRoot, env })
      const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { sameJob: boolean, name: string, title: string }

      expect(result).toEqual({ sameJob: true, name: 'report', title: 'post' })
      expect(await readSideEffectLog(projectRoot)).toEqual(['shared ran'])
    }, 30_000)
  })

  describe('rejects a missing module that is not a static alias import without running the definition twice', () => {
    const missingPackageRows = [
      { label: 'a static import of a missing package', definition: "import 'missing-pkg'\nimport { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'ran\\n')\nexport const job = {}\n", runs: [] as string[] },
      { label: 'a dynamic import of a missing package after a side effect', definition: "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'ran\\n')\nawait import('missing-pkg')\nexport const job = {}\n", runs: ['ran'] },
    ]

    it.each(missingPackageRows)('under tsx in a module project: $label', async ({ definition, runs }) => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition })
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const outcome = await loadDefinitionChildOutcome(projectRoot, [definitionPath], { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(outcome).toMatchObject({ loaded: false, code: 'ERR_MODULE_NOT_FOUND' })
      expect(outcome.message).toContain('missing-pkg')
      expect(await readSideEffectLog(projectRoot)).toEqual(runs)
    }, 30_000)

    it.skipIf(!bunAvailable).each(missingPackageRows)('under Bun: $label', async ({ definition, runs }) => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition })

      const outcome = await loadDefinitionChildOutcome(projectRoot, [definitionPath], { command: 'bun', args: [], env: {} })

      expect(outcome).toMatchObject({ loaded: false, code: 'ERR_MODULE_NOT_FOUND' })
      expect(outcome.message).toContain('missing-pkg')
      expect(await readSideEffectLog(projectRoot)).toEqual(runs)
    }, 30_000)
  })

  describe('loads every definition as one native set or bundles them together', () => {
    const firstSource = "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'first ran\\n')\nexport const first = { name: 'first' }\n"
    const missingPackageSource = "import 'missing-pkg'\nexport const second = { name: 'second' }\n"

    it('does not run an earlier definition when a later one statically imports a missing package, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: firstSource })
      const secondPath = join(projectRoot, 'jobs/second.ts')
      await writeFile(secondPath, missingPackageSource)
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const outcome = await loadDefinitionChildOutcome(projectRoot, [definitionPath, secondPath], { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(outcome).toMatchObject({ loaded: false, code: 'ERR_MODULE_NOT_FOUND' })
      expect(outcome.message).toContain('missing-pkg')
      expect(await readSideEffectLog(projectRoot)).toEqual([])
    }, 30_000)

    it.skipIf(!bunAvailable)('does not run an earlier definition when a later one statically imports a missing package, under Bun', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: firstSource })
      const secondPath = join(projectRoot, 'jobs/second.ts')
      await writeFile(secondPath, missingPackageSource)

      const outcome = await loadDefinitionChildOutcome(projectRoot, [definitionPath, secondPath], { command: 'bun', args: [], env: {} })

      expect(outcome).toMatchObject({ loaded: false, code: 'ERR_MODULE_NOT_FOUND' })
      expect(outcome.message).toContain('missing-pkg')
      expect(await readSideEffectLog(projectRoot)).toEqual([])
    }, 30_000)

    it('bundles when the bundler and the active tsx loader resolve an alias to different files', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        specifier: '@/x',
        files: {
          'a/x.ts': "export const Post = { title: 'a' }\n",
          'b/x.ts': "export const Post = { title: 'b' }\n",
          'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/x': ['./a/x.ts'] } } }),
          'tsconfig.tsx.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/x': ['./b/x.ts'] } } }),
        },
      })
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, {
        command: process.execPath,
        args: ['--import', tsxLoaderUrl],
        env: { TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.tsx.json') },
      })

      expect(result.title).toBe('a')
      expect(result.shared).toBe(false)
    }, 30_000)

    it.skipIf(!bunAvailable)('bundles when the bundler and Bun resolve an alias to different files', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        specifier: '@/x',
        files: {
          'a/x.ts': "export const Post = { title: 'a' }\n",
          'b/x.ts': "export const Post = { title: 'b' }\n",
          'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/x': ['./a/x.ts'] } } }),
          'tsconfig.b.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/x': ['./b/x.ts'] } } }),
        },
      })

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: 'bun', args: ['--tsconfig-override', 'tsconfig.b.json'], env: {} })

      expect(result.title).toBe('a')
      expect(result.shared).toBe(false)
    }, 30_000)
  })

  describe('detects tsx passed through NODE_OPTIONS', () => {
    it('keeps an extensionless relative import native and shares the instance, under NODE_OPTIONS=--import tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        definition: "import { label } from './label'\nexport const job = { title: label }\n",
        files: { 'jobs/label.ts': "export const label = 'label'\n" },
      })
      await symlink(realpathSync(resolve(import.meta.dirname, '../../../node_modules/tsx')), join(projectRoot, 'node_modules/tsx'), 'dir')

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: [], env: { NODE_OPTIONS: '--import tsx' } })

      expect(result).toEqual({ title: 'label', shared: true })
    }, 30_000)
  })

  describe('preflights literal dynamic aliases', () => {
    it('bundles a definition whose literal dynamic alias import the active tsx loader cannot resolve, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        definition: "const { Post } = await import('@/models/Post')\nexport const job = { title: Post.title }\n",
        files: { 'models/Post.ts': postModule },
      })
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result).toEqual({ title: 'post', shared: false })
    }, 30_000)
  })

  describe('probes hash-prefixed tsconfig aliases', () => {
    it('bundles a #shared/ alias that the active tsx loader cannot resolve, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        specifier: '#shared/util',
        files: {
          'shared/util.ts': "export const Post = { title: 'shared' }\n",
          'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#shared/*': ['./shared/*'] } } }),
          'tsconfig.tsx.json': JSON.stringify({ compilerOptions: {} }),
        },
      })
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, {
        command: process.execPath,
        args: ['--import', tsxLoaderUrl],
        env: { TSX_TSCONFIG_PATH: join(projectRoot, 'tsconfig.tsx.json') },
      })

      expect(result).toEqual({ title: 'shared', shared: false })
    }, 30_000)
  })

  describe('checks TypeScript definitions under plain Node without experimental APIs', () => {
    const firstSource = "import { appendFileSync } from 'node:fs'\nappendFileSync(process.env.HOLO_SIDE_EFFECT_LOG as string, 'first ran\\n')\nexport const first = { name: 'first' as string }\n"

    async function runPlainNodeDefinitionChild(projectRoot: string, definitionPaths: readonly string[]): Promise<{ shared: boolean, lazy?: number, stderr: string }> {
      const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
      const childPath = join(projectRoot, 'child.mjs')
      await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const paths = ${JSON.stringify(definitionPaths)}
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, paths)
const loaded = await Promise.all(paths.map(path => importDefinition(path)))
const direct = await import(${JSON.stringify(pathToFileURL(definitionPaths[0]!).href)})
const lazy = typeof loaded[0].load === 'function' ? (await loaded[0].load()).color : undefined
console.log(JSON.stringify({ shared: loaded[0].first === direct.first, lazy }))
`)
      const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
      const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
      const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '', ESBUILD_BINARY_PATH: esbuildBinary, HOLO_SIDE_EFFECT_LOG: join(projectRoot, 'side-effects.log') }
      delete env.TSX_TSCONFIG_PATH
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [childPath], { cwd: projectRoot, env })
      return { ...JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { shared: boolean, lazy?: number }, stderr }
    }

    it('loads erasable definitions natively and prints no ExperimentalWarning', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: firstSource })
      const secondPath = join(projectRoot, 'jobs/second.ts')
      await writeFile(secondPath, "import { label } from './label.ts'\nexport const second = { label }\n")
      await writeFile(join(projectRoot, 'jobs/label.ts'), "export const label: string = 'label'\n")

      const result = await runPlainNodeDefinitionChild(projectRoot, [definitionPath, secondPath])

      expect(result.shared).toBe(true)
      expect(result.stderr).not.toContain('ExperimentalWarning')
      expect(await readSideEffectLog(projectRoot)).toEqual(['first ran'])
    }, 30_000)

    it('bundles when a later definition uses syntax Node cannot strip, without running the earlier one natively first', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: firstSource })
      const secondPath = join(projectRoot, 'jobs/second.ts')
      await writeFile(secondPath, 'enum Color { Red }\nexport const second = { color: Color.Red }\n')

      const result = await runPlainNodeDefinitionChild(projectRoot, [definitionPath, secondPath])

      expect(result.shared).toBe(false)
      expect(result.stderr).not.toContain('ExperimentalWarning')
      expect(await readSideEffectLog(projectRoot)).toEqual(['first ran', 'first ran'])
    }, 30_000)

    it('bundles when only a dynamically imported module uses syntax Node cannot strip', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({
        definition: `${firstSource}export const load = () => import('./lazy.ts')\n`,
        files: { 'jobs/lazy.ts': 'enum Color { Red = 7 }\nexport const color = Color.Red\n' },
      })

      const result = await runPlainNodeDefinitionChild(projectRoot, [definitionPath])

      expect(result).toMatchObject({ shared: false, lazy: 7 })
      expect(result.stderr).not.toContain('ExperimentalWarning')
    }, 30_000)
  })

  describe('keeps package-scoped imports native', () => {
    const packageImportsManifest = { type: 'module', imports: { '#internal': './internal.ts' } }

    it('keeps an ESM definition that imports a # subpath native, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: "import { label } from '#internal'\nexport const job = { title: label }\n" })
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify(packageImportsManifest))
      await writeFile(join(projectRoot, 'internal.ts'), "export const label = 'internal'\n")
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result).toEqual({ title: 'internal', shared: true })
    }, 30_000)

    it.skipIf(!bunAvailable)('keeps an ESM definition that imports a # subpath native, under Bun', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: "import { label } from '#internal'\nexport const job = { title: label }\n" })
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify(packageImportsManifest))
      await writeFile(join(projectRoot, 'internal.ts'), "export const label = 'internal'\n")

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: 'bun', args: [], env: {} })

      expect(result).toEqual({ title: 'internal', shared: true })
    }, 30_000)

    it('keeps an ESM definition that imports a # pattern declared in package imports native, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: "import { label } from '#lib/util'\nexport const job = { title: label }\n" })
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ type: 'module', imports: { '#lib/*': './lib/*.ts' } }))
      await mkdir(join(projectRoot, 'lib'), { recursive: true })
      await writeFile(join(projectRoot, 'lib/util.ts'), "export const label = 'pattern'\n")
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result).toEqual({ title: 'pattern', shared: true })
    }, 30_000)

    it('keeps an ESM definition native when its package is installed only in a node_modules next to it, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: "import { value } from 'nested-dep'\nexport const job = { title: value }\n" })
      const dependencyRoot = join(projectRoot, 'jobs/node_modules/nested-dep')
      await mkdir(dependencyRoot, { recursive: true })
      await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: 'nested-dep', type: 'module', main: './index.mjs' }))
      await writeFile(join(dependencyRoot, 'index.mjs'), "export const value = 'nested'\n")
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result).toEqual({ title: 'nested', shared: true })
    }, 30_000)

    it('keeps an ESM definition native when it imports its own package by name through exports, under tsx', async () => {
      const { projectRoot, definitionPath } = await createAliasDefinitionProject({ definition: "import { value } from 'self-app/jobs/x'\nexport const job = { title: value }\n" })
      await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'self-app', type: 'module', exports: { './jobs/*': './jobs/*.ts' } }))
      await writeFile(join(projectRoot, 'jobs/x.ts'), "export const value = 'self'\n")
      const tsxLoaderUrl = pathToFileURL(resolve(import.meta.dirname, '../../../node_modules/tsx/dist/loader.mjs')).href

      const result = await runAliasDefinitionChild(projectRoot, definitionPath, { command: process.execPath, args: ['--import', tsxLoaderUrl], env: {} })

      expect(result).toEqual({ title: 'self', shared: true })
    }, 30_000)
  })

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
    await writeFile(definitionPath, "export { defineAppConfig } from '@holo-js/config'\nexport const source = import.meta.url\nexport const evaluatedFrom = new Error().stack\n")
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const runtimeConfigUrl = pathToFileURL(resolve(import.meta.dirname, '../node_modules/@holo-js/config/dist/index.mjs')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const runtimeConfig = await import(${JSON.stringify(runtimeConfigUrl)})
const importDefinition = await runtimeModule.loadProjectDefinitionRuntimeModules(${JSON.stringify(projectRoot)}, [${JSON.stringify(definitionPath)}])
const definition = await importDefinition(${JSON.stringify(definitionPath)})
console.log(JSON.stringify({ bridged: definition.defineAppConfig === runtimeConfig.defineAppConfig, source: definition.source, evaluatedFrom: definition.evaluatedFrom }))
`)
    const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
    const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
    const childEnv: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_PRESERVE_SYMLINKS: '', ESBUILD_BINARY_PATH: esbuildBinary, ...env }
    const { stdout } = await promisify(execFile)(process.execPath, [...args, '--experimental-strip-types', childPath], { cwd: projectRoot, env: childEnv })
    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { bridged: boolean, source: string, evaluatedFrom: string }

    expect(result.bridged).toBe(true)
    expect(result.source).toBe(pathToFileURL(realpathSync(definitionPath)).href)
    expect(result.evaluatedFrom.includes('/.holo-js/runtime/')).toBe(bundled)
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

  it('maps bundled modules back to their sources for stack traces and V8 coverage', async () => {
    const projectRoot = await realpath(await createTempProject())
    const abilityPath = join(projectRoot, 'server/abilities/manage-tenants.ts')
    await mkdir(dirname(abilityPath), { recursive: true })
    await writeFile(abilityPath, "type Tenant = { id: number }\nexport function manageTenants(tenant: Tenant): never {\n  throw new Error(`denied ${tenant.id}`)\n}\n")
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const ability = await runtimeModule.importBundledRuntimeModule(${JSON.stringify(projectRoot)}, ${JSON.stringify(abilityPath)})
try { ability.manageTenants({ id: 7 }) } catch (error) { console.log(JSON.stringify({ stack: error.stack })) }
`)
    const coverageDir = join(projectRoot, 'coverage')
    const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
    const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: coverageDir, ESBUILD_BINARY_PATH: esbuildBinary }
    const { stdout } = await promisify(execFile)(process.execPath, ['--enable-source-maps', childPath], { cwd: projectRoot, env })

    const { stack } = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { stack: string }
    expect(stack).toContain(`${abilityPath}:3:`)
    const coverage = await Promise.all((await readdir(coverageDir)).map(async name => JSON.parse(await readFile(join(coverageDir, name), 'utf8')) as {
      'source-map-cache'?: Record<string, { data: { sources: string[] } }>
    }))
    const mappedSources = coverage.flatMap(report => Object.entries(report['source-map-cache'] ?? {}))
      .filter(([url]) => url.includes('/.holo-js/runtime/bundle-'))
      .flatMap(([url, entry]) => entry.data.sources.map(source => new URL(source, url).pathname))
    expect(mappedSources).toContain(abilityPath)
  }, 30_000)

  it('keeps source positions when bundled modules read import.meta.url', async () => {
    const projectRoot = await realpath(await createTempProject())
    const abilityPath = join(projectRoot, 'server/abilities/locate.ts')
    await mkdir(dirname(abilityPath), { recursive: true })
    const source = "type Tenant = { id: number }\nexport const origin = import.meta\n  .url\nexport function locate(tenant: Tenant): never {\n  const { url: where } = import.meta; throw new Error(`denied ${tenant.id} ${where === origin}`)\n}\n"
    await writeFile(abilityPath, source)
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
const ability = await runtimeModule.importBundledRuntimeModule(${JSON.stringify(projectRoot)}, ${JSON.stringify(abilityPath)})
try { ability.locate({ id: 7 }) } catch (error) { console.log(JSON.stringify({ origin: ability.origin, message: error.message, stack: error.stack })) }
`)
    const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
    const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', ESBUILD_BINARY_PATH: esbuildBinary }
    const { stdout } = await promisify(execFile)(process.execPath, ['--enable-source-maps', childPath], { cwd: projectRoot, env })

    const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as { origin: string, message: string, stack: string }
    const throwLine = source.split('\n')[4]!
    expect(result.origin).toBe(pathToFileURL(abilityPath).href)
    expect(result.message).toBe('denied 7 true')
    expect(result.stack).toContain(`${abilityPath}:5:${throwLine.indexOf('new Error') + 1}`)
  }, 30_000)

  it('rewrites import.meta.url without colliding with module bindings', async () => {
    const projectRoot = await realpath(await createTempProject())
    const entryPath = join(projectRoot, 'server/jobs/collide.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "const __holoMetaUrl = 'binding'\nconst __holoUrl0000 = 'other'\nexport const url = import.meta.url\nexport function read(__holoUrl0001: string) { return [__holoUrl0001, import.meta.url] }\nexport const bindings = [__holoMetaUrl, __holoUrl0000]\n")
    const loaded = await importBundledRuntimeModule(projectRoot, entryPath) as { url: string, read(value: string): string[], bindings: string[] }
    const sourceUrl = pathToFileURL(entryPath).href
    expect(loaded.url).toBe(sourceUrl)
    expect(loaded.read('parameter')).toEqual(['parameter', sourceUrl])
    expect(loaded.bindings).toEqual(['binding', 'other'])
  })

  it('loads Holo packages installed only in the application from the application', async () => {
    const projectRoot = await realpath(await createTempProject())
    const packageRoot = join(projectRoot, 'node_modules/@holo-js/app-only-fixture')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-fixture', type: 'module', exports: { '.': './index.mjs' } }))
    await writeFile(join(packageRoot, 'index.mjs'), "export const origin = 'application'\n")
    const entryPath = join(projectRoot, 'server/jobs/app-only.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "import { origin } from '@holo-js/app-only-fixture'\nexport default { origin }\n")
    const loaded = await importBundledRuntimeModule(projectRoot, entryPath) as { default: { origin: string } }
    expect(loaded.default).toEqual({ origin: 'application' })
  })

  it('fails loudly when a Holo package installed only in the application brings its own copy of a runtime package', async () => {
    const projectRoot = await realpath(await createTempProject())
    const packageRoot = join(projectRoot, 'node_modules/@holo-js/app-only-split')
    const nestedDbRoot = join(packageRoot, 'node_modules/@holo-js/db')
    await mkdir(nestedDbRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-split', type: 'module', exports: { '.': './index.mjs' }, dependencies: { '@holo-js/db': '*' } }))
    await writeFile(join(packageRoot, 'index.mjs'), "import { Entity } from '@holo-js/db'\nexport class PluginEntity extends Entity {}\n")
    await writeFile(join(nestedDbRoot, 'package.json'), JSON.stringify({ name: '@holo-js/db', type: 'module', exports: { '.': './index.mjs' } }))
    await writeFile(join(nestedDbRoot, 'index.mjs'), 'export class Entity {}\n')
    const entryPath = join(projectRoot, 'server/models/plugin.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "import { PluginEntity } from '@holo-js/app-only-split'\nexport default PluginEntity\n")

    await expect(importBundledRuntimeModule(projectRoot, entryPath)).rejects.toThrow('"@holo-js/app-only-split" uses its own copy of "@holo-js/db"')
  })

  it('fails loudly when a subpath-only application Holo package brings its own copy of a runtime package', async () => {
    const projectRoot = await realpath(await createTempProject())
    const packageRoot = join(projectRoot, 'node_modules/@holo-js/app-only-subpath')
    const nestedDbRoot = join(packageRoot, 'node_modules/@holo-js/db')
    await mkdir(nestedDbRoot, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-subpath', type: 'module', exports: { './job': './job.mjs' }, dependencies: { '@holo-js/db': '*' } }))
    await writeFile(join(packageRoot, 'job.mjs'), "import { Entity } from '@holo-js/db/entity'\nexport class PluginEntity extends Entity {}\n")
    await writeFile(join(nestedDbRoot, 'package.json'), JSON.stringify({ name: '@holo-js/db', type: 'module', exports: { './entity': './entity.mjs' } }))
    await writeFile(join(nestedDbRoot, 'entity.mjs'), 'export class Entity {}\n')
    const entryPath = join(projectRoot, 'server/models/subpath-plugin.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "import { PluginEntity } from '@holo-js/app-only-subpath/job'\nexport default PluginEntity\n")

    await expect(importBundledRuntimeModule(projectRoot, entryPath)).rejects.toThrow('"@holo-js/app-only-subpath" uses its own copy of "@holo-js/db"')
  })

  it('reports the resolution error instead of loading another copy when the importer cannot import an application Holo package', async () => {
    const projectRoot = await realpath(await createTempProject())
    const outerRoot = join(projectRoot, 'node_modules/@holo-js/app-only-blocked')
    const dependencyRoot = join(projectRoot, 'node_modules/@acme/jobs')
    const nestedRoot = join(dependencyRoot, 'node_modules/@holo-js/app-only-blocked')
    await mkdir(outerRoot, { recursive: true })
    await mkdir(nestedRoot, { recursive: true })
    await writeFile(join(outerRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-blocked', type: 'module', exports: { '.': './index.mjs' } }))
    await writeFile(join(outerRoot, 'index.mjs'), "export const origin = 'outer'\n")
    await writeFile(join(nestedRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-blocked', type: 'module', exports: { './job': './job.mjs' } }))
    await writeFile(join(nestedRoot, 'job.mjs'), "export const origin = 'nested'\n")
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: '@acme/jobs', type: 'module', exports: { '.': './job.mjs' } }))
    await writeFile(join(dependencyRoot, 'job.mjs'), "export { origin } from '@holo-js/app-only-blocked'\n")

    await expect(importBundledRuntimeModule(projectRoot, join(dependencyRoot, 'job.mjs'))).rejects.toThrow(/not exported|No "exports" main/)
  })

  it('loads an application-only Holo package from the dependency that imports it', async () => {
    const projectRoot = await realpath(await createTempProject())
    const dependencyRoot = join(projectRoot, 'node_modules/@acme/jobs')
    const nestedRoot = join(dependencyRoot, 'node_modules/@holo-js/app-only-nested')
    await mkdir(nestedRoot, { recursive: true })
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: '@acme/jobs', type: 'module', exports: { '.': './job.mjs' } }))
    await writeFile(join(dependencyRoot, 'job.mjs'), "export { origin } from '@holo-js/app-only-nested'\n")
    await writeFile(join(nestedRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-nested', type: 'module', exports: { '.': { types: './index.d.ts', import: './index.mjs' } } }))
    await writeFile(join(nestedRoot, 'index.mjs'), "export const origin = 'nested'\n")

    const loaded = await importBundledRuntimeModule(projectRoot, join(dependencyRoot, 'job.mjs')) as { origin: string }
    expect(loaded.origin).toBe('nested')
  })

  it.each([
    { label: 'the most specific wildcard export', manifest: { exports: { './*': './generic/*.mjs', './jobs/*': './jobs/*.mjs' } }, files: { 'generic/jobs/foo.mjs': "export const origin = 'generic'\n", 'jobs/foo.mjs': "export const origin = 'specific'\n" }, specifier: '@holo-js/app-only-exports/jobs/foo', origin: 'specific' },
    { label: 'a legacy main directory', manifest: { main: './lib' }, files: { 'lib/index.js': "export const origin = 'legacy main'\n" }, specifier: '@holo-js/app-only-exports', origin: 'legacy main' },
    { label: 'a null exports field', manifest: { exports: null, main: './entry.mjs' }, files: { 'entry.mjs': "export const origin = 'null exports'\n", 'deep.mjs': "export const origin = 'null exports subpath'\n" }, specifier: '@holo-js/app-only-exports/deep.mjs', origin: 'null exports subpath' },
    { label: 'a blocked condition', manifest: { exports: { '.': { node: null, default: './browser.mjs' } } }, files: { 'browser.mjs': "export const origin = 'browser'\n" }, specifier: '@holo-js/app-only-exports', origin: undefined },
  ])('resolves an application-only Holo package through $label as Node does', async ({ manifest, files, specifier, origin }) => {
    const projectRoot = await realpath(await createTempProject())
    const dependencyRoot = join(projectRoot, 'node_modules/@acme/jobs')
    const packageRoot = join(dependencyRoot, 'node_modules/@holo-js/app-only-exports')
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(dependencyRoot, 'package.json'), JSON.stringify({ name: '@acme/jobs', type: 'module', exports: { '.': './job.mjs' } }))
    await writeFile(join(dependencyRoot, 'job.mjs'), `export { origin } from ${JSON.stringify(specifier)}\n`)
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-exports', type: 'module', ...manifest }))
    for (const [file, contents] of Object.entries(files)) {
      await mkdir(dirname(join(packageRoot, file)), { recursive: true })
      await writeFile(join(packageRoot, file), contents)
    }

    const loading = importBundledRuntimeModule(projectRoot, join(dependencyRoot, 'job.mjs')) as Promise<{ origin: string }>
    if (origin === undefined) await expect(loading).rejects.toThrow()
    else expect((await loading).origin).toBe(origin)
  })

  it('accepts an application-only Holo package that uses the runtime package copy the runtime registered from the project', async () => {
    const projectRoot = await realpath(await createTempProject())
    const configRoot = join(projectRoot, 'node_modules/@holo-js/config')
    const packageRoot = join(projectRoot, 'node_modules/@holo-js/app-only-config')
    await mkdir(configRoot, { recursive: true })
    await mkdir(packageRoot, { recursive: true })
    await writeFile(join(configRoot, 'package.json'), JSON.stringify({ name: '@holo-js/config', type: 'module', exports: { '.': './index.mjs' } }))
    await writeFile(join(configRoot, 'index.mjs'), "export const copy = 'project'\n")
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@holo-js/app-only-config', type: 'module', exports: { '.': './index.mjs' }, dependencies: { '@holo-js/config': '*' } }))
    await writeFile(join(packageRoot, 'index.mjs'), "export { copy } from '@holo-js/config'\n")
    const entryPath = join(projectRoot, 'server/jobs/config-copy.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, "export { copy } from '@holo-js/app-only-config'\n")
    const runtimeModuleUrl = pathToFileURL(resolve(import.meta.dirname, '../src/runtimeModule.ts')).href
    const childPath = join(projectRoot, 'child.mjs')
    await writeFile(childPath, `
const runtimeModule = await import(${JSON.stringify(runtimeModuleUrl)})
await runtimeModule.importOptionalRuntimeModule('@holo-js/config', { projectRoot: ${JSON.stringify(projectRoot)} })
const loaded = await runtimeModule.importBundledRuntimeModule(${JSON.stringify(projectRoot)}, ${JSON.stringify(entryPath)})
console.log(JSON.stringify({ copy: loaded.copy }))
`)
    const esbuildPackage = realpathSync(resolve(import.meta.dirname, '../node_modules/esbuild'))
    const esbuildBinary = join(esbuildPackage, '..', '@esbuild', `${process.platform}-${process.arch}`, 'bin', 'esbuild')
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: '', ESBUILD_BINARY_PATH: esbuildBinary }
    const { stdout } = await promisify(execFile)(process.execPath, [childPath], { cwd: projectRoot, env })

    expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '')).toEqual({ copy: 'project' })
  }, 30_000)

  it('leaves modules that never read import.meta to the bundler', async () => {
    const projectRoot = await realpath(await createTempProject())
    const metadataPath = join(projectRoot, 'server/support/metadata.ts')
    const metaPath = join(projectRoot, 'server/support/meta.ts')
    await mkdir(dirname(metadataPath), { recursive: true })
    await writeFile(metadataPath, "export const metadata = { metafile: true }\n")
    await writeFile(metaPath, 'export const url = import.meta.url\n')
    const onLoad: Array<(args: { path: string }) => Promise<{ contents: string } | undefined>> = []
    sourceModuleUrlInternals.createSourceModuleUrlPlugin().setup({ onLoad: (_options: unknown, callback: (args: { path: string }) => Promise<{ contents: string } | undefined>) => onLoad.push(callback) } as never)

    await expect(onLoad[0]!({ path: metadataPath })).resolves.toBeUndefined()
    expect((await onLoad[0]!({ path: metaPath }))?.contents).toContain(JSON.stringify(pathToFileURL(metaPath).href))
    const commentHeavyPath = join(projectRoot, 'server/support/comment-heavy.ts')
    await writeFile(commentHeavyPath, `import ${'/* x */ '.repeat(64)}{ readFile } from 'node:fs'\n// ${'/'.repeat(64)}\nexport { readFile }\n`)
    await expect(onLoad[0]!({ path: commentHeavyPath })).resolves.toBeUndefined()
    for (const [name, expression] of [['block', 'import /* a */ . /* b */ meta.url'], ['line', 'import // a\n.meta.url'], ['starred', 'import /** a **/ . /*/ b */ meta.url']]) {
      const commentedPath = join(projectRoot, `server/support/commented-${name}.ts`)
      await writeFile(commentedPath, `export const url = ${expression}\n`)
      expect((await onLoad[0]!({ path: commentedPath }))?.contents).toContain(JSON.stringify(pathToFileURL(commentedPath).href))
    }
  })

  it('rewrites every import.meta url read and leaves assignment targets alone', async () => {
    const projectRoot = await realpath(await createTempProject())
    const entryPath = join(projectRoot, 'server/jobs/meta-forms.ts')
    await mkdir(dirname(entryPath), { recursive: true })
    await writeFile(entryPath, [
      'const __holoMeta\\u0055rl = (value: string) => value',
      "export const escaped = __holoMeta\\u0055rl('escaped')",
      "export const element = import.meta['url']",
      'const { url: destructured } = import.meta',
      'export { destructured }',
      'const { url: asserted } = <ImportMeta>import.meta',
      'export { asserted }',
      'export const directory = import.meta.dirname',
      "export const file = import.meta['filename']",
      'const { dirname: destructuredDirectory, filename: destructuredFile } = import.meta',
      'export { destructuredDirectory, destructuredFile }',
      'export function assign(value: string) { try { import.meta.url = value } catch { return \'rejected\' } return import.meta.url }',
      'export const dotted = import.meta.url',
      '',
    ].join('\n'))
    const loaded = await importBundledRuntimeModule(projectRoot, entryPath) as { escaped: string, element: string, destructured: string, asserted: string, dotted: string, directory: string, file: string, destructuredDirectory: string, destructuredFile: string, assign(value: string): string }
    const sourceUrl = pathToFileURL(entryPath).href
    expect(loaded.escaped).toBe('escaped')
    expect(loaded.element).toBe(sourceUrl)
    expect(loaded.destructured).toBe(sourceUrl)
    expect(loaded.asserted).toBe(sourceUrl)
    expect(loaded.directory).toBe(dirname(entryPath))
    expect(loaded.file).toBe(entryPath)
    expect(loaded.destructuredDirectory).toBe(dirname(entryPath))
    expect(loaded.destructuredFile).toBe(entryPath)
    expect(loaded.dotted).toBe(sourceUrl)
    expect(typeof loaded.assign('file:///elsewhere')).toBe('string')
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
