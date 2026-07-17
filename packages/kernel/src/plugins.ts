import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type PluginManifest = { readonly holo?: unknown }

export type HoloPluginDependencyContributions = {
  readonly runtime?: readonly string[]
  readonly holo?: readonly `@holo-js/${string}`[]
}

export type HoloPluginConfigContributions = {
  readonly files?: readonly string[]
  readonly env?: readonly string[]
}

export type HoloPluginRuntimeMapContributions<TKey extends 'drivers' | 'channels'> = Readonly<
  Record<TKey, Readonly<Record<string, { readonly runtime: string }>>>
>

export type HoloPluginBroadcastContributions = HoloPluginRuntimeMapContributions<'drivers'>
export type HoloPluginCacheContributions = HoloPluginRuntimeMapContributions<'drivers'>
export type HoloPluginQueueContributions = HoloPluginRuntimeMapContributions<'drivers'>
export type HoloPluginMailContributions = HoloPluginRuntimeMapContributions<'drivers'>
export type HoloPluginNotificationContributions = HoloPluginRuntimeMapContributions<'channels'>

export type HoloPluginRuntimeContributions = { readonly boot?: string }
export type HoloPluginCliContributions = { readonly commands?: string }
export type HoloPluginMigrationContributions = { readonly publish?: string }

export type HoloPluginFrameworkTsconfigKind = 'nuxt' | 'next' | 'sveltekit'
export type HoloPluginPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export type HoloPluginFrameworkContribution = {
  readonly id: string
  readonly displayName: string
  readonly detectPackages: readonly string[]
  readonly adapterPackage: `@holo-js/${string}`
  readonly fluxPackage?: `@holo-js/${string}`
  readonly scaffold: {
    readonly dependencies: Readonly<Record<string, string>>
    readonly devDependencies: Readonly<Record<string, string>>
    readonly scripts: Readonly<Record<string, string>>
    readonly lintScript: string
    readonly typecheckScript: string
    readonly defaultUrl: string
    readonly tsconfig: HoloPluginFrameworkTsconfigKind
    readonly vscodeVueHybridMode?: boolean
  }
  readonly runner: {
    readonly commandName: string
    readonly buildArgs: readonly string[]
    readonly start: readonly string[]
    readonly startUsesFrameworkBinary: boolean
    readonly preloadNextRuntime: boolean
    readonly suppressSvelteKitOutput: boolean
    readonly nextDevServerConflictHandling: boolean
  }
  readonly sync?: {
    readonly commands: Readonly<Record<HoloPluginPackageManager, readonly [string, ...string[]]>>
    readonly errorLabel: string
  }
  readonly capabilities: { readonly managedBroadcastAuthRoute: boolean }
}

export type HoloPluginContributions = {
  readonly dependencies?: HoloPluginDependencyContributions
  readonly config?: HoloPluginConfigContributions
  readonly framework?: HoloPluginFrameworkContribution
  readonly broadcast?: HoloPluginBroadcastContributions
  readonly cache?: HoloPluginCacheContributions
  readonly queue?: HoloPluginQueueContributions
  readonly mail?: HoloPluginMailContributions
  readonly notifications?: HoloPluginNotificationContributions
  readonly runtime?: HoloPluginRuntimeContributions
  readonly cli?: HoloPluginCliContributions
  readonly migrations?: HoloPluginMigrationContributions
}

export type HoloPluginDefinition = {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly contributes?: HoloPluginContributions
}

export type LoadedHoloPluginDefinition = {
  readonly packageName: string
  readonly packageRoot: string
  readonly entryPath: string
  readonly definition: HoloPluginDefinition
}

export type HoloPluginRuntimeModule = {
  readonly plugin: LoadedHoloPluginDefinition
  readonly name: string
  readonly runtime: string
  readonly module: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function assertValidPackageName(packageName: string): void {
  if (!(/^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(packageName)
    || /^[a-z0-9][a-z0-9._-]*$/i.test(packageName))) {
    throw new Error(`[Holo Plugins] Invalid plugin package name: ${packageName}.`)
  }
}

function assertPackageRelativePath(packageName: string, value: string): void {
  if (isAbsolute(value)) {
    throw new Error(`[Holo Plugins] Plugin ${packageName} declared an absolute module path.`)
  }
}

function resolvePackageJsonPath(projectRoot: string, packageName: string): string {
  assertValidPackageName(packageName)
  try {
    return createRequire(join(projectRoot, 'package.json')).resolve(`${packageName}/package.json`)
  } catch {
    return join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  }
}

export type PluginLoadOptions = {
  readonly moduleVersion?: string
}

async function loadModule(projectRoot: string, modulePath: string, options: PluginLoadOptions = {}): Promise<unknown> {
  const resolvedPath = createRequire(join(projectRoot, 'package.json')).resolve(modulePath)
  const moduleUrl = pathToFileURL(resolvedPath).href
  const versionedUrl = options.moduleVersion ? `${moduleUrl}?v=${encodeURIComponent(options.moduleVersion)}` : moduleUrl
  return await import(/* webpackIgnore: true */ versionedUrl) as unknown
}

export function normalizeHoloPluginDefinition(value: unknown): HoloPluginDefinition {
  const module = value as Readonly<Record<string, unknown>>
  const candidate = 'default' in module
    ? module.default
    : 'plugin' in module
      ? module.plugin
      : module
  if (!isRecord(candidate) || !normalizeString(candidate.id)) {
    throw new Error('[Holo Plugins] Plugin entry must export a plugin definition with an id.')
  }
  return Object.freeze({ ...candidate } as HoloPluginDefinition)
}

export function defineHoloPlugin<TPlugin extends HoloPluginDefinition>(plugin: TPlugin): Readonly<TPlugin> {
  return Object.freeze({ ...plugin })
}

export function resolveHoloPluginModulePath(
  projectRoot: string,
  plugin: LoadedHoloPluginDefinition,
  specifier: string,
): string {
  const normalized = specifier.trim()
  if (!normalized) throw new Error(`[Holo Plugins] Plugin ${plugin.packageName} declared an empty module specifier.`)
  assertPackageRelativePath(plugin.packageName, normalized)
  if (!normalized.startsWith('.')) {
    return createRequire(join(resolve(projectRoot), 'package.json')).resolve(normalized)
  }
  const modulePath = resolve(plugin.packageRoot, normalized)
  const relativePath = relative(plugin.packageRoot, modulePath)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`[Holo Plugins] Plugin ${plugin.packageName} module must stay inside the package root.`)
  }
  return modulePath
}

