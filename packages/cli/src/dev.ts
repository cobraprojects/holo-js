import { createFrameworkSession } from './framework-run'
import { createFrameworkRestart } from './framework-restart'
import { startDiscoveryWatch, PACKAGE_MANIFEST_DISCOVERY_PATHS } from './discovery-watch'
import { loadEnvironment } from '@holo-js/config'
import { spawnSync, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureProjectConfig } from './project'
import { runProjectPrepare } from './project-prepare'
import type {
  IoStreams,
  PackageManagerCommand,
  SpawnProcessLike,
  WatchFactory,
} from './cli-types'
import type { LoadedProjectConfig } from './types'
import type {
  HoloProjectPrepareChange,
} from '@holo-js/kernel'

export { hasProjectDependency } from './package-json'
export { resolveProjectPackageManager, resolvePackageManagerCommand, resolvePackageManagerInstallInvocation, runProjectDependencyInstall } from './package-manager'
export { runProjectPrepare, prepareProjectSchema } from './project-prepare'

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

async function resolveServerArguments(projectRoot: string, args: readonly string[]): Promise<readonly string[]> {
  if (args.some(arg => arg === '--port' || arg.startsWith('--port=') || arg === '-p')) {
    return args
  }

  const environment = await loadEnvironment({ cwd: projectRoot, processEnv: process.env })
  const port = environment.values.PORT
  if (!port) {
    return args
  }
  if (!/^\d+$/.test(port) || Number(port) > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.')
  }

  return [...args, '--port', port]
}

export async function runProjectStartServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  passthroughArgs: readonly string[] = [],
): Promise<void> {
  const session = createFrameworkSession(io, projectRoot, spawnProcess)
  try {
    const invocation = resolveFrameworkRunnerInvocation(projectRoot, 'start')
    const serverArgs = await resolveServerArguments(projectRoot, passthroughArgs)
    if (session.signal.aborted) return

    const result = await session.launch(invocation, serverArgs).completion
    if (result.kind === 'error') throw result.error
    if (session.signal.aborted) return
    if (result.code !== 0) {
      throw new Error(`Project production server failed with exit code ${result.code ?? 'unknown'}.`)
    }
  } finally {
    session.dispose()
  }
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

export async function runProjectDevServer(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
  createWatcher: WatchFactory = watch,
  prepare: (projectRoot: string, io?: IoStreams) => Promise<void> = runProjectPrepare,
  passthroughArgs: readonly string[] = [],
): Promise<void> {
  let project: LoadedProjectConfig
  let discoveryWatch: Awaited<ReturnType<typeof startDiscoveryWatch>> | undefined
  const hotPrepare = prepare === runProjectPrepare ? runProjectHotPrepare : prepare

  let restart: ReturnType<typeof createFrameworkRestart> | undefined
  const session = createFrameworkSession(io, projectRoot, spawnProcess, () => discoveryWatch?.close())
  try {
    project = await ensureProjectConfig(projectRoot)
    session.signal.throwIfAborted()
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
          signal: session.signal,
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
        await runProjectHotPrepare(projectRoot, io, changes, session.signal)
        return
      }

      await runProjectPrepare(projectRoot, io, {
        syncFramework: false,
        command: 'dev',
        reason: hasDependencyChange ? 'dependencies-changed' : 'configuration-changed',
        signal: session.signal,
      })
    }

    const prepareDiscovery = async (
      syncFramework = false,
      changes: readonly HoloProjectPrepareChange[] = [],
    ): Promise<readonly string[]> => {
      await runDiscoveryPreparation(syncFramework, changes)
      session.signal.throwIfAborted()
      project = await ensureProjectConfig(projectRoot)
      const nextServerArgs = await resolveServerArguments(projectRoot, passthroughArgs)
      session.signal.throwIfAborted()
      await discoveryWatch?.refresh(project)
      return nextServerArgs
    }

    const initialArgs = await prepareDiscovery(true)
    restart = createFrameworkRestart({
      session,
      initialArgs,
      invocation: resolveFrameworkRunnerInvocation(projectRoot, 'dev'),
      io,
      prepare: changes => prepareDiscovery(false, changes),
    })
    const frameworkRestart = restart

    discoveryWatch = await startDiscoveryWatch({
      projectRoot,
      project,
      signal: session.signal,
      createWatcher,
      observe: frameworkRestart.observe,
      writeWarning: message => io.stderr.write(message),
    })

    await frameworkRestart.run()
  } catch (error) {
    if (!session.signal.aborted) throw error
  } finally {
    if (restart) await restart.shutdown()
    else session.dispose()
    discoveryWatch?.close()
  }
}
