import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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

const NUXT_BUILD_DIRECTORY = '.nuxt'
export const NUXT_TSCONFIG_SNAPSHOT_PATH = '.holo-js/generated/nuxt-tsconfig.json'
const DEFAULT_LOADER_PATHS = { '~/*': ['./*'], '@/*': ['./*'] }

type JsonObject = Record<string, unknown>

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripJsonComments(text: string): string {
  let output = ''
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === '"') {
      const end = findStringEnd(text, index)
      output += text.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? text.length : newline
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2)
      index = close === -1 ? text.length : close + 2
      continue
    }
    output += char
    index++
  }
  return output
}

function findStringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index + 1
  }
  return text.length
}

function stripTrailingCommas(text: string): string {
  let output = ''
  let index = 0
  while (index < text.length) {
    const char = text[index] as string
    if (char === '"') {
      const end = findStringEnd(text, index)
      output += text.slice(index, end)
      index = end
      continue
    }
    if (char === ',') {
      const closing = /\s*[}\]]/y
      closing.lastIndex = index + 1
      if (closing.test(text)) {
        index++
        continue
      }
    }
    output += char
    index++
  }
  return output
}

function parseTsconfigText(text: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text))) as unknown
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

async function readProjectTsconfig(projectRoot: string): Promise<JsonObject | undefined> {
  const text = await readFile(join(projectRoot, 'tsconfig.json'), 'utf8').catch(() => undefined)
  return text === undefined ? undefined : parseTsconfigText(text)
}

function extendsEntries(config: JsonObject): string[] {
  if (typeof config.extends === 'string') return [config.extends]
  if (Array.isArray(config.extends)) return config.extends.filter((entry): entry is string => typeof entry === 'string')
  return []
}

function referencePaths(config: JsonObject): string[] {
  if (!Array.isArray(config.references)) return []
  return config.references.flatMap(reference => isRecord(reference) && typeof reference.path === 'string' ? [reference.path] : [])
}

