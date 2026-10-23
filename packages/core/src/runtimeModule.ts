import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BuildOptions, BuildResult, Plugin } from 'esbuild'
import * as holoConfigModule from '@holo-js/config'
import * as holoDbModule from '@holo-js/db'
import * as holoKernelModule from '@holo-js/kernel'

type EsbuildModule = {
  build(options: BuildOptions): Promise<BuildResult>
}

const builtinModuleImporters = new Map<string, () => Promise<unknown>>([
  ['@holo-js/auth', () => import('@holo-js/auth')],
  ['@holo-js/auth-clerk', () => import('@holo-js/auth-clerk')],
  ['@holo-js/auth-social', () => import('@holo-js/auth-social')],
  ['@holo-js/auth-workos', () => import('@holo-js/auth-workos')],
  ['@holo-js/authorization', () => import('@holo-js/authorization')],
  ['@holo-js/broadcast', () => import('@holo-js/broadcast')],
  ['@holo-js/cache', () => import('@holo-js/cache')],
  ['@holo-js/events', () => import('@holo-js/events')],
  ['@holo-js/mail', () => import('@holo-js/mail')],
  ['@holo-js/media', () => import('@holo-js/media')],
  ['@holo-js/notifications', () => import('@holo-js/notifications')],
  ['@holo-js/queue', () => import('@holo-js/queue')],
  ['@holo-js/security', () => import('@holo-js/security')],
  ['@holo-js/security/drivers/redis-adapter', () => import('@holo-js/security/drivers/redis-adapter')],
  ['@holo-js/session', () => import('@holo-js/session')],
  ['@holo-js/session/drivers/redis-adapter', () => import('@holo-js/session/drivers/redis-adapter')],
  ['@holo-js/storage', () => import('@holo-js/storage')],
  ['@holo-js/storage/runtime', () => import('@holo-js/storage/runtime')],
])

async function importModule<TModule>(specifier: string): Promise<TModule> {
  const importBuiltin = builtinModuleImporters.get(specifier)
  if (importBuiltin) return importBuiltin() as Promise<TModule>
  return import(/* @vite-ignore */ /* webpackIgnore: true */ specifier) as Promise<TModule>
}

const runtimeModuleRequire = nodeModule.createRequire(import.meta.url)

function resolveRuntimeModuleSearchPaths(
  projectRoot: string,
  runtimeModuleUrl: string = import.meta.url,
): readonly string[] | undefined {
  const runtimeModulePath = normalizeImportTarget(runtimeModuleUrl)
  return runtimeModulePath.includes('/node_modules/@holo-js/core/')
    ? undefined
    : [projectRoot]
}

function resolveOptionalImportSpecifier(specifier: string, projectRoot?: string): string | undefined {
  if (!projectRoot) {
    return specifier
  }

  try {
    const paths = resolveRuntimeModuleSearchPaths(projectRoot)
    const resolved = paths
      ? runtimeModuleRequire.resolve(specifier, { paths: [...paths] })
      : runtimeModuleRequire.resolve(specifier)
    return existsSync(resolved) ? pathToFileURL(resolved).href : undefined
  } catch (error) {
    const failedTarget = getMissingModuleTarget(getErrorMessage(error))
    const packageRootSpecifier = resolvePackageRootSpecifier(specifier)
    return matchesPackageImportTarget(failedTarget, specifier)
      || (!packageRootSpecifier && isMissingOptionalModule(error, specifier, specifier))
      ? undefined
      : specifier
  }
}

function getErrorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : ''
}

function getMissingModuleTarget(message: string): string | undefined {
  const match = message.match(/Cannot find package '([^']+)'|Cannot find module '([^']+)'|Failed to load url ([^ ]+)|Could not resolve "([^"]+)"/)
  return match?.slice(1).find((value): value is string => typeof value === 'string')
}

function normalizeImportSpecifier(specifier: string): string {
  return specifier.startsWith('file://') ? fileURLToPath(specifier) : specifier
}

function normalizeImportTarget(value: string): string {
  return normalizeImportSpecifier(value).replace(/\\/g, '/')
}

function resolvePackageRootSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('@')) {
    const [scope, packageName] = specifier.split('/')
    return scope && packageName ? `${scope}/${packageName}` : undefined
  }

  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) {
    return undefined
  }

  return specifier.split('/')[0]
}

