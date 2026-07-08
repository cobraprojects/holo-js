import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfigDirectory } from '@holo-js/config'
import { APP_CONFIG_FILE_NAMES } from './shared'
import { pathExists } from './shared'
import {
  readTextFile,
  resolveFirstExistingPath,
  writeTextFile,
} from './runtime'
import { normalizeCommandAliases } from './discovery-helpers'
import type { FrameworkDescriptor, FrameworkTsconfigKind } from './frameworks'
import type { DiscoveredAppCommand } from './shared'
import type { HoloAppCommand } from '../types'

type PackageJsonManifest = {
  readonly name?: unknown
  readonly holo?: unknown
}

export type HoloPluginDependencyContributions = {
  readonly runtime?: readonly string[]
  readonly holo?: readonly `@holo-js/${string}`[]
}

export type HoloPluginConfigContributions = {
  readonly files?: readonly string[]
  readonly env?: readonly string[]
}

export type HoloPluginBroadcastContributions = {
  readonly drivers?: Readonly<Record<string, { readonly runtime: string }>>
}

export type HoloPluginCacheContributions = {
  readonly drivers?: Readonly<Record<string, { readonly runtime: string }>>
}

export type HoloPluginQueueContributions = {
  readonly drivers?: Readonly<Record<string, { readonly runtime: string }>>
}

export type HoloPluginMailContributions = {
  readonly drivers?: Readonly<Record<string, { readonly runtime: string }>>
}

export type HoloPluginNotificationContributions = {
  readonly channels?: Readonly<Record<string, { readonly runtime: string }>>
}

export type HoloPluginRuntimeContributions = {
  readonly boot?: string
}

export type HoloPluginCliContributions = {
  readonly commands?: string
}

export type HoloPluginMigrationContributions = {
  readonly publish?: string
}

export type HoloPluginContributions = {
  readonly dependencies?: HoloPluginDependencyContributions
  readonly config?: HoloPluginConfigContributions
  readonly framework?: FrameworkDescriptor
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

export type LoadedHoloPlugin = {
  readonly packageName: string
  readonly packageRoot: string
  readonly entryPath: string
  readonly definition: HoloPluginDefinition
}

type ResolvedPluginModulePath = {
  readonly specifier: string
  readonly path: string
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
type FrameworkSync = NonNullable<FrameworkDescriptor['sync']>

export type ResolvedProjectPlugin = {
  readonly packageName: string
  readonly loaded?: LoadedHoloPlugin
  readonly error?: string
}

export function defineHoloPlugin<TPlugin extends HoloPluginDefinition>(plugin: TPlugin): Readonly<TPlugin> {
  return Object.freeze({ ...plugin })
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
    throw new Error(`Invalid plugin package name: ${packageName || '(empty)'}.`)
  }
}

function isHoloAppCommand(value: unknown): value is HoloAppCommand {
  return isRecord(value)
    && typeof value.description === 'string'
    && typeof value.run === 'function'
    && (typeof value.name === 'undefined' || typeof value.name === 'string')
    && (typeof value.usage === 'undefined' || typeof value.usage === 'string')
    && (typeof value.aliases === 'undefined' || (Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string')))
}

function normalizeStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }

  const values = [...new Set(value.map(normalizeString).filter((entry): entry is string => Boolean(entry)))]
  return values.length > 0 ? Object.freeze(values) : undefined
}

function normalizeRequiredStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.length > 0 && value.every(entry => typeof entry === 'string' && entry.trim())
    ? Object.freeze(value.map(entry => entry.trim()))
    : undefined
}

function normalizeRequiredStringMap(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    return key.trim() && typeof entry === 'string' && entry.trim()
      ? [[key.trim(), entry.trim()] as const]
      : []
  })

  if (entries.length !== Object.keys(value).length) {
    return undefined
  }

  return Object.freeze(Object.fromEntries(entries))
}

function normalizeFrameworkTsconfigKind(value: unknown): FrameworkTsconfigKind | undefined {
  return value === 'nuxt' || value === 'next' || value === 'sveltekit'
    ? value
    : undefined
}

function normalizeHoloPackageArray(value: unknown): readonly `@holo-js/${string}`[] | undefined {
  const values = normalizeStringArray(value)
  if (!values) {
    return undefined
  }

  const holoPackages = values.filter((entry): entry is `@holo-js/${string}` => entry.startsWith('@holo-js/'))
  return holoPackages.length > 0 ? Object.freeze(holoPackages) : undefined
}

