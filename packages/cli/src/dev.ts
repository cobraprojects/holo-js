import { spawnSync, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  readTextFile,
  ensureProjectConfig,
  ensureGeneratedSchemaPlaceholder,
  syncManagedDriverDependencies,
  prepareProjectDiscovery,
  renderFrameworkRunnerForDescriptor,
  writeTextFile,
} from './project'
import { hasProjectDependency } from './package-json'
import type {
  IoStreams,
  PackageManagerCommand,
  SpawnProcessLike,
  WatchFactory,
  WatchHandle,
  SupportedScaffoldPackageManager,
} from './cli-types'
import type { LoadedProjectConfig } from './types'
import {
  getFrameworkDescriptorByIdFrom,
  getFrameworkDescriptorsWith,
  type FrameworkDescriptor,
} from './project/frameworks'
import { loadProjectPluginFrameworkDescriptors, resolveProjectPlugins } from './project/plugins'
import {
  runPluginProjectPreparers,
} from './project/plugin-prepare/coordinator'
import { normalizeArtifactPath } from './project/plugin-prepare/paths'
import type {
  HoloProjectPrepareChange,
  HoloProjectPrepareCommand,
  HoloProjectPrepareRun,
  HoloProjectPrepareWatch,
} from '@holo-js/kernel'

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function resolveProjectPackageManager(projectRoot: string): Promise<SupportedScaffoldPackageManager> {
  const packageJsonPath = join(projectRoot, 'package.json')
  const packageJson = await readTextFile(packageJsonPath)

  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { packageManager?: unknown }
      const packageManager = typeof parsed.packageManager === 'string' ? parsed.packageManager.split('@')[0] : undefined

      if (packageManager === 'bun' || packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
        return packageManager
      }
    } catch {
      // Fall back to lockfile detection below.
    }
  }

  if (await fileExists(join(projectRoot, 'bun.lock'))) {
    return 'bun'
  }

  if (await fileExists(join(projectRoot, 'pnpm-lock.yaml'))) {
    return 'pnpm'
  }

  if (await fileExists(join(projectRoot, 'yarn.lock'))) {
    return 'yarn'
  }

  if (await fileExists(join(projectRoot, 'package-lock.json'))) {
    return 'npm'
  }

  return 'bun'
}

export { hasProjectDependency }

export async function resolvePackageManagerCommand(projectRoot: string, scriptName: string): Promise<PackageManagerCommand> {
  const packageManager = await resolveProjectPackageManager(projectRoot)
  return {
    command: packageManager,
    args: ['run', scriptName],
  }
}

export async function resolvePackageManagerInstallInvocation(projectRoot: string): Promise<PackageManagerCommand> {
  const packageManager = await resolveProjectPackageManager(projectRoot)
  return {
    command: packageManager,
    args: ['install'],
  }
}

function resolveFrameworkRunnerInvocation(projectRoot: string, mode: 'dev' | 'build' | 'start'): PackageManagerCommand {
  return {
    command: process.execPath,
    args: [join(projectRoot, '.holo-js/framework/run.mjs'), mode],
  }
}

export async function runProjectBuild(
  io: IoStreams,
  projectRoot: string,
  spawn: typeof spawnSync = spawnSync,
  passthroughArgs: readonly string[] = [],
): Promise<void> {
  const invocation = resolveFrameworkRunnerInvocation(projectRoot, 'build')
  const result = spawn(invocation.command, [...invocation.args, ...passthroughArgs], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: process.env,
  })

  if (result.stdout) {
    io.stdout.write(result.stdout)
  }

  if (result.stderr) {
    io.stderr.write(result.stderr)
  }

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Project build failed.')
  }
}