export async function loadHoloPluginDefinitions(
  projectRoot: string,
  packageNames: readonly string[],
  options: PluginLoadOptions = {},
): Promise<readonly LoadedHoloPluginDefinition[]> {
  const root = resolve(projectRoot)
  const loaded: LoadedHoloPluginDefinition[] = []
  const ids = new Set<string>()
  for (const packageName of packageNames) {
    const packageJsonPath = resolvePackageJsonPath(root, packageName)
    let manifest: PluginManifest
    try {
      manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PluginManifest
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') throw new Error(`Cannot find module '${packageName}/package.json'`)
      throw error
    }
    if (!isRecord(manifest.holo) || !normalizeString(manifest.holo.plugin)) {
      throw new Error(`[Holo Plugins] Plugin ${packageName} does not declare holo.plugin.`)
    }
    const entry = normalizeString(manifest.holo.plugin)!
    assertPackageRelativePath(packageName, entry)
    const packageRoot = dirname(packageJsonPath)
    const entryPath = resolve(packageRoot, entry)
    const relativeEntry = relative(packageRoot, entryPath)
    if (relativeEntry.startsWith('..') || isAbsolute(relativeEntry)) {
      throw new Error(`[Holo Plugins] Plugin ${packageName} entry must stay inside the package root.`)
    }
    const definition = normalizeHoloPluginDefinition(await loadModule(root, entryPath, options))
    if (ids.has(definition.id)) throw new Error(`[Holo Plugins] Duplicate plugin id "${definition.id}".`)
    ids.add(definition.id)
    loaded.push(Object.freeze({ packageName, packageRoot, entryPath, definition }))
  }
  return Object.freeze(loaded)
}

function contributionMap(plugin: LoadedHoloPluginDefinition, scope: string, key: string): Readonly<Record<string, string>> {
  const contributions = plugin.definition.contributes as Readonly<Record<string, unknown>> | undefined
  const scopeValue = contributions?.[scope]
  if (!isRecord(scopeValue) || !isRecord(scopeValue[key])) return Object.freeze({})
  return Object.freeze(Object.fromEntries(Object.entries(scopeValue[key]).flatMap(([name, value]) => {
    const runtime = isRecord(value) ? normalizeString(value.runtime) : undefined
    return runtime ? [[name, runtime]] : []
  })))
}

export async function loadHoloPluginContributionModules(
  projectRoot: string,
  plugins: readonly LoadedHoloPluginDefinition[],
  scope: string,
  key: string,
  options: PluginLoadOptions = {},
): Promise<readonly HoloPluginRuntimeModule[]> {
  const modules: HoloPluginRuntimeModule[] = []
  const names = new Set<string>()
  for (const plugin of plugins) {
    for (const [name, runtime] of Object.entries(contributionMap(plugin, scope, key))) {
      if (names.has(name)) throw new Error(`[Holo Plugins] Duplicate ${scope}.${key} contribution "${name}".`)
      names.add(name)
      modules.push(Object.freeze({
        plugin,
        name,
        runtime,
        module: await loadModule(projectRoot, resolveHoloPluginModulePath(projectRoot, plugin, runtime), options),
      }))
    }
  }
  return Object.freeze(modules)
}

export async function loadHoloPluginBootModules(
  projectRoot: string,
  plugins: readonly LoadedHoloPluginDefinition[],
  options: PluginLoadOptions = {},
): Promise<readonly HoloPluginRuntimeModule[]> {
  const modules: HoloPluginRuntimeModule[] = []
  for (const plugin of plugins) {
    const runtimeScope = plugin.definition.contributes?.runtime
    const runtime = isRecord(runtimeScope) ? normalizeString(runtimeScope.boot) : undefined
    if (!runtime) continue
    modules.push(Object.freeze({
      plugin,
      name: 'boot',
      runtime,
      module: await loadModule(projectRoot, resolveHoloPluginModulePath(projectRoot, plugin, runtime), options),
    }))
  }
  return Object.freeze(modules)
}
