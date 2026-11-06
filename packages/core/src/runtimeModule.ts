import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import * as nodeModule from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { BuildOptions, BuildResult, Loader, Metafile, OnResolveArgs, OnResolveResult, Plugin } from 'esbuild'
import type { Diagnostic, ExtendedConfigCacheEntry, Node as TypeScriptNode } from 'typescript'
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
    registerRuntimeModuleInstance(specifier, loaded as Record<string, unknown>, resolvedSpecifier === specifier ? undefined : resolvedSpecifier)
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
const TSCONFIG_PATHS_CACHE_PATH = '.holo-js/generated/tsconfig-paths.json'
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

const NO_INPUTS_FOUND_DIAGNOSTIC = 18003

async function readTsconfigFile(path: string): Promise<JsonObject | undefined> {
  const text = await readFile(path, 'utf8').catch(() => undefined)
  return text === undefined ? undefined : parseTsconfigText(text)
}

function tsconfigError(projectRoot: string, message: string): Error {
  return new Error(`[@holo-js/core] Cannot load ${join(projectRoot, 'tsconfig.json')} for bundling: ${message}`)
}

interface ProjectTsconfigPaths {
  readonly paths: JsonObject
  readonly baseUrl?: string
  readonly extends: readonly string[]
}

function isProjectTsconfigPaths(value: unknown): value is ProjectTsconfigPaths {
  return isRecord(value)
    && isRecord(value.paths)
    && Array.isArray(value.extends)
    && (value.baseUrl === undefined || typeof value.baseUrl === 'string')
}