export async function runProjectStartServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  passthroughArgs: readonly string[] = [],
): Promise<void> {
  const invocation = resolveFrameworkRunnerInvocation(projectRoot, 'start')
  const child = spawnProcess(invocation.command, [...invocation.args, ...passthroughArgs], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as SpawnProcessLike

  child.stdout?.on('data', chunk => io.stdout.write(chunk))
  child.stderr?.on('data', chunk => io.stderr.write(chunk))
  if (child.stdin) {
    io.stdin.pipe(child.stdin)
  }

  const result = await new Promise<
    | { kind: 'close', code: number | null }
    | { kind: 'error', error: Error }
  >((resolvePromise) => {
    child.on('error', (error: Error) => resolvePromise({ kind: 'error', error }))
    child.on('close', (code: number | null) => resolvePromise({ kind: 'close', code }))
  })

  if (result.kind === 'error') {
    throw result.error
  }

  if (result.code !== 0) {
    throw new Error(`Project production server failed with exit code ${result.code ?? 'unknown'}.`)
  }
}

export async function runProjectDependencyInstall(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  const invocation = await resolvePackageManagerInstallInvocation(projectRoot)
  const child = spawnProcess(invocation.command, [...invocation.args], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as SpawnProcessLike
  let stdout = ''
  let stderr = ''

  child.stdout?.on('data', chunk => stdout += String(chunk))
  child.stderr?.on('data', chunk => stderr += String(chunk))

  const result = await new Promise<
    | { kind: 'close', code: number | null }
    | { kind: 'error', error: Error }
  >((resolvePromise) => {
    child.on('error', error => resolvePromise({ kind: 'error', error }))
    child.on('close', code => resolvePromise({ kind: 'close', code }))
  })

  if (result.kind === 'error') {
    throw result.error
  }

  if (stdout) {
    io.stdout.write(stdout)
  }

  if (stderr) {
    io.stderr.write(stderr)
  }

  if (result.code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || 'Project dependency installation failed.')
  }
}

type ProjectPrepareOptions = {
  readonly prepareSchema?: boolean
  readonly syncFramework?: boolean
  readonly command?: HoloProjectPrepareCommand
  readonly reason?: Extract<HoloProjectPrepareRun, { kind: 'full' }>['reason']
  readonly changes?: readonly HoloProjectPrepareChange[]
  readonly signal?: AbortSignal
}

type FrameworkSyncDefinition = {
  readonly framework: string
  readonly commands: Record<SupportedScaffoldPackageManager, readonly [string, ...string[]]>
  readonly errorLabel: string
}

export async function runProjectPrepare(
  projectRoot: string,
  io?: IoStreams,
  options: ProjectPrepareOptions = {},
): Promise<void> {
  const project = options.prepareSchema === false
    ? await ensureProjectConfig(projectRoot)
    : await prepareProjectSchema(projectRoot)
  const frameworkProjectPath = resolve(projectRoot, '.holo-js/framework/project.json')
  const framework = await resolveProjectFramework(projectRoot, frameworkProjectPath)
  const command = options.command ?? 'prepare'
  const run: HoloProjectPrepareRun = options.changes && command === 'dev'
    ? { kind: 'incremental', command: 'dev', changes: options.changes }
    : { kind: 'full', command, reason: options.reason ?? (command === 'prepare' ? 'explicit' : 'initial') }
  await runPluginProjectPreparers(projectRoot, project.config, {
    run,
    ...(framework ? {
      framework: {
        id: framework.id,
        displayName: framework.displayName,
        adapterPackage: framework.adapterPackage,
        ...(framework.fluxPackage ? { fluxPackage: framework.fluxPackage } : {}),
        capabilities: framework.capabilities,
      },
    } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    writeInfo: message => io?.stdout.write(`${message}\n`),
    writeWarning: message => io?.stderr.write(`${message}\n`),
  })
  await refreshFrameworkRunner(projectRoot)

  const syncFramework = options.syncFramework ?? true
  const syncDefinitions = syncFramework
    ? await resolveProjectFrameworkSyncDefinitions(projectRoot)
    : []
  if (syncFramework) {
    for (const definition of syncDefinitions) {
      await runFrameworkSync(projectRoot, definition)
    }
  }

  const updatedDependencies = await syncManagedDriverDependencies(projectRoot)
  if (updatedDependencies && io) {
    await runProjectDependencyInstall(io, projectRoot)
    const refreshedProject = await ensureProjectConfig(projectRoot)
    await prepareProjectDiscovery(projectRoot, refreshedProject.config)
    const refreshedFramework = await resolveProjectFramework(projectRoot, frameworkProjectPath)
    await runPluginProjectPreparers(projectRoot, refreshedProject.config, {
      run: { kind: 'full', command, reason: 'dependencies-changed' },
      ...(refreshedFramework ? {
        framework: {
          id: refreshedFramework.id,
          displayName: refreshedFramework.displayName,
          adapterPackage: refreshedFramework.adapterPackage,
          ...(refreshedFramework.fluxPackage ? { fluxPackage: refreshedFramework.fluxPackage } : {}),
          capabilities: refreshedFramework.capabilities,
        },
      } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      writeInfo: message => io.stdout.write(`${message}\n`),
      writeWarning: message => io.stderr.write(`${message}\n`),
    })
    await refreshFrameworkRunner(projectRoot)
    if (syncFramework) {
      const refreshedSyncDefinitions = await resolveProjectFrameworkSyncDefinitions(projectRoot)
      for (const definition of refreshedSyncDefinitions) {
        await runFrameworkSync(projectRoot, definition)
      }
    }
  }
}

export async function prepareProjectSchema(projectRoot: string): Promise<Awaited<ReturnType<typeof ensureProjectConfig>>> {
  const project = await ensureProjectConfig(projectRoot)
  await ensureGeneratedSchemaPlaceholder(projectRoot, project.config)
  await prepareProjectDiscovery(projectRoot, project.config)
  return project
}

export async function runProjectBuildPrepare(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), 'project-prepare-worker.mjs')
  const child = spawnProcess(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: { ...process.env, HOLO_PROJECT_PREPARE_ROOT: projectRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
  }) as SpawnProcessLike
  let stderr = ''
  child.stdout?.on('data', chunk => io.stdout.write(chunk))
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
    io.stderr.write(chunk)
  })
  const result = await new Promise<{ readonly code: number | null } | { readonly error: Error }>((resolvePromise) => {
    child.on('error', error => resolvePromise({ error }))
    child.on('close', code => resolvePromise({ code }))
  })
  if ('error' in result) throw result.error
  if (result.code !== 0) throw new Error(stderr.trim() || 'Project preparation failed after generated schema hydration.')
}