function normalizeDependencyContributions(value: unknown): HoloPluginDependencyContributions | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const runtime = normalizeStringArray(value.runtime)
  const holo = normalizeHoloPackageArray(value.holo)
  if (!runtime && !holo) {
    return undefined
  }

  return Object.freeze({
    ...(runtime ? { runtime } : {}),
    ...(holo ? { holo } : {}),
  })
}

function normalizeConfigContributions(value: unknown): HoloPluginConfigContributions | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const files = normalizeStringArray(value.files)
  const env = normalizeStringArray(value.env)
  if (!files && !env) {
    return undefined
  }

  return Object.freeze({
    ...(files ? { files } : {}),
    ...(env ? { env } : {}),
  })
}

function normalizeRuntimeMapContributions<TKey extends 'drivers' | 'channels'>(
  value: unknown,
  key: TKey,
): Readonly<Record<TKey, Readonly<Record<string, { readonly runtime: string }>>>> | undefined {
  if (!isRecord(value) || !isRecord(value[key])) {
    return undefined
  }

  const entries: Array<readonly [string, { readonly runtime: string }]> = []

  for (const [name, contribution] of Object.entries(value[key])) {
    if (!isRecord(contribution)) {
      continue
    }

    const runtime = normalizeString(contribution.runtime)
    if (runtime) {
      entries.push([name, { runtime }])
    }
  }

  const contributions = Object.fromEntries(
    entries.sort(([left], [right]) => left.localeCompare(right)),
  )

  return Object.keys(contributions).length > 0 ? Object.freeze({ [key]: contributions }) as Readonly<Record<TKey, Readonly<Record<string, { readonly runtime: string }>>>> : undefined
}

function normalizeBroadcastContributions(value: unknown): HoloPluginBroadcastContributions | undefined {
  return normalizeRuntimeMapContributions(value, 'drivers')
}

function normalizeFrameworkContribution(value: unknown): FrameworkDescriptor | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const id = normalizeString(value.id)
  const displayName = normalizeString(value.displayName)
  const detectPackages = normalizeRequiredStringArray(value.detectPackages)
  const adapterPackage = normalizeString(value.adapterPackage)
  if (!id || !displayName || !detectPackages || !adapterPackage?.startsWith('@holo-js/')) {
    return undefined
  }

  const fluxPackage = normalizeString(value.fluxPackage)
  if (fluxPackage && !fluxPackage.startsWith('@holo-js/')) {
    return undefined
  }

  if (!isRecord(value.scaffold) || !isRecord(value.runner) || !isRecord(value.capabilities)) {
    return undefined
  }

  const scaffoldDependencies = normalizeRequiredStringMap(value.scaffold.dependencies)
  const scaffoldDevDependencies = normalizeRequiredStringMap(value.scaffold.devDependencies)
  const scaffoldScripts = normalizeRequiredStringMap(value.scaffold.scripts)
  const lintScript = normalizeString(value.scaffold.lintScript)
  const typecheckScript = normalizeString(value.scaffold.typecheckScript)
  const defaultUrl = normalizeString(value.scaffold.defaultUrl)
  const tsconfig = normalizeFrameworkTsconfigKind(value.scaffold.tsconfig)
  if (!scaffoldDependencies || !scaffoldDevDependencies || !scaffoldScripts || !lintScript || !typecheckScript || !defaultUrl || !tsconfig) {
    return undefined
  }

  const commandName = normalizeString(value.runner.commandName)
  const buildArgs = normalizeRequiredStringArray(value.runner.buildArgs)
  const start = normalizeRequiredStringArray(value.runner.start)
  if (
    !commandName
    || !buildArgs
    || !start
    || typeof value.runner.startUsesFrameworkBinary !== 'boolean'
    || typeof value.runner.preloadNextRuntime !== 'boolean'
    || typeof value.runner.suppressSvelteKitOutput !== 'boolean'
    || typeof value.runner.nextDevServerConflictHandling !== 'boolean'
    || typeof value.capabilities.managedBroadcastAuthRoute !== 'boolean'
  ) {
    return undefined
  }

  const sync = normalizeFrameworkSync(value.sync)
  const descriptor: FrameworkDescriptor = {
    id,
    displayName,
    detectPackages,
    adapterPackage: adapterPackage as `@holo-js/${string}`,
    ...(fluxPackage ? { fluxPackage: fluxPackage as `@holo-js/${string}` } : {}),
    scaffold: {
      dependencies: scaffoldDependencies,
      devDependencies: scaffoldDevDependencies,
      scripts: scaffoldScripts,
      lintScript,
      typecheckScript,
      defaultUrl,
      tsconfig,
      ...(typeof value.scaffold.vscodeVueHybridMode === 'boolean' ? { vscodeVueHybridMode: value.scaffold.vscodeVueHybridMode } : {}),
    },
    runner: {
      commandName,
      buildArgs,
      start,
      startUsesFrameworkBinary: value.runner.startUsesFrameworkBinary,
      preloadNextRuntime: value.runner.preloadNextRuntime,
      suppressSvelteKitOutput: value.runner.suppressSvelteKitOutput,
      nextDevServerConflictHandling: value.runner.nextDevServerConflictHandling,
    },
    capabilities: {
      managedBroadcastAuthRoute: value.capabilities.managedBroadcastAuthRoute,
    },
    ...(sync ? { sync } : {}),
  }

  return Object.freeze(descriptor)
}

