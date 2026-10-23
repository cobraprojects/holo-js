import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as holoConfig from '@holo-js/config'
import * as holoDb from '@holo-js/db'
import { importBundledRuntimeModule, loadProjectDefinitionRuntimeModules, runtimeModuleInternals } from '../src/runtimeModule'
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