async function runProjectHotPrepare(
  projectRoot: string,
  io?: IoStreams,
  changes: readonly HoloProjectPrepareChange[] = [],
  signal?: AbortSignal,
): Promise<void> {
  await runProjectPrepare(projectRoot, io, { syncFramework: false, command: 'dev', changes, ...(signal ? { signal } : {}) })
}

async function refreshFrameworkRunner(projectRoot: string): Promise<void> {
  const frameworkProjectPath = resolve(projectRoot, '.holo-js/framework/project.json')
  const frameworkRunnerPath = resolve(projectRoot, '.holo-js/framework/run.mjs')
  const descriptor = await resolveProjectFramework(projectRoot, frameworkProjectPath)

  if (!descriptor) {
    return
  }

  await writeTextFile(frameworkProjectPath, `${JSON.stringify({ framework: descriptor.id }, null, 2)}\n`)
  await writeTextFile(frameworkRunnerPath, renderFrameworkRunnerForDescriptor(descriptor))
}

async function resolveProjectFramework(
  projectRoot: string,
  frameworkProjectPath: string,
): Promise<FrameworkDescriptor | undefined> {
  const pluginDescriptors = await loadProjectPluginFrameworkDescriptors(projectRoot)
  try {
    const content = await readFile(frameworkProjectPath, 'utf8')
    const manifest = JSON.parse(content) as { framework?: unknown }
    const descriptor = typeof manifest.framework === 'string'
      ? getFrameworkDescriptorByIdFrom(manifest.framework, pluginDescriptors)
      : undefined

    return descriptor ?? resolveProjectFrameworkFromDependencies(projectRoot, pluginDescriptors)
  } catch {
    return resolveProjectFrameworkFromDependencies(projectRoot, pluginDescriptors)
  }
}

async function resolveProjectFrameworkFromDependencies(
  projectRoot: string,
  pluginDescriptors: readonly FrameworkDescriptor[] = [],
): Promise<FrameworkDescriptor | undefined> {
  for (const descriptor of getFrameworkDescriptorsWith(pluginDescriptors)) {
    const matches = await Promise.all(
      descriptor.detectPackages.map(packageName => hasProjectDependency(projectRoot, packageName)),
    )
    if (matches.some(Boolean)) {
      return descriptor
    }
  }

  return undefined
}

