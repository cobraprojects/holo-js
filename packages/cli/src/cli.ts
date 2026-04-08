import { createInterface } from 'node:readline/promises'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  writeConfigCache,
  clearConfigCache,
  loadConfigDirectory,
  resolveConfigCachePath,
} from '@holo-js/config'
import {
  configureDB,
  generateMigrationTemplate,
  inferMigrationTableName,
  inferMigrationTemplateKind,
  normalizeMigrationSlug,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
} from '@holo-js/db'
import {
  CLI_RUNTIME_ROOT,
  HOLO_RUNTIME_ROOT,
  ensureGeneratedSchemaPlaceholder,
  bundleProjectModule,
  discoverAppCommands,
  ensureProjectConfig,
  findProjectRoot,
  loadProjectConfig,
  loadGeneratedProjectRegistry,
  makeProjectRelativePath,
  installQueueIntoProject,
  installEventsIntoProject,
  prepareProjectDiscovery,
  readTextFile,
  resolveProjectPackageImportSpecifier,
  resolveGeneratedSchemaPath,
  resolveDefaultArtifactPath,
  scaffoldProject,
  syncManagedDriverDependencies,
  writeTextFile,
} from './project'
import {
  relativeImportPath,
  renderEventTemplate,
  renderFactoryTemplate,
  renderJobTemplate,
  renderListenerTemplate,
  renderMultiListenerTemplate,
  renderModelTemplate,
  renderObserverTemplate,
  renderSeederTemplate,
  resolveArtifactPath,
  resolveNameInfo,
  splitRequestedName,
  toKebabCase,
  toPascalCase,
  toSnakeCase,
} from './templates'
import type { LoadedProjectConfig, CommandFlagValue, CommandExecutionContext } from './types'
import type {
  DiscoveredAppCommand,
  ProjectScaffoldOptions,
  SupportedScaffoldFramework,
  SupportedScaffoldOptionalPackage,
  SupportedScaffoldPackageManager,
  SupportedQueueInstallerDriver,
  SupportedScaffoldStorageDisk,
} from './project'
import type { HoloRuntime } from '@holo-js/core'
import type { QueueWorkerRunOptions } from '@holo-js/queue'

type IoStreams = {
  readonly cwd: string
  readonly stdin: NodeJS.ReadStream
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

type RawParsedInput = {
  readonly args: readonly string[]
  readonly flags: Record<string, string | boolean | readonly string[]>
}

type PreparedInput = {
  readonly args: readonly string[]
  readonly flags: Record<string, CommandFlagValue>
}

type CommandDefinition = {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage: string
  readonly source: 'internal' | 'app'
  prepare?(input: RawParsedInput, context: InternalCommandContext): Promise<PreparedInput>
  run(context: CommandExecutionContext): Promise<void>
}

type InternalCommandContext = IoStreams & {
  readonly projectRoot: string
  readonly registry: readonly CommandDefinition[]
  loadProject(): Promise<LoadedProjectConfig>
}

type RuntimeEnvironment = {
  readonly project: LoadedProjectConfig
  readonly bundledModels: readonly string[]
  readonly bundledMigrations: readonly string[]
  readonly bundledSeeders: readonly string[]
  readonly bundledGeneratedSchema?: string
  cleanup(): Promise<void>
}

type QueueRuntimeEnvironment = {
  readonly runtime: HoloRuntime
  readonly project: LoadedProjectConfig
  readonly bundledJobs: readonly string[]
  cleanup(): Promise<void>
}

type QueueMaintenanceEnvironment = {
  cleanup(): Promise<void>
}

type ProjectRuntimeInitializationOptions = {
  readonly registerProjectQueueJobs?: boolean
}

type RuntimeSpawnResult = {
  readonly status: number | null
  readonly error?: Error | ({ code?: string } & Record<string, unknown>) | null
  readonly stdout?: string
  readonly stderr?: string
}

type NewProjectInput = {
  readonly projectName: string
  readonly framework: SupportedScaffoldFramework
  readonly databaseDriver: ProjectScaffoldOptions['databaseDriver']
  readonly packageManager: SupportedScaffoldPackageManager
  readonly storageDefaultDisk: SupportedScaffoldStorageDisk
  readonly optionalPackages: readonly SupportedScaffoldOptionalPackage[]
}

type QueueCliModule = {
  clearQueueConnection(
    connectionName?: string,
    options?: { queueNames?: readonly string[] },
  ): Promise<number>
  configureQueueRuntime(options: { config: Awaited<ReturnType<typeof loadConfigDirectory>>['queue'] } & Record<string, unknown>): void
  flushFailedQueueJobs(): Promise<number>
  forgetFailedQueueJob(identifier: string): Promise<boolean>
  getRegisteredQueueJob(name: string): { sourcePath?: string } | undefined
  isQueueJobDefinition(value: unknown): boolean
  listFailedQueueJobs(): Promise<readonly {
    id: string
    failedAt: number
    job: {
      name: string
      connection: string
      queue: string
    }
  }[]>
  normalizeQueueJobDefinition(value: unknown): {
    connection?: string
    queue?: string
    tries?: number
    backoff?: number | readonly number[]
    timeout?: number
  }
  registerQueueJob(
    definition: unknown,
    options: { name: string, sourcePath?: string },
  ): void
  retryFailedQueueJobs(identifier: string): Promise<number>
  runQueueWorker(options: QueueWorkerRunOptions): Promise<{
    stoppedBecause: string
    processed: number
    released: number
    failed: number
  }>
  shutdownQueueRuntime(): Promise<void>
}

const SUPPORTED_NEW_FRAMEWORKS = ['nuxt', 'next', 'sveltekit'] as const
const SUPPORTED_NEW_DATABASE_DRIVERS = ['sqlite', 'mysql', 'postgres'] as const
const SUPPORTED_NEW_PACKAGE_MANAGERS = ['bun', 'npm', 'pnpm', 'yarn'] as const
const SUPPORTED_NEW_STORAGE_DISKS = ['local', 'public'] as const
const SUPPORTED_NEW_OPTIONAL_PACKAGES = ['storage', 'events', 'queue', 'validation', 'forms'] as const
const SUPPORTED_INSTALL_TARGETS = ['queue', 'events'] as const
const SUPPORTED_QUEUE_INSTALL_DRIVERS = ['sync', 'redis', 'database'] as const
const DEFAULT_DATABASE_QUEUE_TABLE = 'jobs'
const DEFAULT_FAILED_JOBS_TABLE = 'failed_jobs'
const QUEUE_LISTEN_SOURCE_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
])
const QUEUE_LISTEN_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'coverage',
  'dist',
  'node_modules',
])
const QUEUE_LISTEN_IGNORED_PATH_PREFIXES = [
  HOLO_RUNTIME_ROOT,
].map(toPosixSlashes)

const runtimeImportMeta = import.meta as ImportMeta & {
  resolve?: (specifier: string) => string
}

async function loadQueueCliModule(projectRoot: string): Promise<QueueCliModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')) as QueueCliModule
}

function resolveConfigModuleUrl(
  /* v8 ignore next */
  runtimeResolve: ((specifier: string) => string) | undefined = runtimeImportMeta.resolve?.bind(runtimeImportMeta),
): string {
  if (typeof runtimeResolve === 'function') {
    const resolved = runtimeResolve('@holo-js/config')

    if (resolved.startsWith('file://')) {
      const resolvedPath = fileURLToPath(resolved)
      const normalized = resolvedPath.replace(/\\/g, '/')
      if (normalized.endsWith('/src/index.ts') || normalized.endsWith('/src/index.mts') || normalized.endsWith('/src/index.js') || normalized.endsWith('/src/index.mjs')) {
        return pathToFileURL(resolve(dirname(dirname(resolvedPath)), 'dist/index.mjs')).href
      }
    }

    return resolved
  }

  return pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '../node_modules/@holo-js/config/dist/index.mjs')).href
}

type RuntimeMigrationCandidate = {
  readonly name?: unknown
  up(...args: unknown[]): unknown
}

function writeLine(stream: NodeJS.WriteStream, message = ''): void {
  stream.write(`${message}\n`)
}

async function initializeProjectRuntime(
  projectRoot: string,
  options: ProjectRuntimeInitializationOptions = {},
): Promise<HoloRuntime> {
  const { initializeHolo } = await import('@holo-js/core')
  return initializeHolo(projectRoot, options)
}

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value === 'undefined') {
    return undefined
  }

  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

async function cacheProjectConfig(
  projectRoot: string,
  cacheWriter: typeof writeConfigCache = writeConfigCache,
): Promise<string> {
  try {
    return await cacheWriter(projectRoot, { processEnv: process.env })
  } catch (error) {
    throw new Error(error instanceof Error && error.message ? error.message : 'Failed to cache config.')
  }
}

type PackageManagerCommand = {
  readonly command: string
  readonly args: readonly string[]
}