function normalizeFrameworkSync(value: unknown): FrameworkSync | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (!isRecord(value) || !isRecord(value.commands)) {
    return undefined
  }

  const commandMap = value.commands
  const errorLabel = normalizeString(value.errorLabel)
  if (!errorLabel) {
    return undefined
  }

  const managers: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun']
  const commands = Object.fromEntries(managers.flatMap((manager) => {
    const command = commandMap[manager]
    return Array.isArray(command) && command.length > 0 && command.every(entry => typeof entry === 'string' && entry.trim())
      ? [[manager, Object.freeze(command.map(entry => entry.trim())) as readonly [string, ...string[]]]]
      : []
  }))

  return managers.every(manager => manager in commands)
    ? Object.freeze({
      commands: commands as FrameworkSync['commands'],
      errorLabel,
    })
    : undefined
}

function normalizeSinglePathContribution<TContribution extends 'boot' | 'commands' | 'publish'>(
  value: unknown,
  key: TContribution,
): Readonly<Record<TContribution, string>> | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const entry = normalizeString(value[key])
  return entry ? Object.freeze({ [key]: entry } as Record<TContribution, string>) : undefined
}

function normalizePluginContributions(value: unknown): HoloPluginContributions | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const dependencies = normalizeDependencyContributions(value.dependencies)
  const config = normalizeConfigContributions(value.config)
  const broadcast = normalizeBroadcastContributions(value.broadcast)
  const cache = normalizeRuntimeMapContributions(value.cache, 'drivers')
  const queue = normalizeRuntimeMapContributions(value.queue, 'drivers')
  const mail = normalizeRuntimeMapContributions(value.mail, 'drivers')
  const notifications = normalizeRuntimeMapContributions(value.notifications, 'channels')
  const runtime = normalizeSinglePathContribution(value.runtime, 'boot')
  const cli = normalizeSinglePathContribution(value.cli, 'commands')
  const migrations = normalizeSinglePathContribution(value.migrations, 'publish')
  const framework = normalizeFrameworkContribution(value.framework)

  if (!dependencies && !config && !broadcast && !cache && !queue && !mail && !notifications && !runtime && !cli && !migrations && !framework) {
    return undefined
  }

  return Object.freeze({
    ...(dependencies ? { dependencies } : {}),
    ...(config ? { config } : {}),
    ...(broadcast ? { broadcast } : {}),
    ...(cache ? { cache } : {}),
    ...(queue ? { queue } : {}),
    ...(mail ? { mail } : {}),
    ...(notifications ? { notifications } : {}),
    ...(runtime ? { runtime } : {}),
    ...(cli ? { cli } : {}),
    ...(migrations ? { migrations } : {}),
    ...(framework ? { framework } : {}),
  })
}