async function resolveProjectFrameworkSyncDefinitions(projectRoot: string): Promise<readonly FrameworkSyncDefinition[]> {
  const pluginDescriptors = await loadProjectPluginFrameworkDescriptors(projectRoot)
  const seen = new Set<string>()
  const definitions: FrameworkSyncDefinition[] = []

  for (const descriptor of getFrameworkDescriptorsWith(pluginDescriptors)) {
    if (!descriptor.sync || seen.has(descriptor.id)) {
      continue
    }

    seen.add(descriptor.id)
    definitions.push({
      framework: descriptor.id,
      commands: descriptor.sync.commands,
      errorLabel: descriptor.sync.errorLabel,
    })
  }

  return Object.freeze(definitions)
}

async function runFrameworkSync(projectRoot: string, definition: FrameworkSyncDefinition): Promise<void> {
  const frameworkProjectPath = resolve(projectRoot, '.holo-js/framework/project.json')
  try {
    const content = await readFile(frameworkProjectPath, 'utf8')
    const manifest = JSON.parse(content) as { framework?: string }

    if (manifest.framework !== definition.framework) {
      return
    }
  } catch {
    return
  }

  const manager = await resolveProjectPackageManager(projectRoot)
  const invocation = definition.commands[manager]
  const command = invocation[0]
  const args = invocation.slice(1)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`${definition.errorLabel} exited with ${code}`))
      }
    })
    child.on('error', reject)
  })
}

export function toPosixSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