function fileFingerprint(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

async function readCachedProjectTsconfigPaths(projectRoot: string): Promise<ProjectTsconfigPaths | undefined> {
  const cache = await readTsconfigFile(join(projectRoot, TSCONFIG_PATHS_CACHE_PATH))
  if (!cache || cache.projectRoot !== projectRoot || !isRecord(cache.inputs) || !isProjectTsconfigPaths(cache.result)) return undefined
  const fresh = Object.entries(cache.inputs).every(([path, fingerprint]) => fileFingerprint(path) === fingerprint)
  return fresh ? cache.result : undefined
}

async function resolveProjectTsconfigPaths(projectRoot: string): Promise<ProjectTsconfigPaths> {
  const ts = await import('typescript')
  const nuxtDirectory = join(projectRoot, NUXT_BUILD_DIRECTORY)
  const insideNuxt = (path: string) => isInside(resolve(path), nuxtDirectory)
  const inputs: Record<string, string | null> = {}
  const record = (path: string) => {
    inputs[path] = fileFingerprint(path)
  }
  const describe = (diagnostic: Diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
  const extendedConfigCache = new Map<string, ExtendedConfigCacheEntry>()
  const parsed = ts.parseJsonConfigFileContent({ extends: './tsconfig.json' }, {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    fileExists: path => insideNuxt(path) || (record(path), ts.sys.fileExists(path)),
    readFile: path => insideNuxt(path) ? '{}' : (record(path), ts.sys.readFile(path)),
    readDirectory: () => [],
  }, projectRoot, undefined, undefined, undefined, undefined, extendedConfigCache)
  const error = parsed.errors.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.code !== NO_INPUTS_FOUND_DIAGNOSTIC)
  if (error) throw tsconfigError(projectRoot, describe(error))

  const projectTsconfigPath = join(projectRoot, 'tsconfig.json').replaceAll('\\', '/')
  const configKey = ts.sys.useCaseSensitiveFileNames ? projectTsconfigPath : projectTsconfigPath.toLowerCase()
  const extendedConfigPath = extendedConfigCache.get(configKey)?.extendedConfig?.extendedConfigPath
  const options = parsed.options
  const pathsBase = options.baseUrl ?? (typeof options.pathsBasePath === 'string' ? options.pathsBasePath : projectRoot)
  const paths = options.paths ? absoluteCompilerOptions({ paths: options.paths }, pathsBase).paths : {}
  const result: ProjectTsconfigPaths = {
    paths: isRecord(paths) ? paths : {},
    baseUrl: options.baseUrl,
    extends: typeof extendedConfigPath === 'string' ? [extendedConfigPath] : extendedConfigPath ?? [],
  }
  const cachePath = join(projectRoot, TSCONFIG_PATHS_CACHE_PATH)
  await mkdir(dirname(cachePath), { recursive: true })
    .then(() => writeFile(cachePath, `${JSON.stringify({ projectRoot, inputs, result }, null, 2)}\n`, 'utf8'))
    .catch(() => {})
  return result
}

async function parseProjectTsconfigPaths(projectRoot: string): Promise<ProjectTsconfigPaths> {
  return await readCachedProjectTsconfigPaths(projectRoot) ?? await resolveProjectTsconfigPaths(projectRoot)
}

async function nuxtLoaderPaths(projectRoot: string, snapshotPath: string | undefined): Promise<JsonObject> {
  const snapshot = snapshotPath ? await readTsconfigFile(snapshotPath) : undefined
  const snapshotOptions = snapshot && isRecord(snapshot.compilerOptions) ? snapshot.compilerOptions : undefined
  if (snapshotOptions) return isRecord(snapshotOptions.paths) ? snapshotOptions.paths : {}
  const defaults = absoluteCompilerOptions({ paths: DEFAULT_LOADER_PATHS }, projectRoot).paths
  return isRecord(defaults) ? defaults : {}
}

async function deriveLoaderConfig(projectRoot: string, config: JsonObject, snapshotPath: string | undefined): Promise<JsonObject> {
  const user = await parseProjectTsconfigPaths(projectRoot)
  const entries = extendsEntries(config)
  const extendsTargets = user.extends.flatMap(entry => {
    if (isNuxtBuildPath(projectRoot, entry)) return snapshotPath ? [snapshotPath] : []
    return [entry]
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
    derived.extends = Array.isArray(config.extends) || extendsTargets.length > 1 ? extendsTargets : extendsTargets[0]
  }

  const compilerOptions: JsonObject = isRecord(config.compilerOptions) ? { ...config.compilerOptions } : {}
  const baseUrl = user.baseUrl ?? (snapshotPath ? undefined : projectRoot)
  if (baseUrl) compilerOptions.baseUrl = baseUrl
  compilerOptions.paths = { ...await nuxtLoaderPaths(projectRoot, snapshotPath), ...user.paths }
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
    await writeFile(derivedPath, `${JSON.stringify(await deriveLoaderConfig(projectRoot, config, hasSnapshot ? snapshotPath : undefined), null, 2)}\n`, 'utf8')
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

async function withLoaderTsconfig<TResult>(
  projectRoot: string,
  load: (tsconfigPath: string) => Promise<TResult>,
): Promise<TResult> {
  const tempDir = await mkdtemp(join(tmpdir(), 'holo-runtime-tsconfig-'))
  try {
    return await load(await writeLoaderTsconfig(projectRoot, tempDir))
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
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

function runtimeModuleLocations(): Map<string, string> {
  const registry = globalThis as typeof globalThis & Record<symbol, Map<string, string> | undefined>
  const slot = Symbol.for(`${runtimeModuleInstancesSlot()}.locations`)
  registry[slot] ??= new Map()
  return registry[slot]
}

function registerRuntimeModuleInstance(specifier: string, instance: Record<string, unknown>, location?: string): void {
  runtimeModuleInstances().set(specifier, instance)
  if (location) runtimeModuleLocations().set(specifier, location)
  else runtimeModuleLocations().delete(specifier)
}

function runtimeInstanceModuleSource(specifier: string, instance: Record<string, unknown>): string {
  const lines = [`const instance = globalThis[Symbol.for(${JSON.stringify(runtimeModuleInstancesSlot())})].get(${JSON.stringify(specifier)})`]
  Object.keys(instance).forEach((name, index) => {
    lines.push(`const value${index} = instance[${JSON.stringify(name)}]`)
    lines.push(`export { value${index} as ${JSON.stringify(name)} }`)
  })

  return lines.join('\n')
}

function holoPackageName(specifier: string): string {
  return specifier.split('/').slice(0, 2).join('/')
}

function readPackageManifest(packageRoot: string): Record<string, unknown> | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as unknown
    return isRecord(manifest) ? manifest : undefined
  } catch {
    return undefined
  }
}

const importerResolutionRequest = 'holo-js-importer-resolution:'

function resolveFromImporter(specifier: string, importerPath: string): string {
  if (isBunRuntime()) return pathToFileURL((globalThis as typeof globalThis & { Bun: BunResolver }).Bun.resolveSync(specifier, dirname(importerPath))).href
  const parentURL = pathToFileURL(importerPath).href
  const hooks = nodeModule.registerHooks({
    resolve(request, context, nextResolve) {
      return request === importerResolutionRequest
        ? nextResolve(specifier, { ...context, parentURL })
        : nextResolve(request, context)
    },
  })
  try {
    return import.meta.resolve(importerResolutionRequest)
  } finally {
    hooks.deregister()
  }
}

function packageRootContaining(filePath: string, packageName: string): string | undefined {
  let directory = dirname(filePath)
  while (true) {
    if (readPackageManifest(directory)?.name === packageName) return realpathSync(directory)
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

function packageRootFromUrl(url: string, packageName: string): string | undefined {
  return url.startsWith('file:') ? packageRootContaining(fileURLToPath(url), packageName) : undefined
}

function runtimePackageRoot(packageName: string): string | undefined {
  try {
    return packageRootFromUrl(runtimeModuleLocations().get(packageName) ?? import.meta.resolve(packageName), packageName)
  } catch {
    return undefined
  }
}

function installedPackageRoot(packageName: string, importerPath: string): string | undefined {
  try {
    const manifestPath = isBunRuntime()
      ? (globalThis as typeof globalThis & { Bun: BunResolver }).Bun.resolveSync(`${packageName}/package.json`, dirname(importerPath))
      : nodeModule.findPackageJSON(packageName, pathToFileURL(importerPath).href)
    return manifestPath ? realpathSync(dirname(manifestPath)) : undefined
  } catch {
    return undefined
  }
}

function assertApplicationHoloPackageSharesRuntime(specifier: string, applicationRoot: string): void {
  const visited = new Set<string>()
  const check = (packageRoot: string): void => {
    if (visited.has(packageRoot)) return
    visited.add(packageRoot)
    const manifest = readPackageManifest(packageRoot)
    const packageImporter = join(packageRoot, 'package.json')
    const dependencyNames = ['dependencies', 'peerDependencies', 'optionalDependencies']
      .flatMap(field => isRecord(manifest?.[field]) ? Object.keys(manifest[field]) : [])
      .filter(name => name.startsWith('@holo-js/'))
    for (const dependencyName of new Set(dependencyNames)) {
      const dependencyRoot = installedPackageRoot(dependencyName, packageImporter)
      if (!dependencyRoot) continue
      const runtimeRoot = runtimePackageRoot(dependencyName)
      if (!runtimeRoot) {
        check(dependencyRoot)
        continue
      }
      if (dependencyRoot !== runtimeRoot) {
        throw new Error(`[@holo-js/core] "${holoPackageName(specifier)}" uses its own copy of "${dependencyName}", so it cannot share the Holo runtime's instances. Install "${holoPackageName(specifier)}" in the same node_modules as @holo-js/core.`)
      }
    }
  }
  check(applicationRoot)
}

function resolveHoloPackageFromRuntime(specifier: string, importerPath: string): string {
  try {
    return import.meta.resolve(specifier)
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND')) throw error
  }
  const entryUrl = resolveFromImporter(specifier, importerPath)
  const applicationRoot = packageRootFromUrl(entryUrl, holoPackageName(specifier))
  if (applicationRoot) assertApplicationHoloPackageSharesRuntime(specifier, applicationRoot)
  return entryUrl
}

function bridgeRuntimeModuleInstances(): Plugin {
  return {
    name: 'holo-runtime-module-instances',
    setup(build) {
      build.onResolve({ filter: /^@holo-js\// }, args => (
        runtimeModuleInstances().has(args.path)
          ? { path: args.path, namespace: runtimeInstanceNamespace }
          : { path: resolveHoloPackageFromRuntime(args.path, args.importer || join(args.resolveDir, 'index.js')), external: true }
      ))
      build.onLoad({ filter: /.*/, namespace: runtimeInstanceNamespace }, args => ({
        contents: runtimeInstanceModuleSource(args.path, runtimeModuleInstances().get(args.path) ?? {}),
        loader: 'js',
      }))
    },
  }
}

const PACKAGE_SUBPATH_SPECIFIER = /^((?:@[^/:]+\/)?[^@./:][^/:]*)\/./

async function hasExportsMap(packageManifestPath: string): Promise<boolean> {
  const manifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) as { exports?: unknown }
  return manifest.exports !== undefined && manifest.exports !== null
}

async function resolveLegacyPackageSubpath({ path, resolveDir }: OnResolveArgs): Promise<OnResolveResult | undefined> {
  const packageName = PACKAGE_SUBPATH_SPECIFIER.exec(path)?.[1]
  if (!packageName || !resolveDir || nodeModule.isBuiltin(path)) return undefined

  const importerRequire = nodeModule.createRequire(join(resolveDir, 'index.js'))
  try {
    if (await hasExportsMap(importerRequire.resolve(`${packageName}/package.json`))) return undefined
    return { path: pathToFileURL(importerRequire.resolve(path)).href, external: true }
  } catch {
    return undefined
  }
}

const PACKAGE_SUBPATH_PROBE = Symbol('holo-package-subpath-probe')

function createPackageSubpathResolutionPlugin(): Plugin {
  return {
    name: 'holo-package-subpath-resolution',
    setup(build) {
      build.onResolve({ filter: PACKAGE_SUBPATH_SPECIFIER }, async (args) => {
        if (args.pluginData === PACKAGE_SUBPATH_PROBE) return undefined
        const resolved = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: PACKAGE_SUBPATH_PROBE,
        })
        if (!resolved.external || resolved.path !== args.path) return undefined
        return await resolveLegacyPackageSubpath(args)
      })
    },
  }
}

const sourceModuleLoaders: Readonly<Record<string, Loader>> = {
  '.ts': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.tsx': 'tsx',
  '.jsx': 'jsx',
}

function unusedHelperName(preferred: string, prefix: string, width: number, contents: string, identifiers: ReadonlySet<string>): string {
  const isUnused = (name: string) => !contents.includes(name) && !identifiers.has(name)
  if (isUnused(preferred)) return preferred
  for (let index = 0; ; index += 1) {
    const name = `${prefix}${index.toString(36).padStart(width - prefix.length, '0')}`
    if (isUnused(name)) return name
  }
}

function sameWidthReplacement(functionName: string, original: string, parenthesized = false): string {
  const call = parenthesized ? `(${functionName}())` : `${functionName}()`
  const lines = original.split(/(\r\n|\n|\r|\u2028|\u2029)/)
  if (lines.length === 1) return call.padEnd(original.length, ' ')
  const lastLine = lines.at(-1)!
  const breaks = lines.filter((_, index) => index % 2 === 1).join('')
  return `${call}${breaks}${' '.repeat(lastLine.length)}`
}

function sourceModuleResolveSource(parentURL: string, parentPath: string, nodeModuleBinding: string): string {
  return [
    '(specifier, parent) => {',
    'const target = `${specifier}`;',
    'if (parent !== void 0 && import.meta.resolve(\'./\', \'file:///\') === \'file:///\') return import.meta.resolve(target, parent);',
    `if ('dir' in import.meta) return import.meta.resolve(target, ${parentPath});`,
    `const marker = ${JSON.stringify(importerResolutionRequest)};`,
    `const hooks = ${nodeModuleBinding}.registerHooks({ resolve: (request, context, nextResolve) => request === marker ? nextResolve(target, { ...context, parentURL: ${parentURL} }) : nextResolve(request, context) });`,
    'try { return import.meta.resolve(marker) } finally { hooks.deregister() }',
    '}',
  ].join(' ')
}

function createSourceModuleUrlPlugin(): Plugin {
  return {
    name: 'holo-source-module-url',
    setup(buildContext) {
      buildContext.onLoad({ filter: /\.(?:[cm]?[jt]s|[jt]sx)$/, namespace: 'file' }, async ({ path }) => {
        const contents = await readFile(path, 'utf8')
        const loader = sourceModuleLoaders[extname(path)] ?? 'js'
        if (!contents.includes('meta') || !contents.includes('import')) return undefined

        const ts = await import('typescript')
        const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true)
        const identifiers = new Set<string>()
        const collectIdentifiers = (node: TypeScriptNode): void => {
          if (ts.isIdentifier(node)) identifiers.add(node.text)
          ts.forEachChild(node, collectIdentifiers)
        }
        collectIdentifiers(source)
        const sourceValues = {
          url: JSON.stringify(pathToFileURL(path).href),
          dirname: JSON.stringify(dirname(path)),
          filename: JSON.stringify(path),
        }
        type SourceProperty = keyof typeof sourceValues
        const propertyFunctions: Record<SourceProperty, string> = {
          url: unusedHelperName('__holoMetaUrl', '__holoUrl', 13, contents, identifiers),
          dirname: unusedHelperName('__holoMetaDir', '__holoDir', 13, contents, identifiers),
          filename: unusedHelperName('__holoMetaFil', '__holoFil', 13, contents, identifiers),
        }
        const metaFunction = unusedHelperName('__hMeta', '__hM', 7, contents, identifiers)
        const nodeModuleBinding = unusedHelperName('__hModule', '__hMod', 9, contents, identifiers)
        const isImportMeta = (node: TypeScriptNode): boolean => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword
        const asSourceProperty = (name: string): SourceProperty | undefined => Object.hasOwn(sourceValues, name) ? name as SourceProperty : undefined
        const sourcePropertyRead = (node: TypeScriptNode): SourceProperty | undefined => {
          if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression)) return asSourceProperty(node.name.text)
          if (ts.isElementAccessExpression(node)
            && isImportMeta(node.expression)
            && (ts.isStringLiteral(node.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(node.argumentExpression))) {
            return asSourceProperty(node.argumentExpression.text)
          }
          return undefined
        }
        const isAssignmentTarget = (node: TypeScriptNode): boolean => {
          let current = node
          let parent = current.parent
          while (parent) {
            if (ts.isParenthesizedExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent)
              || ts.isObjectLiteralExpression(parent) || ts.isShorthandPropertyAssignment(parent)
              || ts.isSpreadAssignment(parent) || (ts.isPropertyAssignment(parent) && parent.initializer === current)
              || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)
              || ts.isTypeAssertionExpression(parent)) {
              current = parent
              parent = current.parent
              continue
            }
            if (ts.isBinaryExpression(parent)) {
              return parent.left === current
                && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
                && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            }
            if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
              return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken
            }
            if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === current
            return false
          }
          return false
        }
        const fragments: string[] = []
        let cursor = 0
        const usedProperties = new Set<SourceProperty>()
        let usesMetaFunction = false
        const calleelessNewEnds = new Set<number>()
        const collectCalleelessNews = (node: TypeScriptNode): void => {
          if (ts.isNewExpression(node) && node.expression.pos === node.expression.end) calleelessNewEnds.add(node.end)
          ts.forEachChild(node, collectCalleelessNews)
        }
        collectCalleelessNews(source)
        const isConstructedCallee = (node: TypeScriptNode): boolean => {
          if (calleelessNewEnds.has(node.pos)) return true
          let current = node
          while ((ts.isPropertyAccessExpression(current.parent) || ts.isElementAccessExpression(current.parent)) && current.parent.expression === current) current = current.parent
          return ts.isNewExpression(current.parent) && current.parent.expression === current
        }
        const replace = (node: TypeScriptNode, functionName: string) => {
          const start = node.getStart(source)
          fragments.push(contents.slice(cursor, start), sameWidthReplacement(functionName, contents.slice(start, node.end), isConstructedCallee(node)))
          cursor = node.end
        }

        function visit(node: TypeScriptNode): void {
          const property = sourcePropertyRead(node)
          if (property && !isAssignmentTarget(node)) {
            replace(node, propertyFunctions[property])
            usedProperties.add(property)
            return
          }
          if (isImportMeta(node)) {
            replace(node, metaFunction)
            usesMetaFunction = true
            return
          }
          ts.forEachChild(node, visit)
        }

        visit(source)
        if (cursor === 0) return { contents, loader }
        fragments.push(contents.slice(cursor))
        for (const property of usedProperties) fragments.push(`\nfunction ${propertyFunctions[property]}() { return ${sourceValues[property]} }\n`)
        if (usesMetaFunction) fragments.push(`\nfunction ${metaFunction}() { return ${metaFunction}.meta ??= { ...import.meta, url: ${sourceValues.url}, dirname: ${sourceValues.dirname}, filename: ${sourceValues.filename}, resolve: ${sourceModuleResolveSource(sourceValues.url, sourceValues.filename, nodeModuleBinding)} } }\nimport * as ${nodeModuleBinding} from 'node:module'\n`)
        return { contents: fragments.join(''), loader }
      })
    },
  }
}