function matchesRelativeImportTarget(failedTarget: string | undefined, specifier: string): boolean {
  if (!failedTarget || !specifier.startsWith('.')) {
    return false
  }

  const suffix = specifier.startsWith('./') ? specifier.slice(2) : specifier
  return normalizeImportTarget(failedTarget).endsWith(`/${suffix}`)
}

function matchesPackageImportTarget(failedTarget: string | undefined, specifier: string): boolean {
  const packageRootSpecifier = resolvePackageRootSpecifier(specifier)
  if (!failedTarget || !packageRootSpecifier) return false
  return normalizeImportTarget(failedTarget).includes(`/node_modules/${packageRootSpecifier}/`)
}

function isMissingOptionalModule(error: unknown, specifier: string, resolvedSpecifier: string): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const message = getErrorMessage(error)
  const failedTarget = getMissingModuleTarget(message)
  const expectedTargets = new Set<string>([
    specifier,
    resolvedSpecifier,
    normalizeImportTarget(specifier),
    normalizeImportTarget(resolvedSpecifier),
  ])
  const packageRootSpecifier = resolvePackageRootSpecifier(specifier)
  if (packageRootSpecifier) {
    expectedTargets.add(packageRootSpecifier)
  }
  const normalizedFailedTarget = typeof failedTarget === 'string' ? normalizeImportTarget(failedTarget) : undefined
  const matchesRequestedTarget = typeof normalizedFailedTarget === 'string'
    && (
      expectedTargets.has(normalizedFailedTarget)
      || matchesRelativeImportTarget(normalizedFailedTarget, specifier)
    )

  return (
    ('code' in error && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND' && matchesRequestedTarget)
    || (message.startsWith('Cannot find package \'') && matchesRequestedTarget)
    || (message.startsWith('Cannot find module \'') && matchesRequestedTarget)
    || (message.includes('Does the file exist?') && message.startsWith('Failed to load url ') && matchesRequestedTarget)
    || (message.startsWith('Could not resolve "') && matchesRequestedTarget)
  )
}