const PACKAGE_MANIFEST_DISCOVERY_PATHS = new Set([
  'package.json',
  'bun.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

const ALWAYS_EXCLUDED_WATCH_ROOTS = [
  '.git',
  'node_modules',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'dist',
  'build',
]

type PluginPrepareWatch = Required<Pick<HoloProjectPrepareWatch, 'roots' | 'excludes'>> & {
  readonly pluginId: string
  readonly packageRoot?: string
}

function pathIsWithin(path: string, root: string): boolean {
  return root === '.' || path === root || path.startsWith(`${root}/`)
}

function isAlwaysExcludedWatchPath(path: string): boolean {
  return ALWAYS_EXCLUDED_WATCH_ROOTS.some(root => pathIsWithin(path, root))
    || path === '.holo-js'
    || path.startsWith('.holo-js/')
}

function normalizeStoredWatchPaths(paths: unknown): readonly string[] {
  if (!Array.isArray(paths)) {
    return []
  }

  if (!paths.every((path): path is string => typeof path === 'string')) {
    throw new Error('Stored plugin watch paths must be strings.')
  }

  return Object.freeze([...new Set(paths.map(path => normalizeArtifactPath(path, true)))].sort())
}

export async function readPluginPrepareWatches(projectRoot: string): Promise<readonly PluginPrepareWatch[]> {
  const manifestsRoot = resolve(projectRoot, '.holo-js/generated/.plugins')
  const entries = await readdir(manifestsRoot, { withFileTypes: true }).catch(() => [])
  const activePlugins = await resolveProjectPlugins(projectRoot)
  const canonicalProjectRoot = await realpath(projectRoot).catch(() => projectRoot)
  const activePluginIds = new Set<string>()
  const activePackageRoots = new Map<string, string>()
  for (const plugin of activePlugins) {
    if (!plugin.loaded) {
      continue
    }

    activePluginIds.add(plugin.loaded.definition.id)
    const canonicalPackageRoot = await realpath(plugin.loaded.packageRoot).catch(() => plugin.loaded?.packageRoot)
    if (!canonicalPackageRoot) {
      continue
    }
    const relativePackageRoot = toPosixSlashes(relative(canonicalProjectRoot, canonicalPackageRoot)) || '.'
    if (isAbsolute(relativePackageRoot) || relativePackageRoot === '..' || relativePackageRoot.startsWith('../')) {
      continue
    }

    activePackageRoots.set(plugin.loaded.definition.id, normalizeArtifactPath(relativePackageRoot, true))
  }
  const watches: PluginPrepareWatch[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    try {
      const pluginId = entry.name.slice(0, -'.json'.length)
      if (!activePluginIds.has(pluginId)) {
        continue
      }
      const manifest = JSON.parse(await readFile(resolve(manifestsRoot, entry.name), 'utf8')) as {
        readonly watch?: {
          readonly roots?: unknown
          readonly excludes?: unknown
        }
      }
      const roots = normalizeStoredWatchPaths(manifest.watch?.roots)
      const excludes = normalizeStoredWatchPaths(manifest.watch?.excludes)
      if (!excludes.every(exclude => roots.some(root => pathIsWithin(exclude, root)))) {
        throw new Error('Stored plugin watch exclusions must be below a watch root.')
      }
      const packageRoot = activePackageRoots.get(pluginId)
      watches.push(Object.freeze({ pluginId, roots, excludes, ...(packageRoot ? { packageRoot } : {}) }))
    } catch {
      continue
    }
  }

  return Object.freeze(watches)
}

function resolveConfiguredBroadcastPath(project: LoadedProjectConfig): string {
  const configuredPaths = project.config.paths as typeof project.config.paths & {
    readonly broadcast?: string
  }
  return configuredPaths.broadcast ?? 'server/broadcast'
}

function resolveConfiguredChannelsPath(project: LoadedProjectConfig): string {
  const configuredPaths = project.config.paths as typeof project.config.paths & {
    readonly channels?: string
  }
  return configuredPaths.channels ?? 'server/channels'
}

function resolveConfiguredRealtimePath(project: LoadedProjectConfig): string {
  const configuredPaths = project.config.paths as typeof project.config.paths & {
    readonly realtime?: string
  }
  return configuredPaths.realtime ?? 'server/realtime'
}

function resolveConfiguredDiscoveryRoots(project: LoadedProjectConfig): readonly string[] {
  const authorizationPoliciesPath = project.config.paths.authorizationPolicies || 'server/policies'
  const authorizationAbilitiesPath = project.config.paths.authorizationAbilities || 'server/abilities'
  return [
    project.config.paths.models,
    project.config.paths.migrations,
    project.config.paths.seeders,
    project.config.paths.commands,
    project.config.paths.jobs,
    project.config.paths.events,
    project.config.paths.listeners,
    authorizationPoliciesPath,
    authorizationAbilitiesPath,
    resolveConfiguredBroadcastPath(project),
    resolveConfiguredChannelsPath(project),
    resolveConfiguredRealtimePath(project),
    'config',
  ]
}

export function isDiscoveryRelevantPath(
  filePath: string,
  project: LoadedProjectConfig,
  pluginWatches: readonly PluginPrepareWatch[] = [],
): boolean {
  const normalized = toPosixSlashes(filePath)
  if (PACKAGE_MANIFEST_DISCOVERY_PATHS.has(normalized)) {
    return true
  }

  const generatedSchemaPath = toPosixSlashes(project.config.paths.generatedSchema ?? '.holo-js/generated/schema.generated.ts')
  if (normalized === generatedSchemaPath) {
    return true
  }

  if (pluginWatches.some(watch => watch.packageRoot && pathIsWithin(normalized, watch.packageRoot))) {
    return false
  }

  if (isAlwaysExcludedWatchPath(normalized)) {
    return false
  }

  if (normalized === '.env' || normalized.startsWith('.env.')) {
    return true
  }

  if (resolveConfiguredDiscoveryRoots(project).some(root => pathIsWithin(normalized, toPosixSlashes(root)))) {
    return true
  }

  return pluginWatches.some((watch) => {
    const included = watch.roots.some(root => pathIsWithin(normalized, root))
    const excluded = watch.excludes.some(exclude => pathIsWithin(normalized, exclude))
    return included && !excluded
  })
}

export function isRecursiveWatchUnsupported(error: unknown): boolean {
  return error instanceof Error
    && (
      error.message.includes('recursive')
      || ('code' in error && (error as { code?: string }).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')
    )
}

export function isIgnorableWatchError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (
      (error as { code?: string }).code === 'ENOENT'
      || (error as { code?: string }).code === 'EPERM'
    )
}

export async function collectDirectoryTree(
  rootPath: string,
  directories: Set<string>,
  excludedPaths: readonly string[] = [],
): Promise<void> {
  if (excludedPaths.some(excludedPath => rootPath === excludedPath || rootPath.startsWith(`${excludedPath}/`))) {
    return
  }

  const rootStats = await stat(rootPath).catch(() => undefined)
  if (!rootStats?.isDirectory()) {
    return
  }

  directories.add(rootPath)
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    await collectDirectoryTree(join(rootPath, entry.name), directories, excludedPaths)
  }
}

export async function collectDiscoveryWatchRoots(
  projectRoot: string,
  project: LoadedProjectConfig,
  pluginWatches: readonly PluginPrepareWatch[] = [],
): Promise<string[]> {
  const directories = new Set<string>()
  const hostExcludedPaths = [
    ...ALWAYS_EXCLUDED_WATCH_ROOTS.map(root => resolve(projectRoot, root)),
    ...pluginWatches.flatMap(watch => watch.packageRoot ? [resolve(projectRoot, watch.packageRoot)] : []),
  ]
  directories.add(projectRoot)

  for (const root of resolveConfiguredDiscoveryRoots(project)) {
    await collectDirectoryTree(resolve(projectRoot, root), directories, hostExcludedPaths)
  }

  const generatedSchemaDirectory = resolve(
    projectRoot,
    dirname(project.config.paths.generatedSchema ?? '.holo-js/generated/schema.generated.ts'),
  )
  await collectDirectoryTree(generatedSchemaDirectory, directories, hostExcludedPaths)

  for (const watch of pluginWatches) {
    const excludedPaths = [
      ...hostExcludedPaths,
      resolve(projectRoot, '.holo-js'),
      ...watch.excludes.map(exclude => resolve(projectRoot, exclude)),
    ]
    for (const root of watch.roots) {
      await collectDirectoryTree(resolve(projectRoot, root), directories, excludedPaths)
    }
  }

  return [...directories]
}

export function normalizeWatchedFilePath(
  projectRoot: string,
  watchedRoot: string,
  fileName: string,
): string {
  return toPosixSlashes(relative(projectRoot, resolve(watchedRoot, fileName)))
}

function normalizeContainedWatchedFilePath(
  projectRoot: string,
  watchedRoot: string,
  fileName: string,
): string | undefined {
  const normalized = normalizeWatchedFilePath(projectRoot, watchedRoot, fileName)
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return undefined
  }

  return normalized
}

