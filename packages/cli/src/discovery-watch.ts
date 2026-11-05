import { realpathSync, watch, type WatchEventType } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { HoloProjectPrepareChange, HoloProjectPrepareWatch } from '@holo-js/kernel'
import type { LoadedProjectConfig } from './types'
import type { WatchFactory, WatchHandle } from './cli-types'
import type { ObservedPrepareChange } from './framework-restart'
import { isUnchangedWrittenOutput, PACKAGE_MANIFEST_DISCOVERY_PATHS } from './written-outputs'
import { resolveProjectPlugins } from './project/plugins'
import { normalizeArtifactPath } from './project/plugin-prepare/paths'
import { isIgnorableWatchError, isRecursiveWatchUnsupported, normalizeWatchedFilePath, toPosixSlashes } from './watch-paths'

export { PACKAGE_MANIFEST_DISCOVERY_PATHS }

export const DISCOVERY_WATCH_PROBE_PATH = '.holo-js/runtime/discovery-watch.probe'

const ATOMIC_WRITE_STAGING_FILE = /\.holo-\d+-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.(?:tmp|backup)$/

const LIVENESS_PROBE_INTERVAL_MS = 50
const LIVENESS_TIMEOUT_MS = 10_000

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

async function readPluginPrepareWatches(projectRoot: string): Promise<readonly PluginPrepareWatch[]> {
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
  return Object.freeze([
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
  ].map(root => toPosixSlashes(normalize(root)).replace(/\/+$/, '') || '.'))
}

function resolveGeneratedSchemaPath(project: LoadedProjectConfig): string {
  return project.config.paths.generatedSchema ?? '.holo-js/generated/schema.generated.ts'
}

function isAlwaysWatchedPath(path: string, project: LoadedProjectConfig): boolean {
  return PACKAGE_MANIFEST_DISCOVERY_PATHS.has(path) || path === toPosixSlashes(resolveGeneratedSchemaPath(project))
}