type SpawnProcessLike = {
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
  stdin?: NodeJS.WritableStream | null
  kill?(signal?: NodeJS.Signals | number): boolean
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

type WatchFactory = typeof watch
type WatchHandle = ReturnType<WatchFactory>

async function resolveProjectPackageManager(projectRoot: string): Promise<SupportedScaffoldPackageManager> {
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

async function resolvePackageManagerCommand(projectRoot: string, scriptName: string): Promise<PackageManagerCommand> {
  const packageManager = await resolveProjectPackageManager(projectRoot)
  return {
    command: packageManager,
    args: ['run', scriptName],
  }
}

async function resolvePackageManagerInstallInvocation(projectRoot: string): Promise<PackageManagerCommand> {
  const packageManager = await resolveProjectPackageManager(projectRoot)
  return {
    command: packageManager,
    args: ['install'],
  }
}

async function runProjectLifecycleScript(
  io: IoStreams,
  projectRoot: string,
  scriptName: string,
  spawn: typeof spawnSync = spawnSync,
): Promise<void> {
  const invocation = await resolvePackageManagerCommand(projectRoot, scriptName)
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
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Project script "${scriptName}" failed.`)
  }
}

async function runProjectDependencyInstall(
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

async function runProjectPrepare(projectRoot: string, io?: IoStreams): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const updatedDependencies = await syncManagedDriverDependencies(projectRoot)
  if (updatedDependencies && io) {
    await runProjectDependencyInstall(io, projectRoot)
  }
  await prepareProjectDiscovery(projectRoot, project.config)
}

function toPosixSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

function isDiscoveryRelevantPath(
  filePath: string,
  project: LoadedProjectConfig,
): boolean {
  const normalized = toPosixSlashes(filePath)
  const roots = [
    project.config.paths.models,
    project.config.paths.migrations,
    project.config.paths.seeders,
    project.config.paths.commands,
    project.config.paths.jobs,
    project.config.paths.events,
    project.config.paths.listeners,
    project.config.paths.generatedSchema,
    'config',
    '.holo-js/generated',
  ]

  if (normalized === '.env' || normalized.startsWith('.env.')) {
    return true
  }

  return roots.some(root => normalized === root || normalized.startsWith(`${toPosixSlashes(root)}/`))
}

function isRecursiveWatchUnsupported(error: unknown): boolean {
  return error instanceof Error
    && (
      error.message.includes('recursive')
      || ('code' in error && (error as { code?: string }).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM')
    )
}

function isIgnorableWatchError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (
      (error as { code?: string }).code === 'ENOENT'
      || (error as { code?: string }).code === 'EPERM'
    )
}

async function collectDirectoryTree(rootPath: string, directories: Set<string>): Promise<void> {
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

function isIgnoredQueueListenPath(filePath: string): boolean {
  const normalized = toPosixSlashes(filePath)
  if (QUEUE_LISTEN_IGNORED_PATH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .some(segment => QUEUE_LISTEN_IGNORED_DIRECTORY_NAMES.has(segment))
}

async function collectQueueWatchTree(
  rootPath: string,
  directories: Set<string>,
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<boolean> {
  const relativePath = toPosixSlashes(relative(projectRoot, rootPath))
  if (relativePath && isIgnoredQueueListenPath(relativePath)) {
    return false
  }

  const rootStats = await stat(rootPath).catch(() => undefined)
  if (!rootStats?.isDirectory()) {
    return false
  }

  let shouldWatchDirectory = relativePath === ''
    || isQueueListenRelevantPath(relativePath, project)
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    if (!entry.isDirectory()) {
      if (entry.isFile()) {
        const normalizedPath = toPosixSlashes(relative(projectRoot, entryPath))
        if (isQueueListenRelevantPath(normalizedPath, project)) {
          shouldWatchDirectory = true
        }
      }
      continue
    }

    if (await collectQueueWatchTree(entryPath, directories, projectRoot, project)) {
      shouldWatchDirectory = true
    }
  }

  if (shouldWatchDirectory) {
    directories.add(rootPath)
  }

  return shouldWatchDirectory
}

async function collectDiscoveryWatchRoots(
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<string[]> {
  const directories = new Set<string>()
  const roots = [
    projectRoot,
    resolve(projectRoot, 'config'),
    resolve(projectRoot, '.holo-js/generated'),
    resolve(projectRoot, project.config.paths.models),
    resolve(projectRoot, project.config.paths.migrations),
    resolve(projectRoot, project.config.paths.seeders),
    resolve(projectRoot, project.config.paths.commands),
    resolve(projectRoot, project.config.paths.jobs),
    resolve(projectRoot, project.config.paths.events),
    resolve(projectRoot, project.config.paths.listeners),
    dirname(resolve(projectRoot, project.config.paths.generatedSchema)),
  ]

  for (const rootPath of roots) {
    await collectDirectoryTree(rootPath, directories)
  }

  return [...directories]
}

function normalizeWatchedFilePath(
  projectRoot: string,
  watchedRoot: string,
  fileName: string,
): string {
  return toPosixSlashes(relative(projectRoot, resolve(watchedRoot, fileName)))
}

function isQueueListenRelevantPath(
  filePath: string,
  project: LoadedProjectConfig,
): boolean {
  const normalized = toPosixSlashes(filePath)
  const roots = [
    project.config.paths.models,
    project.config.paths.jobs,
    project.config.paths.events,
    project.config.paths.listeners,
    'config',
    '.holo-js/generated',
  ]

  if (normalized === '.env' || normalized.startsWith('.env.')) {
    return true
  }

  if (isIgnoredQueueListenPath(normalized)) {
    return false
  }

  if (roots.some(root => normalized === root || normalized.startsWith(`${toPosixSlashes(root)}/`))) {
    return true
  }

  return QUEUE_LISTEN_SOURCE_EXTENSIONS.has(extname(normalized).toLowerCase())
}

async function collectQueueWatchRoots(
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<string[]> {
  const directories = new Set<string>()
  await collectQueueWatchTree(projectRoot, directories, projectRoot, project)

  return [...directories]
}

function resolveCliEntrypointPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const builtEntry = resolve(currentDir, 'bin', 'holo.mjs')
  if (existsSync(builtEntry)) {
    return builtEntry
  }

  return resolve(currentDir, 'bin', 'holo.ts')
}

async function resolveRunnableCliEntrypoint(): Promise<{ path: string, cleanup(): Promise<void> }> {
  const cliEntrypoint = resolveCliEntrypointPath()
  const extension = extname(cliEntrypoint).toLowerCase()

  if (extension !== '.ts' && extension !== '.mts' && extension !== '.cts') {
    return {
      path: cliEntrypoint,
      async cleanup() {},
    }
  }

  const currentDir = dirname(fileURLToPath(import.meta.url))
  const workspaceRoot = resolve(currentDir, '..', '..', '..')
  return bundleProjectModule(workspaceRoot, cliEntrypoint)
}

function isModuleRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function resolveModuleExport<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): TValue | undefined {
  if (isModuleRecord(moduleValue) && matcher(moduleValue.default)) {
    return moduleValue.default
  }

  if (isModuleRecord(moduleValue)) {
    for (const value of Object.values(moduleValue)) {
      if (matcher(value)) {
        return value
      }
    }
  }

  return undefined
}

function buildQueueWorkArgs(flags: Readonly<Record<string, CommandFlagValue>>): string[] {
  const args = ['queue:work']
  for (const [name, value] of Object.entries(flags)) {
    if (name === 'help' || name === 'h') {
      continue
    }

    if (value === false) {
      continue
    }

    const optionName = name.length === 1 ? `-${name}` : `--${name}`
    if (value === true) {
      args.push(optionName)
      continue
    }

    if (Array.isArray(value)) {
      for (const entry of value) {
        args.push(optionName, entry)
      }
      continue
    }

    args.push(optionName, String(value))
  }

  return args
}

function resolveQueueRestartSignalPath(projectRoot: string): string {
  return resolve(projectRoot, '.holo-js', 'runtime', 'queue-restart.signal')
}

async function readQueueRestartSignal(projectRoot: string): Promise<number | undefined> {
  const contents = await readFile(resolveQueueRestartSignalPath(projectRoot), 'utf8').catch(() => undefined)
  if (!contents) {
    return undefined
  }

  const parsed = Number.parseInt(contents.trim(), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function writeQueueRestartSignal(projectRoot: string, timestamp = Date.now()): Promise<string> {
  const signalPath = resolveQueueRestartSignalPath(projectRoot)
  await mkdir(dirname(signalPath), { recursive: true })
  await writeFile(signalPath, `${timestamp}\n`, 'utf8')
  return signalPath
}

async function hasQueueRestartSignalSince(projectRoot: string, since: number): Promise<boolean> {
  const signal = await readQueueRestartSignal(projectRoot)
  return typeof signal === 'number' && signal > since
}

async function runProjectDevServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  createWatcher: WatchFactory = watch,
  prepare: (projectRoot: string, io?: IoStreams) => Promise<void> = runProjectPrepare,
): Promise<void> {
  let project = await ensureProjectConfig(projectRoot)
  let refreshNonRecursiveWatchers: (() => Promise<void>) | undefined
  let requestChildRestart: (() => void) | undefined

  const prepareDiscovery = async (): Promise<void> => {
    await prepare(projectRoot, io)
    project = await ensureProjectConfig(projectRoot)
    await refreshNonRecursiveWatchers?.()
  }

  await prepareDiscovery()

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

  const invocation = await resolvePackageManagerCommand(projectRoot, 'holo:dev')
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

    throw new Error(`Project script "holo:dev" failed with exit code ${result.code ?? 'unknown'}.`)
  }
}

async function getQueueRuntimeEnvironment(projectRoot: string): Promise<QueueRuntimeEnvironment> {
  let project = await loadProjectConfig(projectRoot, { required: true })
  await prepareProjectDiscovery(projectRoot, project.config)
  project = await loadProjectConfig(projectRoot, { required: true })

  const runtime = await initializeProjectRuntime(projectRoot, {
    registerProjectQueueJobs: false,
  })
  const registry = await loadGeneratedProjectRegistry(projectRoot)
  const modelEntries = registry?.models ?? []
  const jobEntries = registry?.jobs ?? []
  const bundledModels: Array<Awaited<ReturnType<typeof bundleProjectModule>>> = []
  const bundledJobs: Array<Awaited<ReturnType<typeof bundleProjectModule>>> = []

  try {
    const queueModule = jobEntries.length > 0
      ? await loadQueueCliModule(projectRoot)
      : undefined

    for (const entry of modelEntries) {
      bundledModels.push(await bundleProjectModule(
        projectRoot,
        resolve(projectRoot, entry.sourcePath),
      ))
    }

    for (const entry of jobEntries) {
      if (queueModule?.getRegisteredQueueJob(entry.name)) {
        continue
      }

      bundledJobs.push(await bundleProjectModule(
        projectRoot,
        resolve(projectRoot, entry.sourcePath),
        { external: ['@holo-js/queue'] },
      ))
    }

    for (let index = 0; index < modelEntries.length; index += 1) {
      const bundledEntry = bundledModels[index]!
      await import(`${pathToFileURL(bundledEntry.path).href}?t=${Date.now()}-model-${index}`)
    }

    let bundledJobIndex = 0
    for (let index = 0; index < jobEntries.length; index += 1) {
      const entry = jobEntries[index]!
      if (queueModule?.getRegisteredQueueJob(entry.name)) {
        continue
      }

      const bundledEntry = bundledJobs[bundledJobIndex]!
      bundledJobIndex += 1

      const moduleValue = await import(`${pathToFileURL(bundledEntry.path).href}?t=${Date.now()}-${index}`)
      const job = resolveModuleExport(moduleValue, (value): value is unknown => queueModule!.isQueueJobDefinition(value))
      if (!job) {
        throw new Error(`Discovered job "${entry.sourcePath}" does not export a Holo job.`)
      }

      if (!queueModule?.getRegisteredQueueJob(entry.name)) {
        queueModule!.registerQueueJob(queueModule!.normalizeQueueJobDefinition(job), {
          name: entry.name,
          sourcePath: entry.sourcePath,
        })
      }
    }
  } catch (error) {
    await runtime.shutdown().catch(() => {})
    await Promise.all([...bundledModels, ...bundledJobs].map(entry => entry.cleanup()))
    throw error
  }

  return {
    runtime,
    project,
    bundledJobs: bundledJobs.map(entry => entry.path),
    async cleanup() {
      await Promise.all([...bundledModels, ...bundledJobs].map(entry => entry.cleanup()))
      await runtime.shutdown()
    },
  }
}

async function runQueueWorkCommand(
  io: IoStreams,
  projectRoot: string,
  options: QueueWorkerRunOptions,
  dependencies: {
    getEnvironment?: typeof getQueueRuntimeEnvironment
    hasRestartSignal?: typeof hasQueueRestartSignalSince
    runWorker?: QueueCliModule['runQueueWorker']
  } = {},
): Promise<void> {
  const startedAt = Date.now()
  const environment = await (dependencies.getEnvironment ?? getQueueRuntimeEnvironment)(projectRoot)

  try {
    const queueModule = dependencies.runWorker ? undefined : await loadQueueCliModule(projectRoot)
    const result = await (dependencies.runWorker ?? queueModule!.runQueueWorker)({
      ...options,
      shouldStop: async () => {
        if (await options.shouldStop?.()) {
          return true
        }

        return (dependencies.hasRestartSignal ?? hasQueueRestartSignalSince)(projectRoot, startedAt)
      },
      onJobFailed: async (event) => {
        await options.onJobFailed?.(event)
        writeLine(io.stderr, `[queue] Failed ${event.jobName} (${event.jobId}): ${event.error.message}`)
      },
    })

    writeLine(
      io.stdout,
      `[queue] Stopped (${result.stoppedBecause}). processed=${result.processed} released=${result.released} failed=${result.failed}`,
    )
  } finally {
    await environment.cleanup()
  }
}

async function initializeQueueMaintenanceEnvironment(
  projectRoot: string,
  connectionName?: string,
): Promise<QueueMaintenanceEnvironment> {
  const loadedConfig = await loadConfigDirectory(projectRoot)
  const queueModule = await loadQueueCliModule(projectRoot)
  const resolvedConnectionName = connectionName?.trim() || loadedConfig.queue.default
  const connection = loadedConfig.queue.connections[resolvedConnectionName]
  if (!connection || connection.driver !== 'database') {
    queueModule.configureQueueRuntime({
      config: loadedConfig.queue,
    })

    return {
      async cleanup() {
        await queueModule.shutdownQueueRuntime()
      },
    }
  }

  const { createQueueDbRuntimeOptions } = await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue-db'))
  queueModule.configureQueueRuntime({
    config: loadedConfig.queue,
    ...createQueueDbRuntimeOptions(),
  })

  const manager = resolveRuntimeConnectionManagerOptions({
    db: loadedConfig.database,
  })
  configureDB(manager)

  try {
    await manager.initializeAll()
  } catch (error) {
    await manager.disconnectAll().catch(() => {})
    resetDB()
    await queueModule.shutdownQueueRuntime()
    throw error
  }

  return {
    async cleanup() {
      try {
        await manager.disconnectAll()
      } finally {
        resetDB()
        await queueModule.shutdownQueueRuntime()
      }
    },
  }
}

async function runQueueClearCommand(
  io: IoStreams,
  projectRoot: string,
  connectionName: string | undefined,
  queueNames: readonly string[] | undefined,
  dependencies: {
    initialize?: (projectRoot: string) => Promise<HoloRuntime>
    initializeQueue?: (
      projectRoot: string,
      connectionName?: string,
    ) => Promise<QueueMaintenanceEnvironment>
    clear?: QueueCliModule['clearQueueConnection']
  } = {},
): Promise<void> {
  if (dependencies.initialize) {
    const runtime = await dependencies.initialize(projectRoot)
    const queueModule = dependencies.clear ? undefined : await loadQueueCliModule(projectRoot)

    try {
      const cleared = await (dependencies.clear ?? queueModule!.clearQueueConnection)(connectionName, {
        ...(queueNames && queueNames.length > 0 ? { queueNames } : {}),
      })
      writeLine(io.stdout, `[queue] Cleared ${cleared} pending job(s).`)
    } finally {
      await runtime.shutdown()
    }

    return
  }

  const environment = await (dependencies.initializeQueue ?? initializeQueueMaintenanceEnvironment)(
    projectRoot,
    connectionName,
  )

  try {
    const queueModule = dependencies.clear ? undefined : await loadQueueCliModule(projectRoot)
    const cleared = await (dependencies.clear ?? queueModule!.clearQueueConnection)(connectionName, {
      ...(queueNames && queueNames.length > 0 ? { queueNames } : {}),
    })
    writeLine(io.stdout, `[queue] Cleared ${cleared} pending job(s).`)
  } finally {
    await environment.cleanup()
  }
}

async function runQueueRestartCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const signalPath = await writeQueueRestartSignal(projectRoot)
  writeLine(io.stdout, `[queue] Restart signal written: ${signalPath}`)
}

async function runQueueListen(
  io: IoStreams,
  projectRoot: string,
  flags: Readonly<Record<string, CommandFlagValue>>,
  spawnProcess: typeof spawn = spawn,
  createWatcher: WatchFactory = watch,
  prepare: (projectRoot: string, io?: IoStreams) => Promise<void> = runProjectPrepare,
): Promise<void> {
  let project = await ensureProjectConfig(projectRoot)
  let refreshNonRecursiveWatchers: (() => Promise<void>) | undefined
  let requestChildRestart: (() => void) | undefined
  const childArgs = buildQueueWorkArgs(flags)
  const cliEntrypoint = await resolveRunnableCliEntrypoint()

  try {
    const prepareDiscovery = async (): Promise<void> => {
      await prepare(projectRoot, io)
      project = await ensureProjectConfig(projectRoot)
      await refreshNonRecursiveWatchers?.()
    }

    await prepareDiscovery()

    let pendingPrepare: Promise<void> | undefined
    let queued = false
    let shuttingDown = false
    const rerunPrepare = () => {
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
          if (shuttingDown || typeof fileName !== 'string' || !isQueueListenRelevantPath(fileName, project)) {
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
          const watchRoots = await collectQueueWatchRoots(projectRoot, project)
          for (const watchRoot of watchRoots) {
            try {
              watchers.push(createWatcher(watchRoot, { recursive: false }, (_eventType, fileName) => {
                if (shuttingDown || typeof fileName !== 'string') {
                  return
                }

                const normalizedPath = normalizeWatchedFilePath(projectRoot, watchRoot, fileName)
                if (!isQueueListenRelevantPath(normalizedPath, project)) {
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

    while (!shuttingDown) {
      const childStartedAt = Date.now()
      const child = spawnProcess(process.execPath, [cliEntrypoint.path, ...childArgs], {
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
          void (async () => {
            if (child.stdin) {
              io.stdin.unpipe(child.stdin)
            }
            requestChildRestart = undefined
            if (restartRequested) {
              resolvePromise({ kind: 'restart' })
              return
            }

            if (!shuttingDown && code === 0 && await hasQueueRestartSignalSince(projectRoot, childStartedAt)) {
              resolvePromise({ kind: 'restart' })
              return
            }

            resolvePromise({ kind: 'close', code })
          })()
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

      throw new Error(`Queue worker failed with exit code ${result.code ?? 'unknown'}.`)
    }
  } finally {
    await cliEntrypoint.cleanup()
  }
}

function createEnvRuntimeConfig() {
  return {
    db: {
      defaultConnection: 'default',
      connections: {
        default: {
          driver: process.env.DB_DRIVER,
          url: process.env.DB_URL,
          host: process.env.DB_HOST,
          port: process.env.DB_PORT,
          username: process.env.DB_USERNAME,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_DATABASE,
          schema: process.env.DB_SCHEMA,
          ssl: parseBooleanEnv(process.env.DB_SSL),
          logging: parseBooleanEnv(process.env.DB_LOGGING),
        },
      },
    },
  }
}

function normalizeRuntimeConnectionInput(
  connection: object | string | undefined,
): Record<string, unknown> {
  if (typeof connection === 'string') {
    return { url: connection }
  }

  return connection ? { ...(connection as Record<string, unknown>) } : {}
}

function hasDefinedRuntimeValue(value: unknown): boolean {
  return typeof value !== 'undefined'
}

function filterDefinedRuntimeConnectionInput(
  connection: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(connection).filter(([, value]) => hasDefinedRuntimeValue(value)),
  )
}

function mergeRuntimeDatabaseConfig(
  config: {
    defaultConnection?: string
    connections?: Record<string, object | string>
  } | undefined,
  envRuntimeConfig: ReturnType<typeof createEnvRuntimeConfig>,
) {
  const envDefault = envRuntimeConfig.db.connections.default
  const hasEnvOverrides = Object.values(envDefault).some(hasDefinedRuntimeValue)

  if (!config) {
    return envRuntimeConfig.db
  }

  if (!hasEnvOverrides) {
    return config
  }

  const defaultConnection = config.defaultConnection ?? 'default'
  const connections = { ...(config.connections ?? {}) }
  connections[defaultConnection] = {
    ...normalizeRuntimeConnectionInput(connections[defaultConnection]),
    ...filterDefinedRuntimeConnectionInput(envDefault),
  }

  return {
    ...config,
    defaultConnection,
    connections,
  }
}

function parseTokens(tokens: readonly string[]): RawParsedInput {
  const args: string[] = []
  const flags: Record<string, string | boolean | readonly string[]> = {}
  const isNumericValueToken = (value: string | undefined) => typeof value === 'string' && /^-\d+$/.test(value)

  const assignFlag = (name: string, value: string | boolean) => {
    const existing = flags[name]
    if (typeof existing === 'undefined') {
      flags[name] = value
      return
    }

    if (Array.isArray(existing)) {
      flags[name] = [...existing, String(value)]
      return
    }

    flags[name] = [String(existing), String(value)]
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    /* v8 ignore next 3 */
    if (typeof token === 'undefined') {
      continue
    }
    if (token === '--') {
      args.push(...tokens.slice(index + 1))
      break
    }

    if (token.startsWith('--')) {
      const flag = token.slice(2)
      const separator = flag.indexOf('=')
      if (separator >= 0) {
        assignFlag(flag.slice(0, separator), flag.slice(separator + 1))
        continue
      }

      const next = tokens[index + 1]
      if (next && (!next.startsWith('-') || isNumericValueToken(next))) {
        assignFlag(flag, next)
        index += 1
        continue
      }

      assignFlag(flag, true)
      continue
    }

    if (token.startsWith('-') && token.length > 1) {
      const short = token.slice(1)
      if (short.length > 1) {
        for (const char of short) {
          assignFlag(char, true)
        }
        continue
      }

      const next = tokens[index + 1]
      if (next && (!next.startsWith('-') || isNumericValueToken(next))) {
        assignFlag(short, next)
        index += 1
        continue
      }

      assignFlag(short, true)
      continue
    }

    args.push(token)
  }

  return { args, flags }
}

function isInteractive(io: IoStreams, flags: Record<string, string | boolean | readonly string[]>): boolean {
  const disabled = flags['no-interactive'] === true
  return io.stdin.isTTY === true && io.stdout.isTTY === true && !disabled
}

/* v8 ignore start */
async function prompt(io: IoStreams, label: string): Promise<string> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stdout,
  })

  try {
    return (await rl.question(label)).trim()
  } finally {
    rl.close()
  }
}

async function confirm(io: IoStreams, label: string, defaultValue = false): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n] ' : ' [y/N] '
  const answer = (await prompt(io, `${label}${suffix}`)).toLowerCase()
  if (!answer) {
    return defaultValue
  }

  return answer === 'y' || answer === 'yes'
}
/* v8 ignore stop */

/* v8 ignore start */
function normalizeChoice<TValue extends string>(
  value: string | undefined,
  allowed: readonly TValue[],
  label: string,
): TValue {
  const normalized = value?.trim().toLowerCase()
  if (normalized && allowed.includes(normalized as TValue)) {
    return normalized as TValue
  }

  throw new Error(`Unsupported ${label}: ${value ?? '(empty)'}. Expected one of ${allowed.join(', ')}.`)
}
/* v8 ignore stop */

/* v8 ignore start */
async function promptChoice<TValue extends string>(
  io: IoStreams,
  label: string,
  allowed: readonly TValue[],
  defaultValue: TValue,
): Promise<TValue> {
  const answer = (await prompt(io, `${label} (${allowed.join('/')}) [${defaultValue}]: `)).trim().toLowerCase()
  if (!answer) {
    return defaultValue
  }

  return normalizeChoice(answer, allowed, label)
}
/* v8 ignore stop */

function normalizeOptionalPackageName(value: string): string {
  const current = value.trim().toLowerCase()
  if (current === 'validate') {
    return 'validation'
  }

  if (current === 'form') {
    return 'forms'
  }

  return current
}

function normalizeOptionalPackages(value: readonly string[] | undefined): readonly SupportedScaffoldOptionalPackage[] {
  if (!value || value.length === 0) {
    return []
  }

  const normalized = new Set<SupportedScaffoldOptionalPackage>()
  for (const raw of value) {
    const current = normalizeOptionalPackageName(raw)
    if (current === 'none') {
      continue
    }

    if (SUPPORTED_NEW_OPTIONAL_PACKAGES.includes(current as SupportedScaffoldOptionalPackage)) {
      normalized.add(current as SupportedScaffoldOptionalPackage)
      if (current === 'forms') {
        normalized.add('validation')
      }
      continue
    }

    throw new Error(
      `Unsupported optional package: ${raw}. Expected one of ${[...SUPPORTED_NEW_OPTIONAL_PACKAGES, 'none'].join(', ')}.`,
    )
  }

  return [...normalized].sort((left, right) => left.localeCompare(right))
}

/* v8 ignore start */
async function promptOptionalPackages(io: IoStreams): Promise<readonly SupportedScaffoldOptionalPackage[]> {
  const answer = await prompt(io, `Optional packages (${[...SUPPORTED_NEW_OPTIONAL_PACKAGES, 'none'].join('/')}): `)
  return normalizeOptionalPackages(splitCsv(answer) ?? (answer ? [answer] : []))
}
/* v8 ignore stop */

async function resolveNewProjectInput(
  io: IoStreams,
  input: RawParsedInput,
  prompts: {
    prompt(label: string): Promise<string>
    choose<TValue extends string>(label: string, allowed: readonly TValue[], defaultValue: TValue): Promise<TValue>
    optionalPackages(): Promise<readonly SupportedScaffoldOptionalPackage[]>
  } = {
    prompt: label => prompt(io, label),
    choose: (label, allowed, defaultValue) => promptChoice(io, label, allowed, defaultValue),
    optionalPackages: () => promptOptionalPackages(io),
  },
): Promise<NewProjectInput> {
  const flagProjectName = resolveStringFlag(input.flags, 'name')
  const positionalProjectName = input.args[0]?.trim()

  if (flagProjectName && positionalProjectName && flagProjectName !== positionalProjectName) {
    throw new Error('Conflicting project names. Use either the positional argument or --name, not both.')
  }

  const interactive = isInteractive(io, input.flags)
  const projectName = (flagProjectName ?? positionalProjectName)?.trim()
    || (interactive ? await prompts.prompt('Project name: ') : '')
  if (!projectName) {
    throw new Error(interactive ? 'Project creation cancelled.' : 'Missing required argument: Project name.')
  }

  const framework = resolveStringFlag(input.flags, 'framework')
    ? normalizeChoice(resolveStringFlag(input.flags, 'framework'), SUPPORTED_NEW_FRAMEWORKS, 'framework')
    : interactive
      ? await prompts.choose('Framework', SUPPORTED_NEW_FRAMEWORKS, 'nuxt')
      : 'nuxt'

  const databaseDriver = resolveStringFlag(input.flags, 'database')
    ? normalizeChoice(resolveStringFlag(input.flags, 'database'), SUPPORTED_NEW_DATABASE_DRIVERS, 'database driver')
    : interactive
      ? await prompts.choose('Database driver', SUPPORTED_NEW_DATABASE_DRIVERS, 'sqlite')
      : 'sqlite'

  const packageManager = resolveStringFlag(input.flags, 'package-manager')
    ? normalizeChoice(resolveStringFlag(input.flags, 'package-manager'), SUPPORTED_NEW_PACKAGE_MANAGERS, 'package manager')
    : interactive
      ? await prompts.choose('Package manager', SUPPORTED_NEW_PACKAGE_MANAGERS, 'bun')
      : 'bun'

  const requestedOptionalPackages = collectMultiStringFlag(input.flags, 'package')
  let optionalPackages: readonly SupportedScaffoldOptionalPackage[]
  if (requestedOptionalPackages) {
    const normalizedOptionalPackages: string[] = []
    for (const entry of requestedOptionalPackages) {
      normalizedOptionalPackages.push(...splitCsv(entry))
    }
    optionalPackages = normalizeOptionalPackages(normalizedOptionalPackages)
  } else if (interactive) {
    optionalPackages = await prompts.optionalPackages()
  } else {
    optionalPackages = []
  }

  const storageDefaultDisk = optionalPackages.includes('storage')
    ? (resolveStringFlag(input.flags, 'storage-default-disk')
        ? normalizeChoice(resolveStringFlag(input.flags, 'storage-default-disk'), SUPPORTED_NEW_STORAGE_DISKS, 'storage default disk')
        : interactive
          ? await prompts.choose('Default storage disk', SUPPORTED_NEW_STORAGE_DISKS, 'local')
          : 'local')
    : 'local'

  return {
    projectName,
    framework,
    databaseDriver,
    packageManager,
    storageDefaultDisk,
    optionalPackages,
  }
}

async function ensureRequiredArg(
  io: IoStreams,
  input: RawParsedInput,
  index: number,
  label: string,
): Promise<string> {
  const value = input.args[index]?.trim()
  if (value) {
    return value
  }

  /* v8 ignore next 12 */
  if (!isInteractive(io, input.flags)) {
    throw new Error(`Missing required argument: ${label}.`)
  }

  const prompted = await prompt(io, `${label}: `)
  if (!prompted) {
    throw new Error(`Missing required argument: ${label}.`)
  }

  return prompted
}

function resolveStringFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): string | undefined {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value[value.length - 1]
  }

  if (typeof value === 'string') {
    return value
  }

  return undefined
}

function collectMultiStringFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): string[] | undefined {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value
      .map(entry => entry.trim())
      .filter(Boolean)
  }

  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized ? [normalized] : undefined
  }

  return undefined
}

function resolveBooleanFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): boolean {
  const value = flags[name] ?? (alias ? flags[alias] : undefined)
  if (Array.isArray(value)) {
    return value[value.length - 1] === 'true'
  }

  if (typeof value === 'string') {
    return value === 'true'
  }

  return value === true
}

function parseNumberFlag(
  flags: Readonly<Record<string, CommandFlagValue>>,
  name: string,
  alias?: string,
): number | undefined {
  const raw = resolveStringFlag(flags, name, alias)
  if (typeof raw === 'undefined') {
    return undefined
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`Flag "--${name}" must be a non-negative integer.`)
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Flag "--${name}" must be a non-negative integer.`)
  }

  return parsed
}

