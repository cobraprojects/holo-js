import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfigDirectory } from './loader'

type PluginManifest = {
  readonly holo?: unknown
}

export type LoadedHoloPluginDefinition = {
  readonly packageName: string
  readonly packageRoot: string
  readonly definition: Readonly<Record<string, unknown>>
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

function isValidPackageName(packageName: string): boolean {
  return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i.test(packageName)
    || /^[a-z0-9][a-z0-9._-]*$/i.test(packageName)
}

function assertValidPackageName(packageName: string): void {
  if (!isValidPackageName(packageName)) {
    throw new Error(`[Holo Plugins] Invalid plugin package name: ${packageName}.`)
  }
}

function assertPackageRelativePath(packageName: string, value: string): void {
  if (isAbsolute(value)) {
    throw new Error(`[Holo Plugins] Plugin ${packageName} declared an absolute module path.`)
  }
}

export async function readActiveHoloPluginNames(projectRoot = process.cwd()): Promise<readonly string[]> {
  const root = resolve(projectRoot)
  const config = await loadConfigDirectory(root, {
    preferCache: false,
    processEnv: process.env,
  })

  return Object.freeze(config.app.plugins)
}

function resolvePluginEntryPath(packageName: string, packageJsonPath: string, manifest: PluginManifest): string {
  if (!isRecord(manifest.holo)) {
    throw new Error(`[Holo Plugins] Plugin ${packageName} does not declare holo.plugin.`)
  }

  const entry = normalizeString(manifest.holo.plugin)
  if (!entry) {
    throw new Error(`[Holo Plugins] Plugin ${packageName} does not declare holo.plugin.`)
  }

  assertPackageRelativePath(packageName, entry)

  const packageRoot = dirname(packageJsonPath)
  const entryPath = resolve(packageRoot, entry)
  const relativeEntryPath = relative(packageRoot, entryPath)
  if (relativeEntryPath.startsWith('..') || isAbsolute(relativeEntryPath)) {
    throw new Error(`[Holo Plugins] Plugin ${packageName} entry must stay inside the package root.`)
  }

  return entryPath
}

function resolvePluginDefinition(moduleValue: unknown): Readonly<Record<string, unknown>> {
  const candidate = isRecord(moduleValue) && 'default' in moduleValue
    ? moduleValue.default
    : isRecord(moduleValue) && 'plugin' in moduleValue
      ? moduleValue.plugin
      : moduleValue

  if (!isRecord(candidate)) {
    throw new Error('[Holo Plugins] Plugin entry must export a plugin definition.')
  }

  return Object.freeze({ ...candidate })
}

async function loadRuntimeModule(projectRoot: string, modulePath: string): Promise<unknown> {
  const projectRequire = createRequire(join(resolve(projectRoot), 'package.json'))
  const resolvedPath = projectRequire.resolve(modulePath)
  return await import(/* webpackIgnore: true */ pathToFileURL(resolvedPath).href) as unknown
}

function resolvePluginPackageJsonPath(projectRoot: string, packageName: string): string {
  assertValidPackageName(packageName)

  try {
    const projectRequire = createRequire(join(projectRoot, 'package.json'))
    return projectRequire.resolve(`${packageName}/package.json`)
  } catch {
    return join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  }
}

async function readPluginManifest(packageName: string, packageJsonPath: string): Promise<PluginManifest> {
  try {
    return JSON.parse(await readFile(packageJsonPath, 'utf8')) as PluginManifest
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') {
      throw new Error(`Cannot find module '${packageName}/package.json'`)
    }

    throw error
  }
}

export async function loadHoloPluginDefinitions(projectRoot = process.cwd()): Promise<readonly LoadedHoloPluginDefinition[]> {
  const root = resolve(projectRoot)
  const pluginNames = await readActiveHoloPluginNames(root)
  if (pluginNames.length === 0) {
    return Object.freeze([])
  }

  const plugins: LoadedHoloPluginDefinition[] = []

  for (const packageName of pluginNames) {
    const packageJsonPath = resolvePluginPackageJsonPath(root, packageName)
    const manifest = await readPluginManifest(packageName, packageJsonPath)
    const entryPath = resolvePluginEntryPath(packageName, packageJsonPath, manifest)

    plugins.push(Object.freeze({
      packageName,
      packageRoot: dirname(packageJsonPath),
      definition: resolvePluginDefinition(await loadRuntimeModule(root, entryPath)),
    }))
  }

  return Object.freeze(plugins)
}

function resolveContributionMap(
  plugin: LoadedHoloPluginDefinition,
  scope: string,
  key: string,
): Readonly<Record<string, { readonly runtime: string }>> {
  const contributes = plugin.definition.contributes
  if (!isRecord(contributes) || !isRecord(contributes[scope]) || !isRecord(contributes[scope][key])) {
    return Object.freeze({})
  }

  return Object.freeze(Object.fromEntries(
    Object.entries(contributes[scope][key])
      .flatMap(([name, contribution]) => {
        if (!isRecord(contribution)) {
          return []
        }

        const runtime = normalizeString(contribution.runtime)
        return runtime ? [[name, { runtime }]] : []
      }),
  ))
}

export function resolveHoloPluginModulePath(
  projectRoot: string,
  plugin: LoadedHoloPluginDefinition,
  specifier: string,
): string {
  const normalizedSpecifier = specifier.trim()
  if (!normalizedSpecifier) {
    throw new Error(`[Holo Plugins] Plugin ${plugin.packageName} declared an empty module specifier.`)
  }

  assertPackageRelativePath(plugin.packageName, normalizedSpecifier)

  if (normalizedSpecifier.startsWith('.')) {
    const modulePath = resolve(plugin.packageRoot, normalizedSpecifier)
    const relativeModulePath = relative(plugin.packageRoot, modulePath)
    if (relativeModulePath.startsWith('..') || isAbsolute(relativeModulePath)) {
      throw new Error(`[Holo Plugins] Plugin ${plugin.packageName} module must stay inside the package root.`)
    }

    return modulePath
  }

  return createRequire(join(resolve(projectRoot), 'package.json')).resolve(normalizedSpecifier)
}

export async function loadHoloPluginContributionModules(
  projectRoot: string,
  scope: string,
  key: string,
): Promise<readonly HoloPluginRuntimeModule[]> {
  const root = resolve(projectRoot)
  const modules: HoloPluginRuntimeModule[] = []

  for (const plugin of await loadHoloPluginDefinitions(root)) {
    for (const [name, contribution] of Object.entries(resolveContributionMap(plugin, scope, key))) {
      const modulePath = resolveHoloPluginModulePath(root, plugin, contribution.runtime)
      modules.push(Object.freeze({
        plugin,
        name,
        runtime: contribution.runtime,
        module: await loadRuntimeModule(root, modulePath),
      }))
    }
  }

  return Object.freeze(modules)
}

export async function loadHoloPluginBootModules(projectRoot: string): Promise<readonly HoloPluginRuntimeModule[]> {
  const root = resolve(projectRoot)
  const modules: HoloPluginRuntimeModule[] = []

  for (const plugin of await loadHoloPluginDefinitions(root)) {
    const contributes = plugin.definition.contributes
    const runtime = isRecord(contributes) && isRecord(contributes.runtime)
      ? normalizeString(contributes.runtime.boot)
      : undefined
    if (!runtime) {
      continue
    }

    const modulePath = resolveHoloPluginModulePath(root, plugin, runtime)
    modules.push(Object.freeze({
      plugin,
      name: 'boot',
      runtime,
      module: await loadRuntimeModule(root, modulePath),
    }))
  }

  return Object.freeze(modules)
}
