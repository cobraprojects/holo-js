import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadConfigDirectory } from '@holo-js/config'
import {
  configureDB,
  resetDB,
  resolveRuntimeConnectionManagerOptions,
} from '@holo-js/db'
import {
  bundleProjectModule,
  ensureProjectConfig,
  loadProjectConfig,
  loadGeneratedProjectRegistry,
  prepareProjectDiscovery,
  resolveProjectPackageImportSpecifier,
  HOLO_RUNTIME_ROOT,
} from './project'
import {
  toPosixSlashes,
  isRecursiveWatchUnsupported,
  isIgnorableWatchError,
  normalizeWatchedFilePath,
  runProjectPrepare,
} from './dev'
import { writeLine } from './io'
import { initializeProjectRuntime } from './runtime'
import type {
  IoStreams,
  QueueCliModule,
  QueueRuntimeEnvironment,
  QueueMaintenanceEnvironment,
  SpawnProcessLike,
  WatchFactory,
  WatchHandle,
} from './cli-types'
import type { LoadedProjectConfig, CommandFlagValue } from './types'
import type { HoloRuntime } from '@holo-js/core'
import type { QueueWorkerRunOptions } from '@holo-js/queue'

export const QUEUE_LISTEN_SOURCE_EXTENSIONS = new Set([
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

export const QUEUE_LISTEN_IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  'coverage',
  'dist',
  'node_modules',
])

export const QUEUE_LISTEN_IGNORED_PATH_PREFIXES = [
  HOLO_RUNTIME_ROOT,
].map(toPosixSlashes)

export async function loadQueueCliModule(projectRoot: string): Promise<QueueCliModule> {
  return await import(resolveProjectPackageImportSpecifier(projectRoot, '@holo-js/queue')) as QueueCliModule
}

export function isIgnoredQueueListenPath(filePath: string): boolean {
  const normalized = toPosixSlashes(filePath)
  if (QUEUE_LISTEN_IGNORED_PATH_PREFIXES.some(prefix => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    return true
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .some(segment => QUEUE_LISTEN_IGNORED_DIRECTORY_NAMES.has(segment))
}

export async function collectQueueWatchTree(
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

export function isQueueListenRelevantPath(
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

export async function collectQueueWatchRoots(
  projectRoot: string,
  project: LoadedProjectConfig,
): Promise<string[]> {
  const directories = new Set<string>()
  await collectQueueWatchTree(projectRoot, directories, projectRoot, project)

  return [...directories]
}

export function resolveCliEntrypointPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const builtEntry = resolve(currentDir, 'bin', 'holo.mjs')
  if (existsSync(builtEntry)) {
    return builtEntry
  }

  return resolve(currentDir, 'bin', 'holo.ts')
}

export async function resolveRunnableCliEntrypoint(): Promise<{ path: string, cleanup(): Promise<void> }> {
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

export function isModuleRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function resolveModuleExport<TValue>(
  moduleValue: unknown,
  matcher: (value: unknown) => value is TValue,
): TValue | undefined {
  if (!isModuleRecord(moduleValue)) return undefined

  if (matcher(moduleValue.default)) return moduleValue.default

  for (const value of Object.values(moduleValue)) {
    if (matcher(value)) return value
  }

  return undefined
}

export function buildQueueWorkArgs(flags: Readonly<Record<string, CommandFlagValue>>): string[] {
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

export function resolveQueueRestartSignalPath(projectRoot: string): string {
  return resolve(projectRoot, '.holo-js', 'runtime', 'queue-restart.signal')
}

export async function readQueueRestartSignal(projectRoot: string): Promise<number | undefined> {
  const contents = await readFile(resolveQueueRestartSignalPath(projectRoot), 'utf8').catch(() => undefined)
  if (!contents) {
    return undefined
  }

  const parsed = Number.parseInt(contents.trim(), 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

export async function writeQueueRestartSignal(projectRoot: string, timestamp = Date.now()): Promise<string> {
  const signalPath = resolveQueueRestartSignalPath(projectRoot)
  await mkdir(dirname(signalPath), { recursive: true })
  await writeFile(signalPath, `${timestamp}\n`, 'utf8')
  return signalPath
}

export async function hasQueueRestartSignalSince(projectRoot: string, since: number): Promise<boolean> {
  const signal = await readQueueRestartSignal(projectRoot)
  return typeof signal === 'number' && signal > since
}

export async function getQueueRuntimeEnvironment(projectRoot: string): Promise<QueueRuntimeEnvironment> {
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

export async function runQueueWorkCommand(
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

export async function initializeQueueMaintenanceEnvironment(
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

export async function runQueueClearCommand(
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

export async function runQueueRestartCommand(
  io: IoStreams,
  projectRoot: string,
): Promise<void> {
  const signalPath = await writeQueueRestartSignal(projectRoot)
  writeLine(io.stdout, `[queue] Restart signal written: ${signalPath}`)
}

export async function runQueueListen(
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

export async function runQueueFailedCommand(
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

export async function runQueueRetryCommand(
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

export async function runQueueForgetCommand(
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

export async function runQueueFlushCommand(
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