function splitCsv(value: string): string[]
function splitCsv(value: string | undefined): string[] | undefined
function splitCsv(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }

  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
}

const MIGRATION_NAME_PREFIX_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_/

function stripMigrationNamePrefix(name: string): string {
  return name.replace(MIGRATION_NAME_PREFIX_PATTERN, '')
}

function getRegistryMigrationSlug(name: string): string {
  return normalizeMigrationSlug(stripMigrationNamePrefix(name))
}

function hasRegisteredModelName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  modelName: string,
): boolean {
  return Boolean(registry?.models.some(entry => entry.name === modelName))
}

function hasRegisteredMigrationSlug(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  migrationSlug: string,
): boolean {
  return Boolean(registry?.migrations.some((entry) => {
    try {
      return getRegistryMigrationSlug(entry.name) === migrationSlug
    } catch {
      return false
    }
  }))
}

function hasRegisteredJobName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  jobName: string,
): boolean {
  return Boolean(registry?.jobs.some(entry => entry.name === jobName))
}

function hasRegisteredEventName(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  eventName: string,
): boolean {
  return Boolean(registry?.events.some(entry => entry.name === eventName))
}

function hasRegisteredListenerId(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  listenerId: string,
): boolean {
  return Boolean(registry?.listeners.some(entry => entry.id === listenerId))
}