function isDiscoveryRelevantPath(
  filePath: string,
  project: LoadedProjectConfig,
  pluginWatches: readonly PluginPrepareWatch[] = [],
): boolean {
  const normalized = toPosixSlashes(filePath)
  if (isAlwaysWatchedPath(normalized, project)) {
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

async function collectDirectoryTree(
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

function collectWatchRootPaths(
  project: LoadedProjectConfig,
  pluginWatches: readonly PluginPrepareWatch[],
): readonly string[] {
  return [...new Set([...resolveConfiguredDiscoveryRoots(project), ...pluginWatches.flatMap(watch => watch.roots)])]
}

async function findNearestExistingAncestor(projectRoot: string, path: string): Promise<string | undefined> {
  if (await stat(path).catch(() => undefined)) return undefined
  let ancestor = dirname(path)
  while (ancestor !== projectRoot && ancestor.startsWith(`${projectRoot}${sep}`)) {
    const ancestorStats = await stat(ancestor).catch(() => undefined)
    if (ancestorStats) return ancestorStats.isDirectory() ? ancestor : undefined
    ancestor = dirname(ancestor)
  }
  return undefined
}

async function collectDiscoveryWatchRoots(
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
    dirname(resolveGeneratedSchemaPath(project)),
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

  for (const root of collectWatchRootPaths(project, pluginWatches)) {
    const ancestor = await findNearestExistingAncestor(projectRoot, resolve(projectRoot, root))
    if (ancestor && !hostExcludedPaths.some(excludedPath => ancestor === excludedPath || ancestor.startsWith(`${excludedPath}${sep}`))) {
      directories.add(ancestor)
    }
  }

  return [...directories]
}

function normalizeContainedWatchedFilePath(
  projectRoot: string,
  watchedRoot: string,
  fileName: string,
  canonicalProjectRoot: string,
): string | undefined {
  const normalized = normalizeWatchedFilePath(projectRoot, watchedRoot, fileName)
  if (isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    return undefined
  }

  let target = resolve(projectRoot, normalized)
  while (true) {
    try {
      const canonicalRelative = relative(canonicalProjectRoot, realpathSync(target))
      return isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)
        ? undefined
        : normalized
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT' || target === projectRoot) return undefined
      target = dirname(target)
    }
  }
}

type WatchedPathSnapshot = {
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
  directories: readonly string[],
): Promise<Map<string, WatchedPathSnapshot>> {
  const snapshots = new Map<string, WatchedPathSnapshot>()

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

function classifyWatchedPathChange(
  path: string,
  snapshot: WatchedPathSnapshot | undefined,
  snapshots: Map<string, WatchedPathSnapshot>,
  previous: WatchedPathSnapshot | undefined,
): HoloProjectPrepareChange {
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

type WatchPolicyBaseline = {
  readonly project: LoadedProjectConfig
  readonly pluginWatches: readonly PluginPrepareWatch[]
  readonly snapshots: ReadonlyMap<string, WatchedPathSnapshot>
  readonly directories: ReadonlySet<string>
  readonly listedRoots: readonly string[]
  readonly paths: ReadonlySet<string>
}

const EXISTED_AT_STARTUP: WatchedPathSnapshot = Object.freeze({ modifiedAt: 0, size: 0 })

async function collectStartupPaths(
  projectRoot: string,
  roots: readonly string[],
  pluginWatches: readonly PluginPrepareWatch[],
): Promise<ReadonlySet<string>> {
  const isExcluded = (path: string): boolean => isAlwaysExcludedWatchPath(path)
    || pluginWatches.some(watch => watch.packageRoot !== undefined && pathIsWithin(path, watch.packageRoot))
  const paths = new Set<string>()
  const pending = roots.filter(root => !isExcluded(root))
  while (pending.length > 0) {
    const directory = pending.pop() as string
    const entries = await readdir(resolve(projectRoot, directory), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = directory === '.' ? entry.name : `${directory}/${entry.name}`
      if (paths.has(path) || isExcluded(path)) continue
      paths.add(path)
      if (entry.isDirectory()) pending.push(path)
    }
  }
  return paths
}

type DiscoveryWatchOptions = {
  readonly projectRoot: string
  readonly project: LoadedProjectConfig
  readonly signal: AbortSignal
  readonly createWatcher?: WatchFactory
  readonly observe: (change: ObservedPrepareChange) => void
  readonly writeWarning: (message: string) => void
  readonly deferred?: boolean
}

type DiscoveryWatch = {
  readonly ready: Promise<void>
  refresh(project: LoadedProjectConfig): Promise<void>
  resume(): void
  close(): void
}

function waitForLivenessOrProbeInterval(liveness: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    liveness,
    new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, LIVENESS_PROBE_INTERVAL_MS) }),
  ]).finally(() => clearTimeout(timer))
}