function isInside(path: string, directory: string): boolean {
  const relativePath = relative(directory, path)
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

function isNuxtBuildPath(projectRoot: string, entry: string): boolean {
  if (!entry.startsWith('.') && !isAbsolute(entry)) return false
  return isInside(resolve(projectRoot, entry), join(projectRoot, NUXT_BUILD_DIRECTORY))
}

function usesNuxtBuildTsconfig(projectRoot: string, config: JsonObject): boolean {
  return [...extendsEntries(config), ...referencePaths(config)].some(entry => isNuxtBuildPath(projectRoot, entry))
}

function absoluteCompilerOptions(options: JsonObject, directory: string): JsonObject {
  const result: JsonObject = { ...options }
  const baseUrl = typeof options.baseUrl === 'string' ? resolve(directory, options.baseUrl) : undefined
  if (baseUrl) result.baseUrl = baseUrl
  if (isRecord(options.paths)) {
    const pathBase = baseUrl ?? directory
    result.paths = Object.fromEntries(Object.entries(options.paths).map(([alias, targets]) => [
      alias,
      Array.isArray(targets)
        ? targets.map(target => typeof target === 'string' && !isAbsolute(target) ? resolve(pathBase, target) : target)
        : targets,
    ]))
  }
  return result
}

function deriveLoaderConfig(projectRoot: string, config: JsonObject, snapshotPath: string | undefined): JsonObject {
  const entries = extendsEntries(config)
  const extendsTargets = entries.flatMap(entry => {
    if (isNuxtBuildPath(projectRoot, entry)) return snapshotPath ? [snapshotPath] : []
    return [entry.startsWith('.') ? resolve(projectRoot, entry) : entry]
  })
  const derived: JsonObject = { ...config }
  if (referencePaths(config).some(entry => isNuxtBuildPath(projectRoot, entry))) {
    delete derived.files
    delete derived.references
    if (snapshotPath && !entries.some(entry => isNuxtBuildPath(projectRoot, entry))) extendsTargets.unshift(snapshotPath)
  }
  if (extendsTargets.length === 0) {
    delete derived.extends
  } else {
    derived.extends = Array.isArray(config.extends) ? extendsTargets : extendsTargets[0]
  }

  const compilerOptions: JsonObject = isRecord(config.compilerOptions) ? { ...config.compilerOptions } : {}
  let baseUrl = typeof compilerOptions.baseUrl === 'string' ? resolve(projectRoot, compilerOptions.baseUrl) : undefined
  if (!snapshotPath) {
    baseUrl ??= projectRoot
    compilerOptions.paths = { ...DEFAULT_LOADER_PATHS, ...(isRecord(compilerOptions.paths) ? compilerOptions.paths : {}) }
  }
  if (baseUrl) {
    compilerOptions.baseUrl = baseUrl
  } else if (isRecord(compilerOptions.paths)) {
    compilerOptions.paths = absoluteCompilerOptions({ paths: compilerOptions.paths }, projectRoot).paths
  }
  derived.compilerOptions = compilerOptions
  return derived
}

async function writeLoaderTsconfig(projectRoot: string, tempDir: string): Promise<string> {
  const projectTsconfigPath = join(projectRoot, 'tsconfig.json')
  if (await pathExists(projectTsconfigPath)) {
    const config = await readProjectTsconfig(projectRoot)
    if (!config || !usesNuxtBuildTsconfig(projectRoot, config)) {
      return projectTsconfigPath
    }

    const snapshotPath = join(projectRoot, NUXT_TSCONFIG_SNAPSHOT_PATH)
    const hasSnapshot = await pathExists(snapshotPath)
    const derivedPath = join(tempDir, 'tsconfig.json')
    await writeFile(derivedPath, `${JSON.stringify(deriveLoaderConfig(projectRoot, config, hasSnapshot ? snapshotPath : undefined), null, 2)}\n`, 'utf8')
    return derivedPath
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
      throw new Error(`[@holo-js/core] "${specifier}" is imported by app code but is not installed alongside the Holo runtime, so it cannot share the runtime's instances. Install it in the same node_modules as @holo-js/core.`, { cause: error })
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

      throw new Error(message, { cause: error })
    }

    if (error instanceof Error && error.message) {
      throw error
    }

    throw new Error(`Failed to load ${entryPath}.`, { cause: error })
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

function holoImportRequiresBundle(
  dependency: { readonly path: string, readonly original?: string },
  importerPath: string,
): boolean {
  const holoPackage = /^@holo-js\/[^/]+/.exec(dependency.original ?? dependency.path)?.[0]
  return holoPackage !== undefined && !holoPackageSharesRuntime(holoPackage, importerPath)
}

function isBunRuntime(): boolean {
  return typeof globalThis === 'object' && 'Bun' in globalThis
}

const nonAliasSpecifier = /^(?:\.|\/|[a-z][a-z\d+.-]*:|@holo-js\/)/i

type MetafileImport = {
  readonly path: string
  readonly kind: string
  readonly external?: boolean
  readonly original?: string
}

function isStaticProjectImport(dependency: MetafileImport, importerPath: string): boolean {
  const specifier = dependency.original ?? dependency.path
  return (dependency.kind === 'import-statement' || dependency.kind === 'require-call')
    && !nonAliasSpecifier.test(specifier) && !packageImportsDeclares(specifier, importerPath)
}

function isDynamicAliasImport(dependency: MetafileImport, importerPath: string): boolean {
  const specifier = dependency.original ?? dependency.path
  return dependency.kind === 'dynamic-import' && dependency.external !== true
    && !nonAliasSpecifier.test(specifier) && !packageImportsDeclares(specifier, importerPath)
}

function isCommonJsSource(sourcePath: string): boolean {
  if (/\.m[jt]s$/.test(sourcePath)) return false
  if (/\.c[jt]s$/.test(sourcePath)) return true

  for (let directory = dirname(sourcePath); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, 'utf8')).type !== 'module'
    if (dirname(directory) === directory) return true
  }
}

type BunResolver = { resolveSync(specifier: string, parent: string): string }

function resolveWithActiveLoader(specifier: string, importerPath: string): string | undefined {
  try {
    if (isBunRuntime()) return (globalThis as typeof globalThis & { Bun: BunResolver }).Bun.resolveSync(specifier, dirname(importerPath))
    if (isCommonJsSource(importerPath)) return nodeModule.createRequire(importerPath).resolve(specifier)
    const url = import.meta.resolve(specifier)
    return url.startsWith('file:') ? fileURLToPath(url) : url
  } catch {
    return undefined
  }
}

function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function packageNameOf(specifier: string): string {
  const [scopeOrName = '', name] = specifier.split('/')
  return scopeOrName.startsWith('@') && name ? `${scopeOrName}/${name}` : scopeOrName
}