function hasRegisteredCreateTableMigration(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  tableName: string,
): boolean {
  const expectedSlug = `create_${tableName}_table`
  return Boolean(registry?.migrations.some((entry) => {
    try {
      const slug = getRegistryMigrationSlug(entry.name)
      if (slug === expectedSlug) {
        return true
      }

      if (inferMigrationTemplateKind(slug) !== 'create_table') {
        return false
      }

      return inferMigrationTableName(slug, 'create_table') === tableName
    } catch {
      return false
    }
  }))
}

async function ensureAbsent(path: string): Promise<void> {
  const existing = await readTextFile(path)
  if (typeof existing !== 'undefined') {
    throw new TypeError(`Refusing to overwrite existing file: ${path}`)
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function hasProjectDependency(projectRoot: string, packageName: string): Promise<boolean> {
  const packageJson = await readTextFile(join(projectRoot, 'package.json'))
  if (!packageJson) {
    return false
  }

  try {
    const parsed = JSON.parse(packageJson) as {
      dependencies?: Record<string, unknown>
      devDependencies?: Record<string, unknown>
    }
    return typeof parsed.dependencies?.[packageName] === 'string'
      || typeof parsed.devDependencies?.[packageName] === 'string'
  } catch {
    return false
  }
}

async function nextMigrationTemplate(
  name: string,
  migrationsDir: string,
  options: Parameters<typeof generateMigrationTemplate>[1] = {},
): Promise<ReturnType<typeof generateMigrationTemplate>> {
  let offsetSeconds = 0

  while (true) {
    const candidate = generateMigrationTemplate(name, {
      date: new Date(Date.now() + offsetSeconds * 1000),
      ...options,
    })
    if (!(await fileExists(join(migrationsDir, candidate.fileName)))) {
      return candidate
    }

    offsetSeconds += 1
  }
}

async function loadQueueConfig(projectRoot: string) {
  return (await loadConfigDirectory(projectRoot)).queue
}

function normalizeQueueMigrationName(tableName: string): string {
  return normalizeMigrationSlug(`create_${tableName.replaceAll('.', '_')}_table`)
}

function renderQueueTableMigration(tableName: string): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'job\')',
    '      table.string(\'connection\')',
    '      table.string(\'queue\')',
    '      table.text(\'payload\')',
    '      table.integer(\'attempts\').default(0)',
    '      table.integer(\'max_attempts\').default(1)',
    '      table.bigInteger(\'available_at\')',
    '      table.bigInteger(\'reserved_at\').nullable()',
    '      table.string(\'reservation_id\').nullable()',
    '      table.bigInteger(\'created_at\')',
    `      table.index(['queue', 'available_at'], '${tableName.replaceAll('.', '_')}_queue_available_at_index')`,
    `      table.index(['queue', 'reserved_at'], '${tableName.replaceAll('.', '_')}_queue_reserved_at_index')`,
    `      table.index(['reservation_id'], '${tableName.replaceAll('.', '_')}_reservation_id_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${tableName}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

function renderFailedJobsTableMigration(tableName: string): string {
  return [
    'import { defineMigration, type MigrationContext } from \'@holo-js/db\'',
    '',
    'export default defineMigration({',
    '  async up({ schema }: MigrationContext) {',
    `    await schema.createTable('${tableName}', (table) => {`,
    '      table.string(\'id\').primaryKey()',
    '      table.string(\'job_id\')',
    '      table.string(\'job\')',
    '      table.string(\'connection\')',
    '      table.string(\'queue\')',
    '      table.text(\'payload\')',
    '      table.text(\'exception\')',
    '      table.bigInteger(\'failed_at\')',
    `      table.index(['job_id'], '${tableName.replaceAll('.', '_')}_job_id_index')`,
    `      table.index(['failed_at'], '${tableName.replaceAll('.', '_')}_failed_at_index')`,
    '    })',
    '  },',
    '  async down({ schema }: MigrationContext) {',
    `    await schema.dropTable('${tableName}')`,
    '  },',
    '})',
    '',
  ].join('\n')
}

function resolveDatabaseQueueTables(queueConfig: Awaited<ReturnType<typeof loadQueueConfig>>): readonly string[] {
  const configured = Object.values(queueConfig.connections)
    .filter(connection => connection.driver === 'database')
    .map(connection => connection.table)

  return Object.freeze(configured.length > 0 ? [...new Set(configured)] : [DEFAULT_DATABASE_QUEUE_TABLE])
}

/* v8 ignore start */
async function getRuntimeEnvironment(projectRoot: string): Promise<RuntimeEnvironment> {
  let project = await loadProjectConfig(projectRoot, { required: true })
  if (!await loadGeneratedProjectRegistry(projectRoot)) {
    await prepareProjectDiscovery(projectRoot, project.config)
    project = await loadProjectConfig(projectRoot, { required: true })
  }
  const generatedSchemaPath = resolveGeneratedSchemaPath(projectRoot, project.config)
  const hasGeneratedSchema = await fileExists(generatedSchemaPath)
  const bundleInputs = [
    ...project.config.models.map(entry => resolve(projectRoot, entry)),
    ...project.config.migrations.map(entry => resolve(projectRoot, entry)),
    ...project.config.seeders.map(entry => resolve(projectRoot, entry)),
    ...(hasGeneratedSchema ? [generatedSchemaPath] : []),
  ]
  const bundled: Array<Awaited<ReturnType<typeof bundleProjectModule>>> = []

  try {
    for (const entryPath of bundleInputs) {
      bundled.push(await bundleProjectModule(projectRoot, entryPath, { external: ['@holo-js/db'] }))
    }
  } catch (error) {
    await Promise.all(bundled.map(entry => entry.cleanup()))
    throw error
  }

  const bundledModels = bundled.slice(0, project.config.models.length).map(entry => entry.path)
  const bundledMigrations = bundled
    .slice(project.config.models.length, project.config.models.length + project.config.migrations.length)
    .map(entry => entry.path)
  const bundledSeeders = bundled
    .slice(project.config.models.length + project.config.migrations.length)
    .slice(0, project.config.seeders.length)
    .map(entry => entry.path)
  const bundledGeneratedSchema = hasGeneratedSchema
    ? bundled[project.config.models.length + project.config.migrations.length + project.config.seeders.length]?.path
    : undefined

  return {
    project,
    bundledModels,
    bundledMigrations,
    bundledSeeders,
    ...(bundledGeneratedSchema ? { bundledGeneratedSchema } : {}),
    async cleanup() {
      await Promise.all(bundled.map(entry => entry.cleanup()))
    },
  }
}
/* v8 ignore stop */

const RUNTIME_MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/

function inferRuntimeMigrationName(entry: string): string {
  const fileName = entry.split('/').pop()?.replace(/\.[^.]+$/, '')
  if (!fileName || !RUNTIME_MIGRATION_NAME_PATTERN.test(fileName)) {
    throw new Error(`Registered migration "${entry}" must use a timestamped file name matching YYYY_MM_DD_HHMMSS_description.`)
  }

  return fileName
}

function normalizeRuntimeMigration(
  entry: string,
  migration: RuntimeMigrationCandidate & Record<string, unknown>,
): Record<string, unknown> & { name: string, up(...args: unknown[]): unknown } {
  return {
    ...migration,
    name: typeof migration.name === 'string' ? migration.name : inferRuntimeMigrationName(entry),
  }
}

type FreshDropConnection = {
  getDialect(): {
    name: string
    quoteIdentifier(identifier: string): string
  }
  getSchemaName(): string | undefined
  executeCompiled(statement: { sql: string, source: string }): Promise<unknown>
}

type FreshDropSchema = {
  getTables(): Promise<string[]>
  dropTable(tableName: string): Promise<void>
  withoutForeignKeyConstraints<TResult>(callback: () => TResult | Promise<TResult>): Promise<TResult>
}

function compileFreshDropIdentifierPath(
  quoteIdentifier: (identifier: string) => string,
  identifier: string,
): string {
  if (!identifier.includes('.')) {
    return quoteIdentifier(identifier)
  }

  return identifier
    .split('.')
    .map(part => quoteIdentifier(part))
    .join('.')
}

async function dropAllTablesForFresh(
  connection: FreshDropConnection,
  schema: FreshDropSchema,
): Promise<void> {
  const tables = await schema.getTables()
  if (connection.getDialect().name === 'postgres') {
    const schemaName = connection.getSchemaName()
    const quoteIdentifier = connection.getDialect().quoteIdentifier

    for (const tableName of tables) {
      const qualifiedTableName = schemaName ? `${schemaName}.${tableName}` : tableName
      await connection.executeCompiled({
        sql: `DROP TABLE IF EXISTS ${compileFreshDropIdentifierPath(quoteIdentifier, qualifiedTableName)} CASCADE`,
        source: `schema:dropTableFresh:${qualifiedTableName}`,
      })
    }
    return
  }

  await schema.withoutForeignKeyConstraints(async () => {
    for (const tableName of tables) {
      await schema.dropTable(tableName)
    }
  })
}

/* v8 ignore start */
const nodeRuntimeScript = `
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  configureDB,
  createSchemaService,
  createMigrationService,
  createSeederService,
  renderGeneratedSchemaModule,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
} from '@holo-js/db'

const payload = JSON.parse(process.env.HOLO_RUNTIME_PAYLOAD ?? '{}')
process.chdir(payload.projectRoot)

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function loadModule(path) {
  return import(\`\${path}?t=\${Date.now()}\`)
}

function resolveExport(moduleValue, matcher) {
  if (isRecord(moduleValue) && matcher(moduleValue.default)) {
    return moduleValue.default
  }

  if (isRecord(moduleValue)) {
    for (const value of Object.values(moduleValue)) {
      if (matcher(value)) {
        return value
      }
    }
  }

  return undefined
}

const isModel = (value) => isRecord(value) && isRecord(value.definition) && value.definition.kind === 'model' && typeof value.prune === 'function'
const isMigration = (value) => isRecord(value) && typeof value.up === 'function'
const isSeeder = (value) => isRecord(value) && typeof value.name === 'string' && typeof value.run === 'function'
const isTable = (value) => isRecord(value) && value.kind === 'table' && typeof value.tableName === 'string' && isRecord(value.columns)
const RUNTIME_MIGRATION_NAME_PATTERN = ${RUNTIME_MIGRATION_NAME_PATTERN}
const inferRuntimeMigrationName = ${inferRuntimeMigrationName.toString()}
const normalizeRuntimeMigration = ${normalizeRuntimeMigration.toString()}
const compileFreshDropIdentifierPath = ${compileFreshDropIdentifierPath.toString()}
const dropAllTablesForFresh = ${dropAllTablesForFresh.toString()}

function extractTables(moduleValue) {
  if (isRecord(moduleValue) && isRecord(moduleValue.tables)) {
    return Object.values(moduleValue.tables).filter(isTable)
  }

  if (isRecord(moduleValue) && isTable(moduleValue.default)) {
    return [moduleValue.default]
  }

  if (isRecord(moduleValue)) {
    return Object.values(moduleValue).filter(isTable)
  }

  return []
}

async function preloadGeneratedSchema(manager, entry) {
  if (!entry) {
    return
  }

  const tables = extractTables(await loadModule(entry))
  for (const table of tables) {
    manager.connection().getSchemaRegistry().replace(table)
  }
}

async function writeGeneratedSchemaArtifact(manager, outputPath) {
  if (!outputPath) {
    return
  }

  const source = renderGeneratedSchemaModule(manager.connection().getSchemaRegistry().list())
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, source, 'utf8')
}

const manager = resolveRuntimeConnectionManagerOptions(payload.runtimeConfig)
configureDB(manager)

try {
  await manager.initializeAll()

  if (payload.kind === 'migrate') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const executed = await createMigrationService(manager.connection(), migrations).migrate(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    if (executed.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${executed.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'fresh') {
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const schema = createSchemaService(manager.connection())
    await dropAllTablesForFresh(manager.connection(), schema)
    manager.connection().getSchemaRegistry().clear()

    const executed = await createMigrationService(manager.connection(), migrations).migrate({})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    if (executed.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${executed.map(item => item.name).join(', ')}\`)
    }

    if (payload.options?.seed) {
      const seeders = []
      for (const entry of payload.seeders) {
        const seeder = resolveExport(await loadModule(entry), isSeeder)
        if (!seeder) {
          throw new Error(\`Registered seeder "\${entry}" does not export a Holo seeder.\`)
        }
        seeders.push(seeder)
      }

      const seeded = await createSeederService(manager.connection(), seeders).seed({
        ...(Array.isArray(payload.options.only) ? { only: payload.options.only } : {}),
        quietly: payload.options.quietly === true,
        force: payload.options.force === true,
        environment: payload.options.environment ?? 'development',
      })
      if (seeded.length === 0) {
        console.log('No seeders were executed.')
      } else {
        console.log(\`Seeders executed: \${seeded.map(item => item.name).join(', ')}\`)
      }
    }
  } else if (payload.kind === 'rollback') {
    await preloadGeneratedSchema(manager, payload.generatedSchema)
    const migrations = []
    for (const entry of payload.migrations) {
      const migration = resolveExport(await loadModule(entry), isMigration)
      if (!migration) {
        throw new Error(\`Registered migration "\${entry}" does not export a Holo migration.\`)
      }
      migrations.push(normalizeRuntimeMigration(entry, migration))
    }

    const rolledBack = await createMigrationService(manager.connection(), migrations).rollback(payload.options ?? {})
    await writeGeneratedSchemaArtifact(manager, payload.generatedSchemaOutputPath)
    if (rolledBack.length === 0) {
      console.log('No migrations were executed.')
    } else {
      console.log(\`Migrations executed: \${rolledBack.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'seed') {
    const seeders = []
    for (const entry of payload.seeders) {
      const seeder = resolveExport(await loadModule(entry), isSeeder)
      if (!seeder) {
        throw new Error(\`Registered seeder "\${entry}" does not export a Holo seeder.\`)
      }
      seeders.push(seeder)
    }

    const executed = await createSeederService(manager.connection(), seeders).seed(payload.options ?? {})
    if (executed.length === 0) {
      console.log('No seeders were executed.')
    } else {
      console.log(\`Seeders executed: \${executed.map(item => item.name).join(', ')}\`)
    }
  } else if (payload.kind === 'prune') {
    const models = []
    for (const entry of payload.models) {
      const model = resolveExport(await loadModule(entry), isModel)
      if (!model) {
        throw new Error(\`Registered model "\${entry}" does not export a Holo model.\`)
      }
      models.push(model)
    }

    const byName = new Map(models.map(model => [model.definition.name, model]))
    const requested = payload.options?.models ?? []
    const selected = []

    if (requested.length === 0) {
      selected.push(...models.filter(model => Boolean(model.definition.prunable)))
    } else {
      for (const name of requested) {
        const model = byName.get(name)
        if (!model) {
          throw new Error(\`Unknown model "\${name}".\`)
        }
        if (!model.definition.prunable) {
          throw new Error(\`Model "\${name}" does not define a prunable query.\`)
        }
        selected.push(model)
      }
    }

    if (selected.length === 0) {
      console.log('No prunable models were registered.')
    } else {
      let total = 0
      for (const model of selected) {
        const deleted = await model.prune()
        total += deleted
        console.log(\`\${model.definition.name}: deleted \${deleted}\`)
      }
      console.log(\`Total deleted: \${total}\`)
    }
  } else {
    throw new Error(\`Unknown runtime command "\${payload.kind}".\`)
  }
} finally {
  await manager.disconnectAll()
  resetDB()
}
`

async function resolvePackageRootFromSpecifier(specifier: string): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.resolve(specifier)))

  while (true) {
    if (await fileExists(join(current, 'package.json'))) {
      return current
    }

    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`Could not resolve package root for "${specifier}".`)
    }

    current = parent
  }
}

