import { spawnSync, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, dirname, relative, resolve } from 'node:path'
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
import { loadProjectPluginFrameworkDescriptors } from './project/plugins'

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
): Promise<void> {
  const invocation = resolveFrameworkRunnerInvocation(projectRoot, 'build')
  const result = spawn(invocation.command, [...invocation.args], {
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
  spawn: typeof spawnSync = spawnSync,
): Promise<void> {
  const invocation = await resolvePackageManagerInstallInvocation(projectRoot)
  const result = spawn(invocation.command, [...invocation.args], {
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
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Project dependency installation failed.')
  }
}

type ProjectPrepareOptions = {
  readonly syncFramework?: boolean
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
  const project = await ensureProjectConfig(projectRoot)
  await ensureGeneratedSchemaPlaceholder(projectRoot, project.config)
  await prepareProjectDiscovery(projectRoot, project.config)
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
    await prepareProjectDiscovery(projectRoot, project.config)
    await refreshFrameworkRunner(projectRoot)
    if (syncFramework) {
      for (const definition of syncDefinitions) {
        await runFrameworkSync(projectRoot, definition)
      }
    }
  }
}

async function runProjectHotPrepare(projectRoot: string, io?: IoStreams): Promise<void> {
  await runProjectPrepare(projectRoot, io, { syncFramework: false })
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
): boolean {
  const normalized = toPosixSlashes(filePath)
  if (PACKAGE_MANIFEST_DISCOVERY_PATHS.has(normalized)) {
    return true
  }

  const generatedSchemaPath = toPosixSlashes(project.config.paths.generatedSchema ?? '.holo-js/generated/schema.generated.ts')
  if (normalized === generatedSchemaPath) {
    return true
  }

  if (normalized === '.holo-js/generated' || normalized.startsWith('.holo-js/generated/')) {
    return false
  }

  if (normalized === '.env' || normalized.startsWith('.env.')) {
    return true
  }

  return resolveConfiguredDiscoveryRoots(project).some(root => normalized === root || normalized.startsWith(`${toPosixSlashes(root)}/`))
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

export async function collectDirectoryTree(rootPath: string, directories: Set<string>): Promise<void> {
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

    await collectDirectoryTree(join(rootPath, entry.name), directories)
  }
}

export async function collectDiscoveryWatchRoots(
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<string[]> {
  const directories = new Set<string>()
  const roots = [
    projectRoot,
    ...resolveConfiguredDiscoveryRoots(project).map(root => resolve(projectRoot, root)),
    resolve(projectRoot, dirname(project.config.paths.generatedSchema ?? '.holo-js/generated/schema.generated.ts')),
  ]

  for (const rootPath of roots) {
    await collectDirectoryTree(rootPath, directories)
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

export async function runProjectDevServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  createWatcher: WatchFactory = watch,
  prepare: (projectRoot: string, io?: IoStreams) => Promise<void> = runProjectPrepare,
): Promise<void> {
  let project = await ensureProjectConfig(projectRoot)
  let refreshNonRecursiveWatchers: (() => Promise<void>) | undefined
  let requestChildRestart: (() => void) | undefined
  const hotPrepare = prepare === runProjectPrepare ? runProjectHotPrepare : prepare

  const prepareDiscovery = async (syncFramework = false): Promise<void> => {
    await (syncFramework ? prepare : hotPrepare)(projectRoot, io)
    project = await ensureProjectConfig(projectRoot)
    await refreshNonRecursiveWatchers?.()
  }

  await prepareDiscovery(true)

  let pendingPrepare: Promise<void> | undefined
  let queued = false
  let shuttingDown = false
  const rerunPrepare = () => {
    /* v8 ignore next 3 */
    if (shuttingDown) {
      return
    }

    if (pendingPrepare) {
      queued = true
      return
    }

    pendingPrepare = prepareDiscovery()
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

  const closeWatchers = (() => {
    try {
      const watcher = createWatcher(projectRoot, { recursive: true }, (_eventType, fileName) => {
        if (shuttingDown || typeof fileName !== 'string' || !isDiscoveryRelevantPath(fileName, project)) {
          return
        }

        rerunPrepare()
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
        const watchRoots = await collectDiscoveryWatchRoots(projectRoot, project)
        for (const watchRoot of watchRoots) {
          try {
            watchers.push(createWatcher(watchRoot, { recursive: false }, (_eventType, fileName) => {
              if (shuttingDown || typeof fileName !== 'string') {
                return
              }

              const normalizedPath = normalizeWatchedFilePath(projectRoot, watchRoot, fileName)
              if (!isDiscoveryRelevantPath(normalizedPath, project)) {
                return
              }

              rerunPrepare()
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