export function normalizeHoloPluginDefinition(value: unknown): HoloPluginDefinition {
  const candidate = isRecord(value) && isRecord(value.default)
    ? value.default
    : isRecord(value) && isRecord(value.plugin)
      ? value.plugin
      : value

  if (!isRecord(candidate)) {
    throw new Error('Plugin entry must export a Holo plugin definition.')
  }

  const id = normalizeString(candidate.id)
  if (!id) {
    throw new Error('Plugin definition must include a non-empty id.')
  }

  const name = normalizeString(candidate.name)
  const description = normalizeString(candidate.description)
  const contributes = normalizePluginContributions(candidate.contributes)

  return Object.freeze({
    id,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(contributes ? { contributes } : {}),
  })
}

async function readPackageJson(packageJsonPath: string): Promise<PackageJsonManifest> {
  const contents = await readTextFile(packageJsonPath)
  if (!contents) {
    throw new Error(`Missing package manifest: ${packageJsonPath}.`)
  }

  try {
    return JSON.parse(contents) as PackageJsonManifest
  } catch {
    throw new Error(`Invalid package manifest: ${packageJsonPath}.`)
  }
}

function resolveHoloPluginEntry(manifest: PackageJsonManifest, packageJsonPath: string): string {
  if (!isRecord(manifest.holo)) {
    throw new Error(`Package ${String(manifest.name ?? packageJsonPath)} does not declare holo.plugin.`)
  }

  const entry = normalizeString(manifest.holo.plugin)
  if (!entry) {
    throw new Error(`Package ${String(manifest.name ?? packageJsonPath)} does not declare holo.plugin.`)
  }

  if (isAbsolute(entry)) {
    throw new Error(`Plugin entry must be package-relative: ${entry}.`)
  }

  const packageRoot = dirname(packageJsonPath)
  const entryPath = resolve(packageRoot, entry)
  const relativeEntryPath = relative(packageRoot, entryPath)

  if (relativeEntryPath.startsWith('..') || isAbsolute(relativeEntryPath)) {
    throw new Error(`Plugin entry must stay inside the package root: ${entry}.`)
  }

  return entryPath
}

export function resolvePluginPackageJsonPath(projectRoot: string, packageName: string): string {
  assertValidPackageName(packageName)

  try {
    const projectRequire = createRequire(join(projectRoot, 'package.json'))
    return projectRequire.resolve(`${packageName}/package.json`)
  } catch {
    return join(projectRoot, 'node_modules', ...packageName.split('/'), 'package.json')
  }
}

export async function loadHoloPluginFromPackage(
  projectRoot: string,
  packageName: string,
): Promise<LoadedHoloPlugin> {
  const packageJsonPath = resolvePluginPackageJsonPath(projectRoot, packageName)
  const manifest = await readPackageJson(packageJsonPath)
  const entryPath = resolveHoloPluginEntry(manifest, packageJsonPath)

  if (!(await pathExists(entryPath))) {
    throw new Error(`Plugin entry does not exist: ${entryPath}.`)
  }

  const imported = await import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`) as unknown

  return {
    packageName,
    packageRoot: dirname(packageJsonPath),
    entryPath,
    definition: normalizeHoloPluginDefinition(imported),
  }
}

function resolvePluginModulePath(
  projectRoot: string,
  plugin: LoadedHoloPlugin,
  specifier: string,
): ResolvedPluginModulePath {
  const normalizedSpecifier = specifier.trim()
  if (!normalizedSpecifier) {
    throw new Error(`Plugin ${plugin.packageName} declared an empty module specifier.`)
  }

  if (isAbsolute(normalizedSpecifier)) {
    throw new Error(`Plugin ${plugin.packageName} module specifier must not be absolute: ${specifier}.`)
  }

  if (normalizedSpecifier.startsWith('.')) {
    const candidate = resolve(plugin.packageRoot, normalizedSpecifier)
    const relativePath = relative(plugin.packageRoot, candidate)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error(`Plugin ${plugin.packageName} module specifier must stay inside the package root: ${specifier}.`)
    }

    return {
      specifier: normalizedSpecifier,
      path: candidate,
    }
  }

  const projectRequire = createRequire(join(projectRoot, 'package.json'))
  return {
    specifier: normalizedSpecifier,
    path: projectRequire.resolve(normalizedSpecifier),
  }
}

async function importPluginModule(modulePath: ResolvedPluginModulePath): Promise<unknown> {
  if (!(await pathExists(modulePath.path))) {
    throw new Error(`Plugin module does not exist: ${modulePath.specifier}.`)
  }

  return await import(`${pathToFileURL(modulePath.path).href}?t=${Date.now()}`) as unknown
}

function normalizePluginCommandExports(
  moduleValue: unknown,
  plugin: LoadedHoloPlugin,
  modulePath: ResolvedPluginModulePath,
): readonly HoloAppCommand[] {
  const candidate = isRecord(moduleValue) && Array.isArray(moduleValue.commands)
    ? moduleValue.commands
    : isRecord(moduleValue) && typeof moduleValue.default !== 'undefined'
      ? moduleValue.default
      : moduleValue
  const commands = Array.isArray(candidate) ? candidate : [candidate]

  return Object.freeze(commands.map((command, index) => {
    if (!isHoloAppCommand(command) || !command.name?.trim()) {
      throw new Error(`Plugin ${plugin.packageName} command ${modulePath.specifier}#${index + 1} must define name, description, and run().`)
    }

    return Object.freeze({
      ...command,
      name: command.name.trim(),
    })
  }))
}