function nearestPackageManifest(importerPath: string): Record<string, unknown> | undefined {
  for (let directory = dirname(importerPath); ; directory = dirname(directory)) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8'))
      } catch {
        return undefined
      }
    }
    if (dirname(directory) === directory) return undefined
  }
}

function nearestPackageName(importerPath: string): string | undefined {
  const name = nearestPackageManifest(importerPath)?.name
  return typeof name === 'string' ? name : undefined
}

function packageImportsDeclares(specifier: string, importerPath: string): boolean {
  if (!specifier.startsWith('#')) return false

  const imports = nearestPackageManifest(importerPath)?.imports
  if (typeof imports !== 'object' || imports === null) return false

  return Object.keys(imports).some(key => {
    const star = key.indexOf('*')
    if (star < 0) return key === specifier
    return specifier.startsWith(key.slice(0, star)) && specifier.endsWith(key.slice(star + 1))
  })
}

function packageVisibleFrom(importerPath: string, specifier: string): boolean {
  if (nodeModule.isBuiltin(specifier)) return true

  const name = packageNameOf(specifier)
  if (nearestPackageName(importerPath) === name) return true

  for (let directory = dirname(importerPath); ; directory = dirname(directory)) {
    if (existsSync(join(directory, 'node_modules', name))) return true
    if (dirname(directory) === directory) return false
  }
}

function staticImportMatchesBundle(dependency: MetafileImport, importerPath: string, projectRoot: string): boolean {
  const specifier = dependency.original ?? dependency.path
  if (dependency.external === true && packageVisibleFrom(importerPath, specifier)) return true

  const resolved = resolveWithActiveLoader(specifier, importerPath)
  if (resolved === undefined) return false

  return dependency.external === true || samePath(resolved, resolve(projectRoot, dependency.path))
}

function importNeedsNodeResolutionBundle(
  dependency: { readonly path: string, readonly external?: boolean, readonly original?: string },
): boolean {
  const original = dependency.original ?? dependency.path
  if (/^@holo-js\//.test(original)) return false

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
    const nativeSourceLoader = isBunRuntime()
      || [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].some(argument => /(?:^|[/\\])tsx[/\\]/.test(argument) || /^(?:--import=)?tsx(?:\/esm)?$/.test(argument))
    let nativeGraph = true
    const projectImports: Array<{ readonly dependency: MetafileImport, readonly importerPath: string }> = []
    for (const [inputPath, input] of Object.entries(bundled.metafile?.inputs ?? {})) {
      if (inputPath.startsWith(`${runtimeInstanceNamespace}:`)) continue
      const sourcePath = resolve(projectRoot, inputPath)
      if (sourcePath === entryPath) continue
      const source = await readFile(sourcePath, 'utf8')
      sources.set(sourcePath, source)
      for (const dependency of input.imports) {
        if (isStaticProjectImport(dependency, sourcePath) || isDynamicAliasImport(dependency, sourcePath)) projectImports.push({ dependency, importerPath: sourcePath })
      }
      if (input.imports.some(dependency => holoImportRequiresBundle(dependency, sourcePath))) nativeGraph = false
      if (nativeSourceLoader) continue
      if (input.imports.some(dependency => importNeedsNodeResolutionBundle(dependency))) nativeGraph = false
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
    if (nativeSourceLoader && projectImports.some(({ dependency, importerPath }) => !staticImportMatchesBundle(dependency, importerPath, projectRoot))) nativeGraph = false
    const previous = definitionGraphSources.get(projectRoot)
    if (previous && (!previous.native || previous.sources.size !== sources.size || [...sources].some(([path, source]) => previous.sources.get(path) !== source))) nativeGraph = false
    definitionGraphSources.set(projectRoot, { sources, native: nativeGraph })
    const definitions = new Map<string, unknown>()
    if (nativeGraph) {
      for (const sourcePath of entryPaths) definitions.set(sourcePath, await importModule(pathToFileURL(sourcePath).href))
    } else {
      const modules = await importModule<Record<string, unknown>>(pathToFileURL(bundled.path).href)
      entryPaths.forEach((sourcePath, index) => definitions.set(sourcePath, modules[`definition${index}`]))
    }
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
  absoluteCompilerOptions,
  bundleRuntimeModule,
  usesNuxtBuildTsconfig,
  parseTsconfigText,
  readProjectTsconfig,
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