async function ensureRuntimeDependencyLink(projectRoot: string): Promise<string> {
  const runtimeRoot = join(projectRoot, CLI_RUNTIME_ROOT)
  const packageRoot = await resolvePackageRootFromSpecifier('@holo-js/db')
  const namespaceDir = join(runtimeRoot, 'node_modules', '@holo-js')
  const targetPath = join(namespaceDir, 'db')

  await mkdir(namespaceDir, { recursive: true })
  await rm(targetPath, { recursive: true, force: true })
  await symlink(packageRoot, targetPath, 'junction')

  return runtimeRoot
}

async function cleanupRuntimeDependencyLink(projectRoot: string): Promise<void> {
  await rm(join(projectRoot, CLI_RUNTIME_ROOT, 'node_modules'), { recursive: true, force: true })
}
/* v8 ignore stop */

function createRuntimeInvocation(script: string): { command: string, args: string[] } {
  return {
    command: 'node',
    args: ['--input-type=module', '--eval', script],
  }
}

function getRuntimeFailureMessage(kind: string, result: RuntimeSpawnResult): string {
  const stderr = result.stderr?.trim()
  if (stderr) {
    return stderr
  }

  const stdout = result.stdout?.trim()
  if (stdout) {
    return stdout
  }

  const errorCode = result.error && 'code' in result.error ? result.error.code : undefined
  if (typeof errorCode === 'string' && errorCode.length > 0) {
    return `Failed to launch runtime command "${kind}": ${errorCode}.`
  }

  return `Runtime command "${kind}" failed.`
}

/* v8 ignore start */
async function withRuntimeEnvironment<T>(
  projectRoot: string,
  kind: 'migrate' | 'fresh' | 'rollback' | 'seed' | 'prune',
  options: Record<string, unknown>,
  callback: (stdout: string) => Promise<T>,
): Promise<T> {
  const environment = await getRuntimeEnvironment(projectRoot)

  try {
    const envRuntimeConfig = createEnvRuntimeConfig()
    const runtimeDatabaseConfig = mergeRuntimeDatabaseConfig(
      environment.project.config.database,
      envRuntimeConfig,
    )
    const runtimeRoot = await ensureRuntimeDependencyLink(projectRoot)
    const runtimePayload = JSON.stringify({
      kind,
      projectRoot,
      runtimeConfig: {
        db: runtimeDatabaseConfig,
      },
      models: environment.bundledModels.map(entry => pathToFileURL(entry).href),
      migrations: environment.bundledMigrations.map(entry => pathToFileURL(entry).href),
      seeders: environment.bundledSeeders.map(entry => pathToFileURL(entry).href),
      generatedSchema: environment.bundledGeneratedSchema ? pathToFileURL(environment.bundledGeneratedSchema).href : undefined,
      generatedSchemaOutputPath: resolveGeneratedSchemaPath(projectRoot, environment.project.config),
      options,
    })
    const runtime = createRuntimeInvocation(nodeRuntimeScript)
    const result = spawnSync(runtime.command, runtime.args, {
      cwd: runtimeRoot,
      env: {
        ...process.env,
        HOLO_RUNTIME_PAYLOAD: runtimePayload,
      },
      encoding: 'utf8',
    })

    if (result.status !== 0) {
      throw new Error(getRuntimeFailureMessage(kind, result))
    }

    return await callback(result.stdout.trim())
  } finally {
    await cleanupRuntimeDependencyLink(projectRoot)
    await environment.cleanup()
  }
}
/* v8 ignore stop */

function createCommandContext(
  io: IoStreams,
  projectRoot: string,
  loadProject: () => Promise<LoadedProjectConfig>,
  input: PreparedInput,
): CommandExecutionContext {
  return {
    cwd: io.cwd,
    projectRoot,
    args: input.args,
    flags: input.flags,
    loadProject,
  }
}

async function runMakeModel(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  /* v8 ignore next */
  const requestedName = String(input.args[0] ?? '')
  const options = {
    migration: input.flags.migration === true,
    observer: input.flags.observer === true,
    seeder: input.flags.seeder === true,
    factory: input.flags.factory === true,
  }
  const nameInfo = resolveNameInfo(requestedName)
  const explicitTableName = resolveStringFlag(input.flags, 'table')
  const tableName = explicitTableName ? toSnakeCase(explicitTableName) : nameInfo.tableName
  const modelFilePath = resolveArtifactPath(projectRoot, project.config.paths.models, nameInfo.directory, `${nameInfo.baseName}.ts`)
  const observerInfo = resolveNameInfo(`${requestedName}Observer`, { suffix: 'Observer' })
  const observerFilePath = resolveArtifactPath(projectRoot, project.config.paths.observers, observerInfo.directory, `${observerInfo.baseName}.ts`)
  const seederInfo = resolveNameInfo(`${requestedName}Seeder`, { suffix: 'Seeder' })
  const seederFilePath = resolveArtifactPath(projectRoot, project.config.paths.seeders, seederInfo.directory, `${seederInfo.baseName}.ts`)
  const factoryInfo = resolveNameInfo(`${requestedName}Factory`, { suffix: 'Factory' })
  const factoryFilePath = resolveArtifactPath(projectRoot, project.config.paths.factories, factoryInfo.directory, `${factoryInfo.baseName}.ts`)
  const generatedSchemaFilePath = await ensureGeneratedSchemaPlaceholder(projectRoot, project.config)

  if (await fileExists(modelFilePath) || hasRegisteredModelName(registry, nameInfo.baseName)) {
    throw new Error(`Model with the same name already exists: ${nameInfo.baseName}.`)
  }

  if (options.migration) {
    const migrationName = normalizeMigrationSlug(`create_${tableName}_table`)
    if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
      throw new Error(`A migration for table "${tableName}" already exists.`)
    }
  }

  await ensureAbsent(modelFilePath)
  if (options.observer) {
    await ensureAbsent(observerFilePath)
  }
  if (options.seeder) {
    await ensureAbsent(seederFilePath)
  }
  if (options.factory) {
    await ensureAbsent(factoryFilePath)
  }

  if (options.observer) {
    await writeTextFile(observerFilePath, renderObserverTemplate(observerInfo.baseName))
  }

  await writeTextFile(modelFilePath, renderModelTemplate({
    tableName,
    generatedSchemaImportPath: relativeImportPath(modelFilePath, generatedSchemaFilePath),
    ...(options.observer
      ? {
          observerImportPath: relativeImportPath(modelFilePath, observerFilePath),
          observerClassName: observerInfo.baseName,
        }
      /* v8 ignore next */
      : {}),
  }))

  if (options.factory) {
    await writeTextFile(factoryFilePath, renderFactoryTemplate(
      relativeImportPath(factoryFilePath, modelFilePath),
      nameInfo.baseName,
    ))
  }

  if (options.seeder) {
    await writeTextFile(seederFilePath, renderSeederTemplate(seederInfo.snakeStem))
  }

  if (options.migration) {
    const migrationName = normalizeMigrationSlug(`create_${tableName}_table`)
    const migrationTemplate = await nextMigrationTemplate(
      migrationName,
      resolve(projectRoot, project.config.paths.migrations),
    )
    const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)
    await writeTextFile(migrationFilePath, migrationTemplate.contents)
  }
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created model: ${makeProjectRelativePath(projectRoot, modelFilePath)}`)
  if (options.migration) {
    writeLine(io.stdout, `Registered migration for ${nameInfo.baseName}.`)
  }
  if (options.seeder) {
    writeLine(io.stdout, `Registered seeder for ${nameInfo.baseName}.`)
  }
}

async function runMakeMigration(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  /* v8 ignore next */
  const requestedName = String(input.args[0] ?? '')
  const createTable = typeof input.flags.create === 'string' ? normalizeMigrationSlug(input.flags.create) : undefined
  const alterTable = typeof input.flags.table === 'string' ? normalizeMigrationSlug(input.flags.table) : undefined

  if (createTable && alterTable) {
    throw new Error('Use either "--create" or "--table", not both.')
  }

  const requestedSlug = normalizeMigrationSlug(requestedName)
  if (createTable) {
    if (hasRegisteredCreateTableMigration(registry, createTable)) {
      throw new Error(`A migration for table "${createTable}" already exists.`)
    }
  } else if (alterTable) {
    if (hasRegisteredMigrationSlug(registry, requestedSlug)) {
      throw new Error(`A migration named "${requestedSlug}" already exists.`)
    }
  } else if (hasRegisteredMigrationSlug(registry, requestedSlug)) {
    throw new Error(`A migration named "${requestedSlug}" already exists.`)
  }

  const migrationTemplate = await nextMigrationTemplate(
    requestedSlug,
    resolve(projectRoot, project.config.paths.migrations),
    {
      ...(createTable ? { kind: 'create_table' as const, tableName: createTable } : {}),
      ...(alterTable ? { kind: 'alter_table' as const, tableName: alterTable } : {}),
    },
  )
  const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)

  await writeTextFile(migrationFilePath, migrationTemplate.contents)
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, migrationFilePath)}`)
}