export async function importOptionalRuntimeModule<TModule>(
  specifier: string,
  options: {
    readonly projectRoot?: string
  } = {},
): Promise<TModule | undefined> {
  const resolvedSpecifier = resolveOptionalImportSpecifier(specifier, options.projectRoot)
  if (!resolvedSpecifier) return undefined

  try {
    const loaded = await importModule<TModule>(resolvedSpecifier)
    registerRuntimeModuleInstance(specifier, loaded as Record<string, unknown>)
    return loaded
  } catch (error) {
    if (isMissingOptionalModule(error, specifier, resolvedSpecifier)) {
      return undefined
    }

    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function writeLoaderTsconfig(projectRoot: string, tempDir: string): Promise<string> {
  const projectTsconfigPath = join(projectRoot, 'tsconfig.json')
  if (await pathExists(projectTsconfigPath)) {
    return projectTsconfigPath
  }

  const tsconfigPath = join(tempDir, 'tsconfig.json')
  const contents = JSON.stringify({
    compilerOptions: {
      baseUrl: projectRoot,
      paths: {
        '~/*': ['./*'],
        '@/*': ['./*'],
      },
    },
  }, null, 2)

  await writeFile(tsconfigPath, `${contents}\n`, 'utf8')
  return tsconfigPath
}

const runtimeInstanceNamespace = 'holo-runtime-instance'
const runtimeCopyId = randomUUID()

type RuntimeModuleInstances = Map<string, Record<string, unknown>>

function runtimeModuleInstancesSlot(): string {
  return `holo-js.runtime.moduleInstances.${runtimeCopyId}`
}

function runtimeModuleInstances(): RuntimeModuleInstances {
  const registry = globalThis as typeof globalThis & Record<symbol, RuntimeModuleInstances | undefined>
  const slot = Symbol.for(runtimeModuleInstancesSlot())
  registry[slot] ??= new Map()
  return registry[slot]
}

function registerRuntimeModuleInstance(specifier: string, instance: Record<string, unknown>): void {
  runtimeModuleInstances().set(specifier, instance)
}

function runtimeInstanceModuleSource(specifier: string, instance: Record<string, unknown>): string {
  const lines = [`const instance = globalThis[Symbol.for(${JSON.stringify(runtimeModuleInstancesSlot())})].get(${JSON.stringify(specifier)})`]
  Object.keys(instance).forEach((name, index) => {
    lines.push(`const value${index} = instance[${JSON.stringify(name)}]`)
    lines.push(`export { value${index} as ${JSON.stringify(name)} }`)
  })

  return lines.join('\n')
}

function resolveHoloPackageFromRuntime(specifier: string): string {
  try {
    return import.meta.resolve(specifier)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(`[@holo-js/core] "${specifier}" is imported by app code but is not installed alongside the Holo runtime, so it cannot share the runtime's instances. Install it in the same node_modules as @holo-js/core.`)
    }

    throw error
  }
}

function bridgeRuntimeModuleInstances(): Plugin {
  return {
    name: 'holo-runtime-module-instances',
    setup(build) {
      build.onResolve({ filter: /^@holo-js\// }, args => (
        runtimeModuleInstances().has(args.path)
          ? { path: args.path, namespace: runtimeInstanceNamespace }
          : { path: resolveHoloPackageFromRuntime(args.path), external: true }
      ))
      build.onLoad({ filter: /.*/, namespace: runtimeInstanceNamespace }, args => ({
        contents: runtimeInstanceModuleSource(args.path, runtimeModuleInstances().get(args.path) ?? {}),
        loader: 'js',
      }))
    },
  }
}

registerRuntimeModuleInstance('@holo-js/config', holoConfigModule)
registerRuntimeModuleInstance('@holo-js/db', holoDbModule)
registerRuntimeModuleInstance('@holo-js/kernel', holoKernelModule)

async function bundleRuntimeModule(
  projectRoot: string,
  entryPath: string,
  metafile = false,
): Promise<{ path: string, metafile: BuildResult['metafile'], cleanup(): Promise<void> }> {
  const runtimeTempRoot = join(projectRoot, '.holo-js', 'runtime')
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'bundle-'))
  const tsconfigPath = await writeLoaderTsconfig(projectRoot, tempDir)
  const outfile = join(tempDir, `${basename(entryPath, extname(entryPath))}.mjs`)

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  try {
    const result = await runtimeModuleInternals.runEsbuild({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: [entryPath],
      outfile,
      format: 'esm',
      logLevel: 'silent',
      packages: 'external',
      platform: 'node',
      plugins: [bridgeRuntimeModuleInstances()],
      target: 'node22',
      tsconfig: tsconfigPath,
      sourcemap: false,
      metafile,
    })

    return {
      path: outfile,
      metafile: result.metafile,
      cleanup,
    }
  } catch (error) {
    await cleanup()

    if (error && typeof error === 'object' && Array.isArray((error as { errors?: unknown[] }).errors)) {
      const message = (error as {
        errors: Array<{ text?: unknown, message?: unknown }>
      }).errors
        .map((entry) => {
          if (typeof entry.text === 'string' && entry.text.trim()) {
            return entry.text
          }

          if (typeof entry.message === 'string' && entry.message.trim()) {
            return entry.message
          }

          return 'Unknown build error.'
        })
        .join('\n')

      throw new Error(message)
    }

    if (error instanceof Error && error.message) {
      throw error
    }

    throw new Error(`Failed to load ${entryPath}.`)
  }
}

const definitionGraphSources = new Map<string, { readonly sources: ReadonlyMap<string, string>, readonly native: boolean }>()

function packageEntryFromBase(base: string, packageName: string): string | undefined {
  const require = nodeModule.createRequire(base)
  for (const directory of require.resolve.paths(packageName) ?? []) {
    const candidate = join(directory, packageName)
    if (!existsSync(join(candidate, 'package.json'))) continue

    try {
      return require.resolve(candidate)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') return undefined

      throw error
    }
  }

  return undefined
}

function holoPackageSharesRuntime(packageName: string, importerPath: string): boolean {
  const runtimeEntry = packageEntryFromBase(import.meta.url, packageName)
  return runtimeEntry !== undefined && runtimeEntry === packageEntryFromBase(importerPath, packageName)
}

function importRequiresBundle(
  dependency: { readonly path: string, readonly external?: boolean, readonly original?: string },
  importerPath: string,
): boolean {
  const original = dependency.original ?? dependency.path
  const holoPackage = /^@holo-js\/[^/]+/.exec(original)?.[0]
  if (holoPackage) return !holoPackageSharesRuntime(holoPackage, importerPath)

  return /^[@~]\//.test(original)
    || !dependency.external && (
      !original.startsWith('.') && !original.startsWith('file:') && !isAbsolute(original)
      || !extname(original) || extname(original) !== extname(dependency.path)
    )
}