export type WatchedPathSnapshot = {
  readonly modifiedAt: number
  readonly size: number
}

async function readWatchedPathSnapshot(path: string): Promise<WatchedPathSnapshot | undefined> {
  const pathStats = await stat(path).catch(() => undefined)
  if (!pathStats) {
    return undefined
  }

  return Object.freeze({ modifiedAt: pathStats.mtimeMs, size: pathStats.size })
}

async function collectWatchedPathSnapshots(
  projectRoot: string,
  project: LoadedProjectConfig,
  pluginWatches: readonly PluginPrepareWatch[],
): Promise<Map<string, WatchedPathSnapshot>> {
  const snapshots = new Map<string, WatchedPathSnapshot>()
  const directories = await collectDiscoveryWatchRoots(projectRoot, project, pluginWatches)

  await Promise.all(directories.map(async (directory) => {
    const directoryPath = toPosixSlashes(relative(projectRoot, directory)) || '.'
    const directorySnapshot = await readWatchedPathSnapshot(directory)
    if (directorySnapshot && isDiscoveryRelevantPath(directoryPath, project, pluginWatches)) {
      snapshots.set(directoryPath, directorySnapshot)
    }

    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.filter(entry => entry.isFile()).map(async (entry) => {
      const path = normalizeWatchedFilePath(projectRoot, directory, entry.name)
      if (!isDiscoveryRelevantPath(path, project, pluginWatches)) {
        return
      }

      const snapshot = await readWatchedPathSnapshot(resolve(directory, entry.name))
      if (snapshot) {
        snapshots.set(path, snapshot)
      }
    }))
  }))

  return snapshots
}

export function classifyWatchedPathChange(
  path: string,
  snapshot: WatchedPathSnapshot | undefined,
  snapshots: Map<string, WatchedPathSnapshot>,
): HoloProjectPrepareChange {
  const previous = snapshots.get(path)
  if (snapshot) {
    snapshots.set(path, snapshot)
  } else {
    snapshots.delete(path)
  }

  if (!previous && snapshot) {
    return { path, kind: 'created' }
  }
  if (previous && !snapshot) {
    return { path, kind: 'deleted' }
  }
  return { path, kind: 'changed' }
}