export async function startDiscoveryWatch({
  projectRoot,
  project: initialProject,
  signal,
  createWatcher = watch,
  observe,
  writeWarning,
  deferred = false,
}: DiscoveryWatchOptions): Promise<DiscoveryWatch> {
  const canonicalProjectRoot = await realpath(projectRoot)
  let project = initialProject
  let pluginWatches: readonly PluginPrepareWatch[] = []
  let snapshots = new Map<string, WatchedPathSnapshot>()
  let policyKey: string | undefined
  let recursive: boolean | undefined
  let closed = false
  let generation = 0
  const handles: WatchHandle[] = []
  let watchedDirectories: readonly string[] = []
  let startupBaseline: WatchPolicyBaseline | undefined
  const warnedPlugins = new Set<string>()
  let deferredEvents: Map<string, WatchEventType> | undefined = deferred ? new Map() : undefined
  let probing = true
  let stopProbing = (): void => {}
  const liveness = new Promise<void>((resolvePromise) => {
    stopProbing = () => {
      probing = false
      resolvePromise()
    }
  })

  const releaseHandles = (): void => {
    generation++
    while (handles.length > 0) handles.pop()?.close()
  }

  const close = (): void => {
    if (closed) return
    closed = true
    deferredEvents = undefined
    signal.removeEventListener('abort', close)
    releaseHandles()
    stopProbing()
  }

  const dispatch = (path: string, eventType: WatchEventType): void => {
    if (!isDiscoveryRelevantPath(path, project, pluginWatches)) return
    const unchanged = isUnchangedWrittenOutput(resolve(projectRoot, path))
    const observedSnapshot = eventType === 'rename' ? readWatchedPathSnapshot(resolve(projectRoot, path)) : undefined
    observe(async () => {
      const change = observedSnapshot
        ? classifyWatchedPathChange(path, await observedSnapshot, snapshots, snapshots.get(path))
        : { path, kind: 'changed' as const }
      return await unchanged ? [] : change
    })
  }

  const findStartupSnapshot = (path: string, baseline: WatchPolicyBaseline | undefined): WatchedPathSnapshot | undefined => {
    if (!baseline || isDiscoveryRelevantPath(path, baseline.project, baseline.pluginWatches)) {
      return (baseline?.snapshots ?? snapshots).get(path)
    }
    if (!baseline.listedRoots.some(root => pathIsWithin(path, root))) return snapshots.get(path)
    return baseline.paths.has(path) ? EXISTED_AT_STARTUP : undefined
  }

  const findGainedDirectories = (baseline: WatchPolicyBaseline, eventPaths: readonly string[]): readonly string[] => {
    const startupRoots = collectWatchRootPaths(baseline.project, baseline.pluginWatches)
    const currentRoots = collectWatchRootPaths(project, pluginWatches)
    const gained = [...new Set([
      ...watchedDirectories
        .filter(directory => !baseline.directories.has(directory))
        .map(directory => toPosixSlashes(relative(projectRoot, directory))),
      ...currentRoots.filter(root => !startupRoots.includes(root) && !watchedDirectories.includes(resolve(projectRoot, root))),
      ...currentRoots.filter(root => eventPaths.some(path => pathIsWithin(root, path))),
    ])].filter(path => isDiscoveryRelevantPath(path, project, pluginWatches))
    return gained.filter(path => !gained.some(other => other !== path
      && pathIsWithin(path, other)
      && currentRoots.every(root => !pathIsWithin(path, root) || pathIsWithin(other, root))))
  }

  const classify = async (
    path: string,
    eventType: WatchEventType,
    previous: WatchedPathSnapshot | undefined,
  ): Promise<HoloProjectPrepareChange> => {
    if (eventType !== 'rename') return { path, kind: 'changed' }
    const snapshot = await readWatchedPathSnapshot(resolve(projectRoot, path))
    return classifyWatchedPathChange(path, snapshot, snapshots, previous)
  }

  const defer = (events: Map<string, WatchEventType>, path: string, eventType: WatchEventType): void => {
    if (isAlwaysExcludedWatchPath(path) && !isAlwaysWatchedPath(path, project)) return
    if (events.get(path) !== 'rename') events.set(path, eventType)
  }

  const acquire = (root: string, recursive: boolean): void => {
    if (closed || signal.aborted) return
    const acquiredGeneration = generation
    const handle = createWatcher(root, { recursive }, (eventType, fileName) => {
      if (closed || signal.aborted || acquiredGeneration !== generation || typeof fileName !== 'string') return
      const path = normalizeContainedWatchedFilePath(projectRoot, root, fileName, canonicalProjectRoot)
      if (!path || ATOMIC_WRITE_STAGING_FILE.test(path)) return
      if (path === DISCOVERY_WATCH_PROBE_PATH) {
        stopProbing()
        return
      }
      if (deferredEvents) defer(deferredEvents, path, eventType)
      else dispatch(path, eventType)
    })
    if (closed || signal.aborted) handle.close()
    else handles.push(handle)
  }

  const updatePolicy = async (nextProject: LoadedProjectConfig): Promise<readonly string[]> => {
    if (closed) return []
    signal.throwIfAborted()
    const nextPluginWatches = await readPluginPrepareWatches(projectRoot)
    signal.throwIfAborted()
    if (closed) return []
    const nextPolicyKey = JSON.stringify([
      resolveConfiguredDiscoveryRoots(nextProject),
      nextProject.config.paths.generatedSchema,
      nextPluginWatches,
    ])
    const policyChanged = policyKey !== nextPolicyKey
    const directories = recursive !== true || policyChanged
      ? await collectDiscoveryWatchRoots(projectRoot, nextProject, nextPluginWatches)
      : []
    const nextSnapshots = policyChanged
      ? await collectWatchedPathSnapshots(projectRoot, nextProject, nextPluginWatches, directories)
      : snapshots
    signal.throwIfAborted()
    if (closed) return []
    project = nextProject
    pluginWatches = nextPluginWatches
    snapshots = nextSnapshots
    policyKey = nextPolicyKey
    for (const declaration of pluginWatches) {
      if (!declaration.roots.includes('.') || warnedPlugins.has(declaration.pluginId)) continue
      warnedPlugins.add(declaration.pluginId)
      writeWarning(`[${declaration.pluginId}] Project prepare watch root "." watches the entire application and may increase watcher work.\n`)
    }
    return directories
  }

  const acquireDirectories = (directories: readonly string[]): void => {
    releaseHandles()
    const acquired: string[] = []
    watchedDirectories = acquired
    try {
      for (const directory of directories) {
        if (closed || signal.aborted) return
        try {
          acquire(directory, false)
          acquired.push(directory)
        } catch (error) {
          if (!isIgnorableWatchError(error)) throw error
        }
      }
    } catch (error) {
      releaseHandles()
      throw error
    }
  }

  const refresh = async (nextProject: LoadedProjectConfig): Promise<void> => {
    const directories = await updatePolicy(nextProject)
    if (recursive === false && !closed) acquireDirectories(directories)
  }

  const resume = (): void => {
    const events = deferredEvents
    const baseline = startupBaseline
    deferredEvents = undefined
    startupBaseline = undefined
    if (!events || closed || signal.aborted) return
    const gainedRoots = baseline && recursive === false ? findGainedDirectories(baseline, [...events.keys()]) : []
    const relevant = [...events]
      .filter(([path]) => isDiscoveryRelevantPath(path, project, pluginWatches) && !gainedRoots.includes(path))
      .map(([path, eventType]) => ({ path, eventType, previous: findStartupSnapshot(path, baseline) }))
    if (relevant.length === 0 && gainedRoots.length === 0) return
    observe(async () => {
      const changes = await Promise.all(relevant.map(async ({ path, eventType, previous }) => {
        const change = await classify(path, eventType, previous)
        return await isUnchangedWrittenOutput(resolve(projectRoot, path)) ? undefined : change
      }))
      return [
        ...gainedRoots.map(path => ({ path, kind: 'changed' as const })),
        ...changes.filter(change => change !== undefined),
      ]
    })
  }

  const probeLiveness = async (): Promise<void> => {
    if (!probing) return
    const probePath = resolve(projectRoot, DISCOVERY_WATCH_PROBE_PATH)
    const deadline = Date.now() + LIVENESS_TIMEOUT_MS
    try {
      await mkdir(dirname(probePath), { recursive: true })
      for (let attempt = 0; probing; attempt++) {
        if (Date.now() >= deadline) {
          writeWarning(`[Holo CLI] The file watcher did not confirm it was watching within ${LIVENESS_TIMEOUT_MS / 1000} seconds. Source edits may not be reflected until the next edit.\n`)
          return
        }
        await writeFile(probePath, String(attempt))
        await waitForLivenessOrProbeInterval(liveness)
      }
    } catch (error) {
      writeWarning(`[Holo CLI] Unable to confirm the file watcher is watching: ${error instanceof Error ? error.message : String(error)}\n`)
    } finally {
      await rm(probePath, { force: true }).catch(() => undefined)
    }
  }

  signal.addEventListener('abort', close, { once: true })
  try {
    const directories = await updatePolicy(project)
    const listedRoots = deferred ? collectWatchRootPaths(project, pluginWatches) : []
    const startupPaths = await collectStartupPaths(projectRoot, listedRoots, pluginWatches)
    signal.throwIfAborted()
    try {
      acquire(projectRoot, true)
      recursive = true
    } catch (error) {
      if (!isRecursiveWatchUnsupported(error)) throw error
      recursive = false
    }
    if (recursive === false) {
      acquireDirectories(directories)
      stopProbing()
    }
    if (deferred) startupBaseline = Object.freeze({ project, pluginWatches, snapshots, directories: new Set(watchedDirectories), listedRoots, paths: startupPaths })
    return { ready: probeLiveness(), refresh, resume, close }
  } catch (error) {
    close()
    throw error
  }
}