export const sourceModuleUrlInternals = {
  createSourceModuleUrlPlugin,
}

export const packageSubpathResolutionInternals = {
  createPackageSubpathResolutionPlugin,
}

export type BundleSources = {
  readonly path: string
  readonly sourcePath?: string
  readonly importers: Readonly<Record<string, string>>
}

const namespacedInput = /^[a-z][\w-]*:/i
const bareSpecifier = /^(?![./]|[a-z][\w+.-]*:|#)/i

function projectRelative(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join('/')
}

function collectBundleSources(
  projectRoot: string,
  metafile: Metafile | undefined,
  bundlePath: string,
  entryPath?: string,
): BundleSources {
  const sourcePath = entryPath === undefined ? undefined : projectRelative(projectRoot, entryPath)
  const output = Object.entries(metafile?.outputs ?? {}).find(([outputPath]) => resolve(projectRoot, outputPath) === bundlePath)?.[1]
  const loadedImports = new Set(output?.imports.map(dependency => `${dependency.kind}:${dependency.path}`))
  const importers: Record<string, string> = Object.create(null)
  const staticImporters = new Set<string>()
  for (const inputPath of Object.keys(output?.inputs ?? {})) {
    if (namespacedInput.test(inputPath)) continue
    const inputSource = projectRelative(projectRoot, resolve(projectRoot, inputPath))
    for (const dependency of metafile?.inputs[inputPath]?.imports ?? []) {
      const specifier = dependency.original ?? dependency.path
      if (!dependency.external || !loadedImports.has(`${dependency.kind}:${dependency.path}`) || !bareSpecifier.test(specifier)) continue
      const isStatic = dependency.kind === 'import-statement'
      const recordedStatic = staticImporters.has(specifier)
      if (recordedStatic && !isStatic) continue
      if (Object.hasOwn(importers, specifier) && recordedStatic === isStatic && inputSource !== sourcePath) continue
      importers[specifier] = inputSource
      if (isStatic) staticImporters.add(specifier)
    }
  }
  return { path: bundlePath, ...(sourcePath === undefined ? {} : { sourcePath }), importers }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function specifierSubpath(specifier: string): string {
  return specifier.slice(packageNameOf(specifier).length + 1)
}

function installedPackagePath(message: string, specifier: string): string | undefined {
  const marker = `/node_modules/${packageNameOf(specifier)}/`
  const start = message.indexOf(marker)
  if (start < 0) return undefined
  return message.slice(start + marker.length).split(/['\s]/, 1)[0]
}

function missingPackageFile(message: string, specifier: string): string | undefined {
  if (specifierSubpath(specifier) === '' || !message.startsWith('Cannot find module')) return undefined
  return installedPackagePath(message, specifier)
}

function loadErrorSource(message: string, sources: BundleSources): string | undefined {
  const normalizedMessage = message.replaceAll('\\', '/')
  const importers = Object.entries(sources.importers)
  const matchers: Array<(specifier: string) => boolean> = [
    specifier => normalizedMessage.includes(`'${specifier}'`),
    specifier => specifierSubpath(specifier) !== '' && installedPackagePath(normalizedMessage, specifier) !== undefined
      && normalizedMessage.includes(`Package subpath './${specifierSubpath(specifier)}'`),
    specifier => specifierSubpath(specifier) === '' && installedPackagePath(normalizedMessage, specifier) !== undefined
      && normalizedMessage.includes('No "exports" main defined in'),
    specifier => missingPackageFile(normalizedMessage, specifier) === specifierSubpath(specifier),
    specifier => missingPackageFile(normalizedMessage, specifier)?.replace(/\.[^./]+$/, '') === specifierSubpath(specifier),
    specifier => specifierSubpath(specifier) === '' && normalizedMessage.includes(`'${specifier}'`),
    specifier => normalizedMessage.includes(`'${packageNameOf(specifier)}'`),
    specifier => specifierSubpath(specifier) === '' && installedPackagePath(normalizedMessage, specifier) !== undefined,
    specifier => installedPackagePath(normalizedMessage, specifier) !== undefined,
  ]
  for (const matches of matchers) {
    const importer = importers.find(([specifier]) => matches(specifier))
    if (importer) return importer[1]
  }
  return sources.sourcePath
}

function bundleRealPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function rewritesInPlace(error: Error, message: string, attributed: string): boolean {
  try {
    if (typeof error.stack === 'string') error.stack = error.stack.replace(message, () => attributed)
    error.message = attributed
    return true
  } catch {
    return false
  }
}

const moduleResolutionErrorCodes = new Set([
  'ERR_MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_PACKAGE_IMPORT_NOT_DEFINED',
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_INVALID_PACKAGE_TARGET',
  'ERR_INVALID_MODULE_SPECIFIER',
])

function withBundleSources(error: unknown, sources: BundleSources): unknown {
  if (!error || typeof error !== 'object' || typeof (error as { message?: unknown }).message !== 'string') return error
  if (!moduleResolutionErrorCodes.has(String((error as { code?: unknown }).code))) return error
  const message = (error as { message: string }).message
  const locations = [...new Set([sources.path, bundleRealPath(sources.path)])]
    .flatMap(path => [pathToFileURL(path).href, path])
    .map(escapeRegExp)
  const bundleLocation = new RegExp(`(?:${locations.join('|')})(?:\\?[^\\s'"]*)?`, 'g')
  if (!message.match(bundleLocation)) return error
  const source = loadErrorSource(message, sources)
  if (source === undefined) return error
  const attributed = message.replace(bundleLocation, () => source)
  if (error instanceof Error && rewritesInPlace(error, message, attributed)) return error
  return Object.assign(new Error(attributed, { cause: error }), { code: (error as { code: string }).code })
}

async function importBundle(sources: BundleSources, importModule: (url: string) => Promise<unknown>, query = `t=${Date.now()}`): Promise<unknown> {
  try {
    return await importModule(`${pathToFileURL(sources.path).href}?${query}`)
  } catch (error) {
    throw withBundleSources(error, sources)
  }
}

export const bundleSourceInternals = {
  collectBundleSources,
  importBundle,
  withBundleSources,
}

registerRuntimeModuleInstance('@holo-js/config', holoConfigModule)
registerRuntimeModuleInstance('@holo-js/db', holoDbModule)
registerRuntimeModuleInstance('@holo-js/kernel', holoKernelModule)

async function bundleRuntimeModule(
  projectRoot: string,
  entryPath: string,
): Promise<{ path: string, metafile: BuildResult['metafile'], cleanup(): Promise<void> }> {
  const runtimeTempRoot = join(projectRoot, '.holo-js', 'runtime')
  await mkdir(runtimeTempRoot, { recursive: true })
  const tempDir = await mkdtemp(join(runtimeTempRoot, 'bundle-'))
  const outfile = join(tempDir, `${basename(entryPath, extname(entryPath))}.mjs`)

  const cleanup = async () => {
    await rm(tempDir, { recursive: true, force: true })
  }

  try {
    const result = await withLoaderTsconfig(projectRoot, tsconfigPath => runtimeModuleInternals.runEsbuild({
      absWorkingDir: projectRoot,
      bundle: true,
      entryPoints: [entryPath],
      outfile,
      format: 'esm',
      logLevel: 'silent',
      packages: 'external',
      platform: 'node',
      plugins: [createSourceModuleUrlPlugin(), bridgeRuntimeModuleInstances(), createPackageSubpathResolutionPlugin()],
      target: 'node22',
      tsconfig: tsconfigPath,
      sourcemap: 'inline',
      metafile: true,
    }))

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

const nativeLoadCheckStop = Symbol.for('holo-js.native-load-check')

async function nodeLoadsTypeScriptSources(tempDir: string, sourcePaths: readonly string[]): Promise<boolean> {
  const checkPath = join(tempDir, 'native-load-check.mjs')
  await writeFile(checkPath, [
    `import ${JSON.stringify(`data:text/javascript,${encodeURIComponent('throw Symbol.for("holo-js.native-load-check")')}`)}`,
    ...sourcePaths.map(sourcePath => `import ${JSON.stringify(pathToFileURL(sourcePath).href)}`),
  ].join('\n'), 'utf8')
  const outcome = await importModule(pathToFileURL(checkPath).href).catch((error: unknown) => error)
  return outcome === nativeLoadCheckStop
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
    bundled = await bundleRuntimeModule(projectRoot, entryPath)
    const sources = new Map<string, string>()
    const nativeSourceLoader = isBunRuntime()
      || [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].some(argument => /(?:^|[/\\])tsx[/\\]/.test(argument) || /^(?:--import=)?tsx(?:\/esm)?$/.test(argument))
    let nativeGraph = true
    const typeScriptSources: string[] = []
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
        typeScriptSources.push(sourcePath)
      }
    }
    if (nativeGraph && typeScriptSources.length) nativeGraph = await nodeLoadsTypeScriptSources(tempDir, typeScriptSources)
    if (nativeSourceLoader && projectImports.some(({ dependency, importerPath }) => !staticImportMatchesBundle(dependency, importerPath, projectRoot))) nativeGraph = false
    const previous = definitionGraphSources.get(projectRoot)
    if (previous && (!previous.native || previous.sources.size !== sources.size || [...sources].some(([path, source]) => previous.sources.get(path) !== source))) nativeGraph = false
    definitionGraphSources.set(projectRoot, { sources, native: nativeGraph })
    const definitions = new Map<string, unknown>()
    if (nativeGraph) {
      for (const sourcePath of entryPaths) definitions.set(sourcePath, await importModule(pathToFileURL(sourcePath).href))
    } else {
      const modules = await bundleSourceInternals.importBundle(
        bundleSourceInternals.collectBundleSources(projectRoot, bundled.metafile, bundled.path),
        importModule,
      ) as Record<string, unknown>
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
    return await bundleSourceInternals.importBundle(
      bundleSourceInternals.collectBundleSources(projectRoot, bundled.metafile, bundled.path, entryPath),
      url => runtimeModuleInternals.importModule(url),
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
  isRecord,
  loadEsbuild,
  pathExists,
  registerRuntimeModuleInstance,
  resolveRuntimeModuleSearchPaths,
  resolveOptionalImportSpecifier,
  runEsbuild,
  writeLoaderTsconfig,
  withLoaderTsconfig,
}
