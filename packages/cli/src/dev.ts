import { spawnSync, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  readTextFile,
  ensureProjectConfig,
  syncManagedDriverDependencies,
  prepareProjectDiscovery,
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

export async function runProjectLifecycleScript(
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

export async function runProjectPrepare(projectRoot: string, io?: IoStreams): Promise<void> {
  const project = await ensureProjectConfig(projectRoot)
  await prepareProjectDiscovery(projectRoot, project.config)

  await runNuxtPrepare(projectRoot)
  await runSvelteKitSync(projectRoot)

  const updatedDependencies = await syncManagedDriverDependencies(projectRoot)
  if (updatedDependencies && io) {
    await runProjectDependencyInstall(io, projectRoot)
    await prepareProjectDiscovery(projectRoot, project.config)
    await runNuxtPrepare(projectRoot)
    await runSvelteKitSync(projectRoot)
  }
}

async function runNuxtPrepare(projectRoot: string): Promise<void> {
  const frameworkProjectPath = resolve(projectRoot, '.holo-js/framework/project.json')
  try {
    const content = await readFile(frameworkProjectPath, 'utf8')
    const manifest = JSON.parse(content) as { framework?: string }

    if (manifest.framework !== 'nuxt') {
      return
    }
  } catch {
    return
  }

  const { spawn } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    const child = spawn('nuxi', ['prepare'], {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    child.on('close', code => {
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`nuxi prepare exited with ${code}`))
      }
    })
    child.on('error', reject)
  })
}

async function runSvelteKitSync(projectRoot: string): Promise<void> {
  const frameworkProjectPath = resolve(projectRoot, '.holo-js/framework/project.json')
  try {
    const content = await readFile(frameworkProjectPath, 'utf8')
    const manifest = JSON.parse(content) as { framework?: string }

    if (manifest.framework !== 'sveltekit') {
      return
    }
  } catch {
    return
  }

  const { spawn } = await import('node:child_process')
  await new Promise((resolve, reject) => {
    const child = spawn('bun', ['x', 'svelte-kit', 'sync'], {
      cwd: projectRoot,
      stdio: 'inherit',
    })
    child.on('close', code => {
      if (code === 0) {
        resolve(undefined)
      } else {
        reject(new Error(`svelte-kit sync exited with ${code}`))
      }
    })
    child.on('error', reject)
  })
}

export function toPosixSlashes(value: string): string {
  return value.replaceAll('\\', '/')
}

export function isDiscoveryRelevantPath(
  filePath: string,
  project: LoadedProjectConfig,
): boolean {
  const normalized = toPosixSlashes(filePath)
  if (normalized === '.holo-js/generated' || normalized.startsWith('.holo-js/generated/')) {
    return false
  }

  const authorizationPoliciesPath = project.config.paths.authorizationPolicies || 'server/policies'
  const authorizationAbilitiesPath = project.config.paths.authorizationAbilities || 'server/abilities'
  const roots = [
    project.config.paths.models,
    project.config.paths.migrations,
    project.config.paths.seeders,
    project.config.paths.commands,
    project.config.paths.jobs,
    project.config.paths.events,
    project.config.paths.listeners,
    authorizationPoliciesPath,
    authorizationAbilitiesPath,
    'server/broadcast',
    'server/channels',
    'config',
  ]

  if (normalized === '.env' || normalized.startsWith('.env.')) {
    return true
  }

  return roots.some(root => normalized === root || normalized.startsWith(`${toPosixSlashes(root)}/`))
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
  const authorizationPoliciesPath = project.config.paths.authorizationPolicies || 'server/policies'
  const authorizationAbilitiesPath = project.config.paths.authorizationAbilities || 'server/abilities'
  const roots = [
    projectRoot,
    resolve(projectRoot, 'config'),
    resolve(projectRoot, project.config.paths.models),
    resolve(projectRoot, project.config.paths.migrations),
    resolve(projectRoot, project.config.paths.seeders),
    resolve(projectRoot, project.config.paths.commands),
    resolve(projectRoot, project.config.paths.jobs),
    resolve(projectRoot, project.config.paths.events),
    resolve(projectRoot, project.config.paths.listeners),
    resolve(projectRoot, authorizationPoliciesPath),
    resolve(projectRoot, authorizationAbilitiesPath),
    resolve(projectRoot, 'server/broadcast'),
    resolve(projectRoot, 'server/channels'),
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