export async function loadProjectPluginCommands(projectRoot: string): Promise<readonly DiscoveredAppCommand[]> {
  const plugins = await resolveProjectPlugins(projectRoot)
  const commands: DiscoveredAppCommand[] = []

  for (const resolvedPlugin of plugins) {
    const loadedPlugin = resolvedPlugin.loaded
    const commandSpecifier = loadedPlugin?.definition.contributes?.cli?.commands
    if (!loadedPlugin || !commandSpecifier) {
      continue
    }

    const modulePath = resolvePluginModulePath(projectRoot, loadedPlugin, commandSpecifier)
    const moduleValue = await importPluginModule(modulePath)
    const pluginCommands = normalizePluginCommandExports(moduleValue, loadedPlugin, modulePath)

    for (const command of pluginCommands) {
      commands.push({
        sourcePath: `${loadedPlugin.packageName}:${modulePath.specifier}`,
        name: command.name ?? '',
        aliases: normalizeCommandAliases(command.aliases),
        description: command.description,
        usage: command.usage,
        async load() {
          return command
        },
      })
    }
  }

  return Object.freeze(commands)
}

export async function loadProjectPluginFrameworkDescriptors(projectRoot: string): Promise<readonly FrameworkDescriptor[]> {
  const plugins = await resolveProjectPlugins(projectRoot)
  const descriptors: FrameworkDescriptor[] = []
  const ids = new Set<string>()

  for (const resolvedPlugin of plugins) {
    const descriptor = resolvedPlugin.loaded?.definition.contributes?.framework
    if (!descriptor) {
      continue
    }

    if (ids.has(descriptor.id)) {
      throw new Error(`Duplicate plugin framework descriptor: ${descriptor.id}.`)
    }

    ids.add(descriptor.id)
    descriptors.push(descriptor)
  }

  return Object.freeze(descriptors)
}

export async function readProjectPluginNames(projectRoot: string): Promise<readonly string[]> {
  try {
    const config = await loadConfigDirectory(projectRoot, {
      preferCache: false,
      processEnv: process.env,
    })
    return Object.freeze([...new Set(config.app.plugins)])
  } catch {
    return await readProjectPluginNamesFromSource(projectRoot)
  }
}