export async function loadProjectDefinitionRuntimeModules(
  projectRoot: string,
  entryPaths: readonly string[],
): Promise<(entryPath: string) => Promise<unknown>> {
  if (!entryPaths.length) return async entryPath => { throw new Error(`No discovered definition exists at "${entryPath}".`) }
  const runtimeTempRoot = join(projectRoot, '.holo-js', 'runtime')
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'definitions-'))
  const entryPath = join(tempDir, 'definitions.mjs')
  let bundled: Awaited<ReturnType<typeof bundleRuntimeModule>> | undefined
  try {
    await writeFile(entryPath, entryPaths.map((sourcePath, index) => `export * as definition${index} from ${JSON.stringify(sourcePath)}`).join('\n'), 'utf8')
    bundled = await bundleRuntimeModule(projectRoot, entryPath, true)
    const sources = new Map<string, string>()
    const nativeSourceLoader = typeof globalThis === 'object' && 'Bun' in globalThis
      || process.execArgv.some(argument => /(?:^|[/\\])tsx[/\\]/.test(argument) || /^(?:--import=)?tsx(?:\/esm)?$/.test(argument))
    let nativeGraph = true
    for (const [inputPath, input] of Object.entries(bundled.metafile?.inputs ?? {})) {
      if (inputPath.startsWith(`${runtimeInstanceNamespace}:`)) continue
      const sourcePath = resolve(projectRoot, inputPath)
      if (sourcePath === entryPath) continue
      const source = await readFile(sourcePath, 'utf8')
      sources.set(sourcePath, source)
      if (input.imports.some(dependency => importRequiresBundle(dependency, sourcePath))) nativeGraph = false
      if (nativeSourceLoader) continue
      if (/\.[cm]?tsx?$/.test(sourcePath)) {
        if (!('typescript' in process.features) || !process.features.typescript) nativeGraph = false
        try {
          if (!nodeModule.stripTypeScriptTypes) nativeGraph = false
          else nodeModule.stripTypeScriptTypes(source)
        } catch {
          nativeGraph = false
        }
      }
    }
    const previous = definitionGraphSources.get(projectRoot)
    if (previous && (!previous.native || previous.sources.size !== sources.size || [...sources].some(([path, source]) => previous.sources.get(path) !== source))) nativeGraph = false
    definitionGraphSources.set(projectRoot, { sources, native: nativeGraph })
    if (nativeGraph) await writeFile(entryPath, entryPaths.map((sourcePath, index) => `export * as definition${index} from ${JSON.stringify(pathToFileURL(sourcePath).href)}`).join('\n'), 'utf8')
    const modules = await importModule<Record<string, unknown>>(pathToFileURL(nativeGraph ? entryPath : bundled.path).href)
    const definitions = new Map(entryPaths.map((sourcePath, index) => [sourcePath, modules[`definition${index}`]]))
    return async sourcePath => {
      if (!definitions.has(sourcePath)) throw new Error(`No discovered definition exists at "${sourcePath}".`)
      return definitions.get(sourcePath)
    }
  } finally {
    await bundled?.cleanup()
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function importBundledRuntimeModule(
  projectRoot: string,
  entryPath: string,
): Promise<unknown> {
  const bundled = await bundleRuntimeModule(projectRoot, entryPath)

  try {
    return await runtimeModuleInternals.importModule(
      `${pathToFileURL(bundled.path).href}?t=${Date.now()}`,
    )
  } finally {
    await bundled.cleanup()
  }
}

async function loadEsbuild(): Promise<EsbuildModule> {
  const module = await import(/* webpackIgnore: true */ 'esbuild') as
    | EsbuildModule
    | { default: EsbuildModule }

  if ('build' in module) {
    return module
  }

  return module.default
}

async function runEsbuild(options: BuildOptions): Promise<BuildResult> {
  const esbuild = await runtimeModuleInternals.loadEsbuild()
  return esbuild.build(options)
}

export const runtimeModuleInternals = {
  bundleRuntimeModule,
  importModule,
  importOptionalRuntimeModule,
  isMissingOptionalModule,
  loadEsbuild,
  pathExists,
  registerRuntimeModuleInstance,
  resolveRuntimeModuleSearchPaths,
  resolveOptionalImportSpecifier,
  runEsbuild,
  writeLoaderTsconfig,
}