async function runQueueTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const queueConfig = await loadQueueConfig(projectRoot)
  const migrationsDir = resolve(projectRoot, project.config.paths.migrations)
  const createdFiles: string[] = []

  for (const tableName of resolveDatabaseQueueTables(queueConfig)) {
    const migrationName = normalizeQueueMigrationName(tableName)
    if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
      throw new Error(`A migration for table "${tableName}" already exists.`)
    }
  }

  for (const tableName of resolveDatabaseQueueTables(queueConfig)) {
    const migrationTemplate = await nextMigrationTemplate(normalizeQueueMigrationName(tableName), migrationsDir)
    const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)
    await writeTextFile(migrationFilePath, renderQueueTableMigration(tableName))
    createdFiles.push(migrationFilePath)
  }

  await runProjectPrepare(projectRoot)

  for (const filePath of createdFiles) {
    writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, filePath)}`)
  }
}

async function runQueueFailedTableCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const queueConfig = await loadQueueConfig(projectRoot)
  const tableName = queueConfig.failed === false ? DEFAULT_FAILED_JOBS_TABLE : queueConfig.failed.table
  const migrationName = normalizeQueueMigrationName(tableName)

  if (hasRegisteredMigrationSlug(registry, migrationName) || hasRegisteredCreateTableMigration(registry, tableName)) {
    throw new Error(`A migration for table "${tableName}" already exists.`)
  }

  const migrationTemplate = await nextMigrationTemplate(
    migrationName,
    resolve(projectRoot, project.config.paths.migrations),
  )
  const migrationFilePath = resolveDefaultArtifactPath(projectRoot, project.config.paths.migrations, migrationTemplate.fileName)

  await writeTextFile(migrationFilePath, renderFailedJobsTableMigration(tableName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created migration: ${makeProjectRelativePath(projectRoot, migrationFilePath)}`)
}

async function runQueueFailedCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    initialize?: (projectRoot: string) => Promise<HoloRuntime>
    list?: QueueCliModule['listFailedQueueJobs']
  } = {},
): Promise<void> {
  const runtime = await (dependencies.initialize ?? initializeProjectRuntime)(projectRoot, {
    registerProjectQueueJobs: false,
  })

  try {
    const queueModule = dependencies.list ? undefined : await loadQueueCliModule(projectRoot)
    const failedJobs = await (dependencies.list ?? queueModule!.listFailedQueueJobs)()
    if (failedJobs.length === 0) {
      writeLine(io.stdout, '[queue] No failed jobs.')
      return
    }

    for (const job of failedJobs) {
      writeLine(
        io.stdout,
        `${job.id} ${job.job.name} connection=${job.job.connection} queue=${job.job.queue} failedAt=${job.failedAt}`,
      )
    }
  } finally {
    await runtime.shutdown()
  }
}

async function runQueueRetryCommand(
  io: IoStreams,
  projectRoot: string,
  identifier: 'all' | string,
  dependencies: {
    initialize?: (projectRoot: string) => Promise<HoloRuntime>
    retry?: QueueCliModule['retryFailedQueueJobs']
  } = {},
): Promise<void> {
  const runtime = await (dependencies.initialize ?? initializeProjectRuntime)(projectRoot, {
    registerProjectQueueJobs: false,
  })

  try {
    const queueModule = dependencies.retry ? undefined : await loadQueueCliModule(projectRoot)
    const retried = await (dependencies.retry ?? queueModule!.retryFailedQueueJobs)(identifier)
    writeLine(io.stdout, `[queue] Retried ${retried} failed job(s).`)
  } finally {
    await runtime.shutdown()
  }
}

async function runQueueForgetCommand(
  io: IoStreams,
  projectRoot: string,
  identifier: string,
  dependencies: {
    initialize?: (projectRoot: string) => Promise<HoloRuntime>
    forget?: QueueCliModule['forgetFailedQueueJob']
  } = {},
): Promise<void> {
  const runtime = await (dependencies.initialize ?? initializeProjectRuntime)(projectRoot, {
    registerProjectQueueJobs: false,
  })

  try {
    const queueModule = dependencies.forget ? undefined : await loadQueueCliModule(projectRoot)
    const forgotten = await (dependencies.forget ?? queueModule!.forgetFailedQueueJob)(identifier)
    writeLine(io.stdout, forgotten
      ? `[queue] Forgot failed job ${identifier}.`
      : `[queue] Failed job ${identifier} was not found.`)
  } finally {
    await runtime.shutdown()
  }
}

async function runQueueFlushCommand(
  io: IoStreams,
  projectRoot: string,
  dependencies: {
    initialize?: (projectRoot: string) => Promise<HoloRuntime>
    flush?: QueueCliModule['flushFailedQueueJobs']
  } = {},
): Promise<void> {
  const runtime = await (dependencies.initialize ?? initializeProjectRuntime)(projectRoot, {
    registerProjectQueueJobs: false,
  })

  try {
    const queueModule = dependencies.flush ? undefined : await loadQueueCliModule(projectRoot)
    const flushed = await (dependencies.flush ?? queueModule!.flushFailedQueueJobs)()
    writeLine(io.stdout, `[queue] Flushed ${flushed} failed job(s).`)
  } finally {
    await runtime.shutdown()
  }
}

async function runMakeSeeder(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Seeder' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.seeders, info.directory, `${info.baseName}.ts`)

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderSeederTemplate(info.snakeStem))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created seeder: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

async function runMakeJob(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.jobs, directory, `${fileStem}.ts`)
  const jobName = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredJobName(registry, jobName)) {
    throw new Error(`Job with the same name already exists: ${jobName}.`)
  }

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderJobTemplate())
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created job: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

async function runMakeEvent(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.events, directory, `${fileStem}.ts`)
  const eventName = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredEventName(registry, eventName)) {
    throw new Error(`Event with the same name already exists: ${eventName}.`)
  }

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderEventTemplate(eventName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created event: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

async function runMakeListener(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  const registry = await loadGeneratedProjectRegistry(projectRoot)
    ?? await prepareProjectDiscovery(projectRoot, project.config)
  const requestedName = String(input.args[0] ?? '')
  const requestedEvents = Array.isArray(input.flags.event)
    ? input.flags.event.map(value => String(value).trim()).filter(Boolean)
    : [String(input.flags.event ?? '').trim()].filter(Boolean)
  const eventNames = [...new Set(requestedEvents)]
  const eventEntries = eventNames.map((eventName) => {
    const entry = registry?.events.find(candidate => candidate.name === eventName)
    if (!entry) {
      throw new Error(`Unknown event: ${eventName}.`)
    }

    return entry
  })

  const nameParts = splitRequestedName(requestedName)
  const directory = nameParts.directory
    .split('/')
    .filter(Boolean)
    .map(segment => toKebabCase(segment))
    .join('/')
  const fileStem = toKebabCase(nameParts.rawBaseName)
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.listeners, directory, `${fileStem}.ts`)
  const listenerId = [...(directory ? directory.split('/') : []), fileStem].join('.')

  if (await fileExists(filePath) || hasRegisteredListenerId(registry, listenerId)) {
    throw new Error(`Listener with the same id already exists: ${listenerId}.`)
  }

  const templateEvents = eventEntries.map((eventEntry, index) => {
    const sourceEventBaseName = eventEntry.sourcePath.split('/').pop()!.replace(/\.[^.]+$/, '')
    const importName = `${toPascalCase(sourceEventBaseName)}Event${index + 1}`
    const importPath = relativeImportPath(filePath, resolve(projectRoot, eventEntry.sourcePath))
    return {
      importName,
      importStatement: eventEntry.exportName && eventEntry.exportName !== 'default'
        ? `import { ${eventEntry.exportName} as ${importName} } from '${importPath}'`
        : `import ${importName} from '${importPath}'`,
    }
  })

  await ensureAbsent(filePath)
  await writeTextFile(
    filePath,
    templateEvents.length === 1
      ? renderListenerTemplate(templateEvents[0]!.importStatement, templateEvents[0]!.importName)
      : renderMultiListenerTemplate(templateEvents),
  )
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created listener: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

async function runMakeObserver(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Observer' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.observers, info.directory, `${info.baseName}.ts`)

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderObserverTemplate(info.baseName))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created observer: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

async function runMakeFactory(
  io: IoStreams,
  projectRoot: string,
  input: PreparedInput,
): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  /* v8 ignore next */
  const info = resolveNameInfo(String(input.args[0] ?? ''), { suffix: 'Factory' })
  const filePath = resolveArtifactPath(projectRoot, project.config.paths.factories, info.directory, `${info.baseName}.ts`)
  const baseName = info.baseStem
  const modelInfo = splitRequestedName(baseName)
  const modelFilePath = resolveArtifactPath(
    projectRoot,
    project.config.paths.models,
    info.directory,
    `${toPascalCase(modelInfo.rawBaseName)}.ts`,
  )

  await ensureAbsent(filePath)
  await writeTextFile(filePath, renderFactoryTemplate(
    relativeImportPath(filePath, modelFilePath),
    toPascalCase(modelInfo.rawBaseName),
  ))
  await runProjectPrepare(projectRoot)

  writeLine(io.stdout, `Created factory: ${makeProjectRelativePath(projectRoot, filePath)}`)
}

function printCommandList(io: IoStreams, registry: readonly CommandDefinition[]): void {
  const internal = registry.filter(command => command.source === 'internal')
  const app = registry.filter(command => command.source === 'app')

  writeLine(io.stdout, 'Internal Commands')
  for (const command of internal) {
    writeLine(io.stdout, `  ${command.usage}  ${command.description}`)
  }

  writeLine(io.stdout)
  writeLine(io.stdout, 'App Commands')
  if (app.length === 0) {
    writeLine(io.stdout, '  (none)')
    return
  }

  for (const command of app) {
    writeLine(io.stdout, `  ${command.usage}  ${command.description}`)
  }
}

function printCommandHelp(io: IoStreams, command: CommandDefinition): void {
  writeLine(io.stdout, command.usage)
  writeLine(io.stdout, command.description)
}

function resolvePackageManagerInstallCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun install'
    case 'npm':
      return 'npm install'
    case 'pnpm':
      return 'pnpm install'
    case 'yarn':
      return 'yarn install'
  }
}

function resolvePackageManagerDevCommand(packageManager: SupportedScaffoldPackageManager): string {
  switch (packageManager) {
    case 'bun':
      return 'bun run dev'
    case 'npm':
      return 'npm run dev'
    case 'pnpm':
      return 'pnpm dev'
    case 'yarn':
      return 'yarn dev'
  }
}