async function readProjectPluginNamesFromSource(projectRoot: string): Promise<readonly string[]> {
  const manifestPath = await resolveFirstExistingPath(projectRoot, APP_CONFIG_FILE_NAMES)
  if (!manifestPath) {
    return Object.freeze([])
  }

  const contents = await readTextFile(manifestPath)
  if (!contents) {
    return Object.freeze([])
  }

  const pluginsMatch = contents.match(/^\s*plugins:\s*\[([\s\S]*?)\]/m)
    ?? contents.match(/^\s*"plugins":\s*\[([\s\S]*?)\]/m)
  if (!pluginsMatch) {
    return Object.freeze([])
  }

  const pluginBlock = pluginsMatch[1] ?? ''
  const pluginNames = [...pluginBlock.matchAll(/(['"])(.*?)\1/g)]
    .map(match => match[2]?.trim() ?? '')
    .filter(Boolean)

  return Object.freeze([...new Set(pluginNames)])
}

function renderPluginConfigProperty(packageNames: readonly string[]): string {
  if (packageNames.length === 0) {
    return '  plugins: [],\n'
  }

  return [
    '  plugins: [',
    ...packageNames.map(packageName => `    ${JSON.stringify(packageName)},`),
    '  ],',
    '',
  ].join('\n')
}

function replaceExistingPluginsProperty(contents: string, packageNames: readonly string[]): string | undefined {
  const nextProperty = renderPluginConfigProperty(packageNames)
  const nextContents = contents.replace(/^\s*(?:"plugins"|plugins):\s*\[[\s\S]*?\],?\n/m, nextProperty)
  return nextContents === contents ? undefined : nextContents
}

function hasNonLiteralPluginsProperty(contents: string): boolean {
  return /^\s*(?:"plugins"|plugins)\s*[:,]/m.test(contents)
}

function insertPluginsProperty(contents: string, packageNames: readonly string[]): string | undefined {
  if (hasNonLiteralPluginsProperty(contents)) {
    return undefined
  }

  const nextProperty = renderPluginConfigProperty(packageNames)
  const pathsMatch = contents.match(/^\s*(?:"paths"|paths):\s*\{/m)
  if (pathsMatch?.index === undefined) {
    const openConfigMatch = contents.match(/defineAppConfig\(\{\s*\n/)
    if (openConfigMatch?.index !== undefined) {
      const insertIndex = openConfigMatch.index + openConfigMatch[0].length
      return `${contents.slice(0, insertIndex)}${nextProperty}${contents.slice(insertIndex)}`
    }

    const emptyConfigMatch = contents.match(/defineAppConfig\(\{\s*\}\)/)
    return emptyConfigMatch
      ? contents.replace(emptyConfigMatch[0], `defineAppConfig({\n${nextProperty}})`)
      : undefined
  }

  return `${contents.slice(0, pathsMatch.index)}${nextProperty}${contents.slice(pathsMatch.index)}`
}

export async function writeProjectPluginNames(
  projectRoot: string,
  packageNames: readonly string[],
): Promise<boolean> {
  const manifestPath = await resolveFirstExistingPath(projectRoot, APP_CONFIG_FILE_NAMES)
  if (!manifestPath) {
    throw new Error(`Missing config/app.(ts|mts|js|mjs) in ${projectRoot}.`)
  }

  const contents = await readTextFile(manifestPath)
  if (!contents) {
    throw new Error(`Missing app config: ${manifestPath}.`)
  }

  const normalized = [...new Set(packageNames.map(packageName => packageName.trim()).filter(Boolean))]
  const nextContents = replaceExistingPluginsProperty(contents, normalized)
    ?? insertPluginsProperty(contents, normalized)

  if (!nextContents) {
    throw new Error(`Unable to update ${manifestPath} automatically. Add plugins: ${JSON.stringify(normalized)} to defineAppConfig().`)
  }

  if (nextContents === contents) {
    return false
  }

  await writeTextFile(manifestPath, nextContents)
  return true
}

export async function activateProjectPlugin(
  projectRoot: string,
  packageName: string,
): Promise<boolean> {
  assertValidPackageName(packageName)

  const plugins = await readProjectPluginNames(projectRoot)
  if (plugins.includes(packageName)) {
    return false
  }

  return await writeProjectPluginNames(projectRoot, [...plugins, packageName])
}

export async function deactivateProjectPlugin(
  projectRoot: string,
  packageName: string,
): Promise<boolean> {
  assertValidPackageName(packageName)

  const plugins = await readProjectPluginNames(projectRoot)
  if (!plugins.includes(packageName)) {
    return false
  }

  return await writeProjectPluginNames(projectRoot, plugins.filter(plugin => plugin !== packageName))
}

export async function resolveProjectPlugins(projectRoot: string): Promise<readonly ResolvedProjectPlugin[]> {
  const packageNames = await readProjectPluginNames(projectRoot)
  const resolved: ResolvedProjectPlugin[] = []

  for (const packageName of packageNames) {
    try {
      resolved.push({
        packageName,
        loaded: await loadHoloPluginFromPackage(projectRoot, packageName),
      })
    } catch (error) {
      resolved.push({
        packageName,
        error: error instanceof Error && error.message ? error.message : `Failed to load ${packageName}.`,
      })
    }
  }

  return Object.freeze(resolved)
}