export async function runProjectDevServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  createWatcher: WatchFactory = watch,
  prepare: (projectRoot: string, io?: IoStreams) => Promise<void> = runProjectPrepare,
): Promise<void> {
  let project = await ensureProjectConfig(projectRoot)
  let pluginWatches: readonly PluginPrepareWatch[] = []
  let watchedPathSnapshots = new Map<string, WatchedPathSnapshot>()
  const warnedBroadWatchPlugins = new Set<string>()
  let classifyEvents = Promise.resolve()
  let refreshNonRecursiveWatchers: (() => Promise<void>) | undefined
  let requestChildRestart: (() => void) | undefined
  const hotPrepare = prepare === runProjectPrepare ? runProjectHotPrepare : prepare

  const shutdownController = new AbortController()
  const runDiscoveryPreparation = async (
    syncFramework = false,
    changes: readonly HoloProjectPrepareChange[] = [],
  ): Promise<void> => {
    if (prepare !== runProjectPrepare) {
      await (syncFramework ? prepare : hotPrepare)(projectRoot, io)
      return
    }

    if (syncFramework) {
      await runProjectPrepare(projectRoot, io, {
        command: 'dev',
        reason: 'initial',
        signal: shutdownController.signal,
      })
      return
    }

    const hasDependencyChange = changes.some(change => PACKAGE_MANIFEST_DISCOVERY_PATHS.has(change.path))
    const hasConfigurationChange = changes.some(change =>
      change.path === '.env'
      || change.path.startsWith('.env.')
      || change.path === 'config'
      || change.path.startsWith('config/'),
    )
    if (!hasDependencyChange && !hasConfigurationChange) {
      await runProjectHotPrepare(projectRoot, io, changes, shutdownController.signal)
      return
    }

    await runProjectPrepare(projectRoot, io, {
      syncFramework: false,
      command: 'dev',
      reason: hasDependencyChange ? 'dependencies-changed' : 'configuration-changed',
      signal: shutdownController.signal,
    })
  }

  const prepareDiscovery = async (
    syncFramework = false,
    changes: readonly HoloProjectPrepareChange[] = [],
  ): Promise<void> => {
    await runDiscoveryPreparation(syncFramework, changes)
    project = await ensureProjectConfig(projectRoot)
    const nextPluginWatches = await readPluginPrepareWatches(projectRoot)
    for (const watch of nextPluginWatches) {
      if (watch.roots.includes('.') && !warnedBroadWatchPlugins.has(watch.pluginId)) {
        warnedBroadWatchPlugins.add(watch.pluginId)
        io.stderr.write(`[${watch.pluginId}] Project prepare watch root "." watches the entire application and may increase watcher work.\n`)
      }
    }
    const watchRootsChanged = JSON.stringify(pluginWatches) !== JSON.stringify(nextPluginWatches)
    pluginWatches = nextPluginWatches
    if (syncFramework || watchRootsChanged) {
      watchedPathSnapshots = await collectWatchedPathSnapshots(projectRoot, project, pluginWatches)
    }
    await refreshNonRecursiveWatchers?.()
  }

  await prepareDiscovery(true)

  let pendingPrepare: Promise<void> | undefined
  let queued = false
  const pendingChanges = new Map<string, HoloProjectPrepareChange['kind']>()
  let shuttingDown = false
  const rerunPrepare = (change?: HoloProjectPrepareChange) => {
    /* v8 ignore next 3 */
    if (shuttingDown) {
      return
    }

    if (change) {
      pendingChanges.set(change.path, change.kind)
    }
    if (pendingPrepare) {
      queued = true
      return
    }

    const changes = [...pendingChanges.entries()]
      .map(([path, kind]) => ({ path, kind }))
      .sort((left, right) => left.path.localeCompare(right.path))
    pendingChanges.clear()
    pendingPrepare = prepareDiscovery(false, changes)
      .then(() => {
        requestChildRestart?.()
      })
      .catch((error) => {
        io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => {
        pendingPrepare = undefined
        if (queued) {
          queued = false
          rerunPrepare()
        }
      })
  }

  const observeWatchedPath = (path: string, eventType: string) => {
    if (eventType !== 'rename') {
      rerunPrepare({ path, kind: 'changed' })
      return
    }

    const observedSnapshot = readWatchedPathSnapshot(resolve(projectRoot, path))
    classifyEvents = classifyEvents.then(async () => {
      const snapshot = await observedSnapshot
      rerunPrepare(classifyWatchedPathChange(path, snapshot, watchedPathSnapshots))
    })
  }

  const closeWatchers = (() => {
    try {
      const watcher = createWatcher(projectRoot, { recursive: true }, (_eventType, fileName) => {
        if (shuttingDown || typeof fileName !== 'string') {
          return
        }

        const normalizedPath = normalizeContainedWatchedFilePath(projectRoot, projectRoot, fileName)
        if (!normalizedPath || !isDiscoveryRelevantPath(normalizedPath, project, pluginWatches)) {
          return
        }

        observeWatchedPath(normalizedPath, _eventType)
      })

      return () => watcher.close()
    } catch (error) {
      if (!isRecursiveWatchUnsupported(error)) {
        throw error
      }

      const watchers: WatchHandle[] = []
      const closeAllWatchers = () => {
        while (watchers.length > 0) {
          watchers.pop()?.close()
        }
      }

      refreshNonRecursiveWatchers = async () => {
        closeAllWatchers()
        const watchRoots = await collectDiscoveryWatchRoots(projectRoot, project, pluginWatches)
        for (const watchRoot of watchRoots) {
          try {
            watchers.push(createWatcher(watchRoot, { recursive: false }, (_eventType, fileName) => {
              if (shuttingDown || typeof fileName !== 'string') {
                return
              }

              const normalizedPath = normalizeContainedWatchedFilePath(projectRoot, watchRoot, fileName)
              if (!normalizedPath || !isDiscoveryRelevantPath(normalizedPath, project, pluginWatches)) {
                return
              }

              observeWatchedPath(normalizedPath, _eventType)
            }))
          } catch (watchError) {
            if (!isIgnorableWatchError(watchError)) {
              throw watchError
            }
          }
        }
      }

      return () => closeAllWatchers()
    }
  })()

  await refreshNonRecursiveWatchers?.()

  const invocation = resolveFrameworkRunnerInvocation(projectRoot, 'dev')
  while (!shuttingDown) {
    const child = spawnProcess(invocation.command, [...invocation.args], {
      cwd: projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as SpawnProcessLike

    child.stdout?.on('data', chunk => io.stdout.write(chunk))
    child.stderr?.on('data', chunk => io.stderr.write(chunk))
    if (child.stdin) {
      io.stdin.pipe(child.stdin)
    }

    const result = await new Promise<
      { kind: 'restart' }
      | { kind: 'close', code: number | null }
      | { kind: 'error', error: Error }
    >((resolvePromise) => {
      let restartRequested = false

      requestChildRestart = () => {
        if (restartRequested || shuttingDown || typeof child.kill !== 'function') {
          return
        }

        restartRequested = true
        child.kill('SIGTERM')
      }

      child.on('error', (error) => {
        if (child.stdin) {
          io.stdin.unpipe(child.stdin)
        }
        requestChildRestart = undefined
        if (restartRequested) {
          resolvePromise({ kind: 'restart' })
          return
        }

        resolvePromise({ kind: 'error', error })
      })
      child.on('close', (code) => {
        if (child.stdin) {
          io.stdin.unpipe(child.stdin)
        }
        requestChildRestart = undefined
        if (restartRequested) {
          resolvePromise({ kind: 'restart' })
          return
        }

        resolvePromise({ kind: 'close', code })
      })
    })

    if (result.kind === 'restart') {
      continue
    }

    shuttingDown = true
    shutdownController.abort()
    closeWatchers()
    await Promise.resolve(pendingPrepare)

    if (result.kind === 'error') {
      throw result.error
    }

    if (result.code === 0) {
      return
    }

    throw new Error(`Project development server failed with exit code ${result.code ?? 'unknown'}.`)
  }
}