function createInternalCommands(
  context: InternalCommandContext,
  runtimeExecutor: typeof withRuntimeEnvironment = withRuntimeEnvironment,
  queueExecutors: {
    runQueueFailedCommand?: typeof runQueueFailedCommand
    runQueueFailedTableCommand?: typeof runQueueFailedTableCommand
    runQueueFlushCommand?: typeof runQueueFlushCommand
    runQueueWorkCommand?: typeof runQueueWorkCommand
    runQueueForgetCommand?: typeof runQueueForgetCommand
    runQueueListen?: typeof runQueueListen
    runQueueRestartCommand?: typeof runQueueRestartCommand
    runQueueRetryCommand?: typeof runQueueRetryCommand
    runQueueTableCommand?: typeof runQueueTableCommand
    runQueueClearCommand?: typeof runQueueClearCommand
  } = {},
  projectExecutors: {
    runProjectPrepare?: typeof runProjectPrepare
    runProjectDevServer?: typeof runProjectDevServer
    runProjectLifecycleScript?: typeof runProjectLifecycleScript
  } = {},
): CommandDefinition[] {
  const queueCommandExecutors = {
    runQueueFailedCommand,
    runQueueFailedTableCommand,
    runQueueFlushCommand,
    runQueueWorkCommand,
    runQueueForgetCommand,
    runQueueListen,
    runQueueRestartCommand,
    runQueueRetryCommand,
    runQueueTableCommand,
    runQueueClearCommand,
    ...queueExecutors,
  }
  const projectCommandExecutors = {
    runProjectPrepare,
    runProjectDevServer,
    runProjectLifecycleScript,
    ...projectExecutors,
  }

  return [
    {
      name: 'list',
      description: 'List all available internal and app commands.',
      usage: 'holo list',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        printCommandList(context, context.registry)
      },
    },
    {
      name: 'new',
      description: 'Scaffold a new Holo project',
      usage: 'holo-js new <name> [--framework <nuxt|next|sveltekit>] [--database <sqlite|mysql|postgres>] [--package-manager <bun|npm|pnpm|yarn>] [--package <storage|events|queue|validation|forms>] [--storage-default-disk <local|public>]',
      source: 'internal',
      async prepare(input) {
        const resolved = await resolveNewProjectInput(context, input)

        return {
          args: [resolved.projectName],
          flags: {
            framework: resolved.framework,
            database: resolved.databaseDriver,
            ['package-manager']: resolved.packageManager,
            ['storage-default-disk']: resolved.storageDefaultDisk,
            ...(resolved.optionalPackages.length > 0
              ? { package: resolved.optionalPackages }
              : {}),
          },
        }
      },
      async run(commandContext) {
        const projectName = String(commandContext.args[0] ?? '')
        const framework = String(commandContext.flags.framework ?? 'nuxt') as SupportedScaffoldFramework
        const databaseDriver = String(commandContext.flags.database ?? 'sqlite') as ProjectScaffoldOptions['databaseDriver']
        const packageManager = String(commandContext.flags['package-manager'] ?? 'bun') as SupportedScaffoldPackageManager
        const storageDefaultDisk = String(commandContext.flags['storage-default-disk'] ?? 'local') as SupportedScaffoldStorageDisk
        const optionalPackages = normalizeOptionalPackages(
          (collectMultiStringFlag(commandContext.flags, 'package') ?? []).flatMap(entry => splitCsv(entry) ?? []),
        )
        const targetDir = resolve(commandContext.cwd, projectName)

        await scaffoldProject(targetDir, {
          projectName,
          framework,
          databaseDriver,
          packageManager,
          storageDefaultDisk,
          optionalPackages,
        })

        writeLine(context.stdout, `Created Holo project: ${targetDir}`)
        writeLine(context.stdout)
        writeLine(context.stdout, 'Next steps')
        writeLine(context.stdout, `  cd ${projectName}`)
        writeLine(context.stdout, `  ${resolvePackageManagerInstallCommand(packageManager)}`)
        writeLine(context.stdout, `  ${resolvePackageManagerDevCommand(packageManager)}`)
      },
    },
    {
      name: 'install',
      description: 'Install first-party Holo support into an existing project.',
      usage: 'holo install <queue|events> [--driver <sync|redis|database>]',
      source: 'internal',
      async prepare(input) {
        const target = normalizeChoice(
          await ensureRequiredArg(context, input, 0, 'Install target'),
          SUPPORTED_INSTALL_TARGETS,
          'install target',
        )
        const requestedDriver = resolveStringFlag(input.flags, 'driver')
        if (target === 'events' && requestedDriver) {
          throw new Error('The events installer does not support --driver.')
        }

        const driver = target === 'queue'
          ? (requestedDriver
              ? normalizeChoice(requestedDriver, SUPPORTED_QUEUE_INSTALL_DRIVERS, 'queue driver')
              : 'sync')
          : undefined

        return {
          args: [target],
          flags: {
            ...(driver ? { driver } : {}),
          },
        }
      },
      async run(commandContext) {
        const target = String(commandContext.args[0] ?? '')

        if (target === 'events') {
          const eventsResult = await installEventsIntoProject(context.projectRoot)
          let queueResult:
            | Awaited<ReturnType<typeof installQueueIntoProject>>
            | undefined

          const queueConfigured = await hasProjectDependency(context.projectRoot, '@holo-js/queue')
            || await fileExists(resolve(context.projectRoot, 'config/queue.ts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mts'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.js'))
            || await fileExists(resolve(context.projectRoot, 'config/queue.mjs'))

          if (
            !queueConfigured
            && isInteractive(context, commandContext.flags as Record<string, string | boolean | readonly string[]>)
          ) {
            const enableQueuedListeners = await confirm(
              context,
              'Enable queued listeners too?',
              false,
            )

            if (enableQueuedListeners) {
              queueResult = await installQueueIntoProject(context.projectRoot, { driver: 'sync' })
            }
          }

          const changed = eventsResult.updatedPackageJson
            || eventsResult.createdEventsDirectory
            || eventsResult.createdListenersDirectory
            || !!queueResult

          writeLine(context.stdout, changed ? 'Installed events support.' : 'Events support is already installed.')
          if (eventsResult.updatedPackageJson || queueResult?.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
          if (eventsResult.createdEventsDirectory) writeLine(context.stdout, '  - created server/events')
          if (eventsResult.createdListenersDirectory) writeLine(context.stdout, '  - created server/listeners')
          if (queueResult) {
            writeLine(context.stdout, '  - enabled queued listeners')
            if (queueResult.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnv) writeLine(context.stdout, '  - updated .env')
            /* v8 ignore next 2 -- queued listeners are auto-enabled with the sync driver in this flow */
            if (queueResult.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
            if (queueResult.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
          }
          return
        }

        if (target !== 'queue') {
          throw new Error(`Unsupported install target: ${target || '(empty)'}.`)
        }

        const result = await installQueueIntoProject(context.projectRoot, {
          driver: String(commandContext.flags.driver ?? 'sync') as SupportedQueueInstallerDriver,
        })

        const changed = result.createdQueueConfig
          || result.updatedPackageJson
          || result.updatedEnv
          || result.updatedEnvExample
          || result.createdJobsDirectory

        writeLine(context.stdout, changed ? 'Installed queue support.' : 'Queue support is already installed.')
        if (result.createdQueueConfig) writeLine(context.stdout, '  - created config/queue.ts')
        if (result.updatedPackageJson) writeLine(context.stdout, '  - updated package.json')
        if (result.updatedEnv) writeLine(context.stdout, '  - updated .env')
        if (result.updatedEnvExample) writeLine(context.stdout, '  - updated .env.example')
        if (result.createdJobsDirectory) writeLine(context.stdout, '  - created server/jobs')
      },
    },
    {
      name: 'prepare',
      description: 'Discover Holo resources and refresh generated registries.',
      usage: 'holo prepare',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await projectCommandExecutors.runProjectPrepare(context.projectRoot, context)
        writeLine(context.stdout, 'Prepared Holo discovery artifacts.')
      },
    },
    {
      name: 'dev',
      description: 'Prepare Holo discovery artifacts and run the project dev script.',
      usage: 'holo dev',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await projectCommandExecutors.runProjectDevServer(context, context.projectRoot)
      },
    },
    {
      name: 'build',
      description: 'Prepare Holo discovery artifacts and run the project build script.',
      usage: 'holo build',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await projectCommandExecutors.runProjectPrepare(context.projectRoot, context)
        await projectCommandExecutors.runProjectLifecycleScript(context, context.projectRoot, 'holo:build')
      },
    },
    {
      name: 'queue:table',
      description: 'Generate the database queue jobs table migration.',
      usage: 'holo queue:table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await queueCommandExecutors.runQueueTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:failed-table',
      description: 'Generate the failed jobs table migration.',
      usage: 'holo queue:failed-table',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await queueCommandExecutors.runQueueFailedTableCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:work',
      description: 'Run the queue worker for an async queue connection.',
      usage: 'holo queue:work [--connection <name>] [--queue <name>] [--once] [--stop-when-empty] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            once: resolveBooleanFlag(input.flags, 'once'),
            ['stop-when-empty']: resolveBooleanFlag(input.flags, 'stop-when-empty'),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        await queueCommandExecutors.runQueueWorkCommand(context, context.projectRoot, {
          ...(typeof commandContext.flags.connection === 'string' ? { connection: commandContext.flags.connection } : {}),
          ...(Array.isArray(commandContext.flags.queue) ? { queueNames: commandContext.flags.queue } : {}),
          once: commandContext.flags.once === true,
          stopWhenEmpty: commandContext.flags['stop-when-empty'] === true,
          ...(typeof commandContext.flags.sleep === 'number' ? { sleep: commandContext.flags.sleep } : {}),
          ...(typeof commandContext.flags.tries === 'number' ? { tries: commandContext.flags.tries } : {}),
          ...(typeof commandContext.flags.timeout === 'number' ? { timeout: commandContext.flags.timeout } : {}),
          ...(typeof commandContext.flags['max-jobs'] === 'number' ? { maxJobs: commandContext.flags['max-jobs'] } : {}),
          ...(typeof commandContext.flags['max-time'] === 'number' ? { maxTime: commandContext.flags['max-time'] } : {}),
        })
      },
    },
    {
      name: 'queue:listen',
      description: 'Watch queue-related project files and restart the queue worker on change.',
      usage: 'holo queue:listen [--connection <name>] [--queue <name>] [--sleep N] [--tries N] [--timeout N] [--max-jobs N] [--max-time N]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        const sleep = parseNumberFlag(input.flags, 'sleep')
        const tries = parseNumberFlag(input.flags, 'tries')
        const timeout = parseNumberFlag(input.flags, 'timeout')
        const maxJobs = parseNumberFlag(input.flags, 'max-jobs')
        const maxTime = parseNumberFlag(input.flags, 'max-time')
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
            ...(typeof sleep === 'number' ? { sleep } : {}),
            ...(typeof tries === 'number' ? { tries } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(typeof maxJobs === 'number' ? { ['max-jobs']: maxJobs } : {}),
            ...(typeof maxTime === 'number' ? { ['max-time']: maxTime } : {}),
          },
        }
      },
      async run(commandContext) {
        await queueCommandExecutors.runQueueListen(context, context.projectRoot, commandContext.flags)
      },
    },
    {
      name: 'queue:restart',
      description: 'Signal long-lived queue workers to restart after the current job.',
      usage: 'holo queue:restart',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await queueCommandExecutors.runQueueRestartCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:clear',
      description: 'Clear pending jobs for a queue connection.',
      usage: 'holo queue:clear [--connection <name>] [--queue <name>]',
      source: 'internal',
      async prepare(input) {
        const connection = resolveStringFlag(input.flags, 'connection', 'c')
        const queueNames = (collectMultiStringFlag(input.flags, 'queue', 'q') ?? []).flatMap(entry => splitCsv(entry))
        return {
          args: [],
          flags: {
            ...(connection ? { connection } : {}),
            ...(queueNames && queueNames.length > 0 ? { queue: queueNames } : {}),
          },
        }
      },
      async run(commandContext) {
        await queueCommandExecutors.runQueueClearCommand(
          context,
          context.projectRoot,
          typeof commandContext.flags.connection === 'string' ? commandContext.flags.connection : undefined,
          Array.isArray(commandContext.flags.queue) ? commandContext.flags.queue : undefined,
        )
      },
    },
    {
      name: 'queue:failed',
      description: 'List failed queued jobs.',
      usage: 'holo queue:failed',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await queueCommandExecutors.runQueueFailedCommand(context, context.projectRoot)
      },
    },
    {
      name: 'queue:retry',
      description: 'Retry one failed job or all failed jobs.',
      usage: 'holo queue:retry <id|all>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        await queueCommandExecutors.runQueueRetryCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:forget',
      description: 'Delete one failed job record.',
      usage: 'holo queue:forget <id>',
      source: 'internal',
      async prepare(input) {
        const identifier = await ensureRequiredArg(context, input, 0, 'Failed job id')
        return {
          args: [identifier],
          flags: {},
        }
      },
      async run(commandContext) {
        await queueCommandExecutors.runQueueForgetCommand(
          context,
          context.projectRoot,
          String(commandContext.args[0] ?? ''),
        )
      },
    },
    {
      name: 'queue:flush',
      description: 'Clear the failed jobs table.',
      usage: 'holo queue:flush',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        await queueCommandExecutors.runQueueFlushCommand(context, context.projectRoot)
      },
    },
    {
      name: 'config:cache',
      description: 'Compile config files into a reusable cache artifact.',
      usage: 'holo config:cache',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const cachePath = await cacheProjectConfig(context.projectRoot)
        writeLine(context.stdout, `Config cached: ${cachePath}`)
      },
    },
    {
      name: 'config:clear',
      description: 'Remove the generated config cache artifact.',
      usage: 'holo config:clear',
      source: 'internal',
      async prepare() {
        return { args: [], flags: {} }
      },
      async run() {
        const removed = await clearConfigCache(context.projectRoot)
        const cachePath = resolveConfigCachePath(context.projectRoot)
        writeLine(
          context.stdout,
          removed ? `Config cache cleared: ${cachePath}` : `Config cache was already clear: ${cachePath}`,
        )
      },
    },
    {
      name: 'make:model',
      description: 'Create a model and optionally related database artifacts.',
      usage: 'holo make:model <name> [--table <table>] [-m] [-o] [-s] [-f]',
      source: 'internal',
      async prepare(input) {
        const name = await ensureRequiredArg(context, input, 0, 'Model name')
        const table = resolveStringFlag(input.flags, 'table')
        const flags: PreparedInput['flags'] = {
          migration: resolveBooleanFlag(input.flags, 'migration', 'm'),
          observer: resolveBooleanFlag(input.flags, 'observer', 'o'),
          seeder: resolveBooleanFlag(input.flags, 'seeder', 's'),
          factory: resolveBooleanFlag(input.flags, 'factory', 'f'),
          ...(typeof table === 'string' ? { table } : {}),
        }

        /* v8 ignore start */
        if (isInteractive(context, input.flags)) {
          const noneSelected = [flags.migration, flags.observer, flags.seeder, flags.factory].every(value => value !== true)
          if (noneSelected && await confirm(context, 'Generate a migration?', true)) {
            flags.migration = true
          }
          if (!flags.observer && await confirm(context, 'Generate an observer?')) {
            flags.observer = true
          }
          if (!flags.seeder && await confirm(context, 'Generate a seeder?')) {
            flags.seeder = true
          }
          if (!flags.factory && await confirm(context, 'Generate a factory?')) {
            flags.factory = true
          }
        }
        /* v8 ignore stop */

        return {
          args: [name],
          flags,
        }
      },
      async run(commandContext) {
        await runMakeModel(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:migration',
      description: 'Create and register a migration file.',
      usage: 'holo make:migration <name> [--create users] [--table users]',
      source: 'internal',
      async prepare(input) {
        const create = resolveStringFlag(input.flags, 'create')
        const table = resolveStringFlag(input.flags, 'table')

        if (create && table) {
          throw new Error('Use either "--create" or "--table", not both.')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Migration name')],
          flags: {
            ...(typeof create === 'string' ? { create } : {}),
            ...(typeof table === 'string' ? { table } : {}),
          },
        }
      },
      async run(commandContext) {
        await runMakeMigration(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:seeder',
      description: 'Create and register a seeder file.',
      usage: 'holo make:seeder <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Seeder name')],
          flags: {},
        }
      },
      async run(commandContext) {
        await runMakeSeeder(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:event',
      description: 'Create and register an event file.',
      usage: 'holo make:event <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Event name')],
          flags: {},
        }
      },
      async run(commandContext) {
        await runMakeEvent(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:job',
      description: 'Create and register a queue job file.',
      usage: 'holo make:job <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Job name')],
          flags: {},
        }
      },
      async run(commandContext) {
        await runMakeJob(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:listener',
      description: 'Create and register an event listener file.',
      usage: 'holo make:listener <name> --event <event-name> [--event <event-name>]',
      source: 'internal',
      async prepare(input) {
        const eventNames = (collectMultiStringFlag(input.flags, 'event') ?? [])
          .flatMap(entry => splitCsv(entry))
          .map(value => value.trim())
          .filter(Boolean)
        if (eventNames.length === 0) {
          throw new Error('Listener event name is required. Use "--event <event-name>".')
        }

        return {
          args: [await ensureRequiredArg(context, input, 0, 'Listener name')],
          flags: { event: eventNames },
        }
      },
      async run(commandContext) {
        await runMakeListener(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:observer',
      description: 'Create an observer file.',
      usage: 'holo make:observer <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Observer name')],
          flags: {},
        }
      },
      async run(commandContext) {
        await runMakeObserver(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'make:factory',
      description: 'Create a factory file.',
      usage: 'holo make:factory <name>',
      source: 'internal',
      async prepare(input) {
        return {
          args: [await ensureRequiredArg(context, input, 0, 'Factory name')],
          flags: {},
        }
      },
      async run(commandContext) {
        await runMakeFactory(context, context.projectRoot, {
          args: commandContext.args,
          flags: { ...commandContext.flags },
        })
      },
    },
    {
      name: 'migrate',
      description: 'Run registered migrations.',
      usage: 'holo migrate [--step N]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(typeof parseNumberFlag(input.flags, 'step') === 'number' ? { step: parseNumberFlag(input.flags, 'step')! } : {}),
          },
        }
      },
      async run(commandContext) {
        await runtimeExecutor(
          context.projectRoot,
          'migrate',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:fresh',
      description: 'Drop all tables and rerun all registered migrations.',
      usage: 'holo migrate:fresh [--seed] [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            seed: resolveBooleanFlag(input.flags, 'seed'),
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        await runtimeExecutor(
          context.projectRoot,
          'fresh',
          {
            seed: false,
          },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )

        if (commandContext.flags.seed !== true) {
          return
        }

        await runtimeExecutor(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'migrate:rollback',
      description: 'Rollback registered migrations.',
      usage: 'holo migrate:rollback [--step N] [--batch N]',
      source: 'internal',
      async prepare(input) {
        const step = parseNumberFlag(input.flags, 'step')
        const batch = parseNumberFlag(input.flags, 'batch')
        return {
          args: [],
          flags: {
            ...(typeof step === 'number' ? { step } : {}),
            ...(typeof batch === 'number' ? { batch } : {}),
          },
        }
      },
      async run(commandContext) {
        await runtimeExecutor(
          context.projectRoot,
          'rollback',
          {
            ...(typeof commandContext.flags.step === 'number' ? { step: commandContext.flags.step } : {}),
            ...(typeof commandContext.flags.batch === 'number' ? { batch: commandContext.flags.batch } : {}),
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No migrations were executed.')
          },
        )
      },
    },
    {
      name: 'seed',
      description: 'Run registered seeders.',
      usage: 'holo seed [--only a,b,c] [--quietly] [--force]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [],
          flags: {
            ...(collectMultiStringFlag(input.flags, 'only')
              ? { only: collectMultiStringFlag(input.flags, 'only')!.flatMap(entry => splitCsv(entry)) }
              : {}),
            quietly: resolveBooleanFlag(input.flags, 'quietly'),
            force: resolveBooleanFlag(input.flags, 'force'),
          },
        }
      },
      async run(commandContext) {
        await runtimeExecutor(
          context.projectRoot,
          'seed',
          {
            ...(Array.isArray(commandContext.flags.only) ? { only: commandContext.flags.only } : {}),
            quietly: commandContext.flags.quietly === true,
            force: commandContext.flags.force === true,
            environment: process.env.APP_ENV ?? process.env.NODE_ENV ?? 'development',
          },
          async (stdout) => {
            writeLine(context.stdout, stdout || 'No seeders were executed.')
          },
        )
      },
    },
    {
      name: 'prune',
      description: 'Prune registered prunable models.',
      usage: 'holo prune [ModelName ...]',
      source: 'internal',
      async prepare(input) {
        return {
          args: [...input.args],
          flags: {},
        }
      },
      async run(commandContext) {
        await runtimeExecutor(
          context.projectRoot,
          'prune',
          { models: [...commandContext.args] },
          async (stdout) => {
            for (const line of stdout.split('\n').filter(Boolean)) {
              writeLine(context.stdout, line)
            }
          },
        )
      },
    },
  ]
}

function createAppCommandDefinition(command: DiscoveredAppCommand): CommandDefinition {
  return {
    name: command.name,
    aliases: command.aliases,
    description: command.description,
    usage: command.usage ?? `holo ${command.name}`,
    source: 'app',
    async run(context) {
      await (await command.load()).run(context)
    },
  }
}

function commandTokens(command: CommandDefinition): string[] {
  return [command.name, ...(command.aliases ?? [])]
}

function findCommandConflict(
  registry: readonly CommandDefinition[],
  candidate: CommandDefinition,
): { token: string, command: CommandDefinition } | undefined {
  for (const token of commandTokens(candidate)) {
    const conflict = registry.find(command => commandTokens(command).includes(token))
    if (conflict) {
      return {
        token,
        command: conflict,
      }
    }
  }

  return undefined
}

function findCommand(
  registry: readonly CommandDefinition[],
  name: string,
): CommandDefinition | undefined {
  return registry.find(command => command.name === name || command.aliases?.includes(name))
}

export async function runCli(argv: readonly string[], io: IoStreams): Promise<number> {
  try {
    const projectRoot = await findProjectRoot(io.cwd)
    let cachedProject: LoadedProjectConfig | undefined
    const loadProject = async () => {
      cachedProject ??= await loadProjectConfig(projectRoot)
      return cachedProject
    }

    const placeholderRegistry: CommandDefinition[] = []
    const internalContext: InternalCommandContext = {
      ...io,
      projectRoot,
      registry: placeholderRegistry,
      loadProject,
    }
    const internalCommands = createInternalCommands(internalContext)
    const registry = [...internalCommands]
    const requestedCommandName = argv[0]
    const canSkipAppDiscovery = requestedCommandName === 'config:cache'
      || requestedCommandName === 'config:clear'
      || requestedCommandName === 'install'
      || requestedCommandName === 'prepare'
      || requestedCommandName === 'dev'
      || requestedCommandName === 'build'
      || requestedCommandName === 'queue:table'
      || requestedCommandName === 'queue:failed-table'
      || requestedCommandName === 'queue:work'
      || requestedCommandName === 'queue:listen'
      || requestedCommandName === 'queue:failed'
      || requestedCommandName === 'queue:retry'
      || requestedCommandName === 'queue:forget'
      || requestedCommandName === 'queue:flush'
      || requestedCommandName === 'queue:restart'
      || requestedCommandName === 'queue:clear'

    if (!canSkipAppDiscovery) {
      const initialProject = await loadProject()
      const appCommands = (await discoverAppCommands(projectRoot, initialProject.config))
        .map(entry => createAppCommandDefinition(entry))

      for (const appCommand of appCommands) {
        const duplicate = findCommandConflict(registry, appCommand)
        if (duplicate) {
          throw new Error(
            `App command "${appCommand.name}" conflicts with ${duplicate.command.source} command `
            + `"${duplicate.command.name}" via "${duplicate.token}".`,
          )
        }

        registry.push(appCommand)
      }
    }

    placeholderRegistry.push(...registry)

    if (!requestedCommandName || requestedCommandName === 'help' || requestedCommandName === '--help' || requestedCommandName === '-h') {
      printCommandList(io, placeholderRegistry)
      return 0
    }

    const command = findCommand(placeholderRegistry, requestedCommandName)
    if (!command) {
      writeLine(io.stderr, `Unknown command "${requestedCommandName}".`)
      printCommandList(io, placeholderRegistry)
      return 1
    }

    const parsed = parseTokens(argv.slice(1))
    if (parsed.flags.help === true || parsed.flags.h === true) {
      printCommandHelp(io, command)
      return 0
    }

    const prepared = command.prepare
      ? await command.prepare(parsed, internalContext)
      : {
          args: parsed.args,
          flags: parsed.flags as Record<string, CommandFlagValue>,
        }

    const commandContext = createCommandContext(io, projectRoot, loadProject, prepared)
    await command.run(commandContext)
    return 0
  } catch (error) {
    writeLine(io.stderr, error instanceof Error ? error.message : String(error))
    return 1
  }
}

export const cliInternals = {
  cacheProjectConfig,
  createEnvRuntimeConfig,
  renderFailedJobsTableMigration,
  renderQueueTableMigration,
  mergeRuntimeDatabaseConfig,
  createAppCommandDefinition,
  createCommandContext,
  createInternalCommands,
  createRuntimeInvocation,
  buildQueueWorkArgs,
  collectQueueWatchRoots,
  dropAllTablesForFresh,
  collectMultiStringFlag,
  getRuntimeEnvironment,
  getQueueRuntimeEnvironment,
  inferRuntimeMigrationName,
  getRuntimeFailureMessage,
  normalizeRuntimeMigration,
  normalizeChoice,
  getRegistryMigrationSlug,
  hasRegisteredMigrationSlug,
  hasRegisteredCreateTableMigration,
  isIgnorableWatchError,
  isQueueListenRelevantPath,
  commandTokens,
  ensureAbsent,
  fileExists,
  hasProjectDependency,
  findCommandConflict,
  findCommand,
  isInteractive,
  nextMigrationTemplate,
  parseBooleanEnv,
  parseNumberFlag,
  parseTokens,
  printCommandHelp,
  printCommandList,
  normalizeOptionalPackages,
  promptChoice,
  promptOptionalPackages,
  resolveNewProjectInput,
  resolvePackageManagerDevCommand,
  resolvePackageManagerInstallCommand,
  resolvePackageManagerInstallInvocation,
  resolvePackageManagerCommand,
  resolveConfigModuleUrl,
  resolveBooleanFlag,
  resolveCliEntrypointPath,
  resolveRunnableCliEntrypoint,
  resolveModuleExport,
  resolveStringFlag,
  resolveQueueRestartSignalPath,
  runProjectDevServer,
  runProjectDependencyInstall,
  runProjectLifecycleScript,
  runProjectPrepare,
  runQueueClearCommand,
  runQueueFailedCommand,
  runQueueFailedTableCommand,
  runQueueFlushCommand,
  runQueueForgetCommand,
  runQueueListen,
  runQueueRestartCommand,
  runQueueRetryCommand,
  runQueueTableCommand,
  runQueueWorkCommand,
  runMakeFactory,
  runMakeJob,
  runMakeMigration,
  runMakeModel,
  runMakeObserver,
  runMakeSeeder,
  hasQueueRestartSignalSince,
  readQueueRestartSignal,
  resolveDatabaseQueueTables,
  splitCsv,
  writeQueueRestartSignal,
  runMakeEvent,
  runMakeListener,
}
