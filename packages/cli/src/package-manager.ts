import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readTextFile } from './project/runtime'
import type { IoStreams, PackageManagerCommand, SpawnProcessLike, SupportedScaffoldPackageManager } from './cli-types'

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

  let packageManager: string | undefined
  if (packageJson) {
    try {
      const parsed = JSON.parse(packageJson) as { packageManager?: unknown }
      packageManager = typeof parsed.packageManager === 'string' ? parsed.packageManager.split('@')[0] : undefined

    } catch {
      packageManager = undefined
    }
  }
  if (packageManager === 'bun' || packageManager === 'npm' || packageManager === 'pnpm' || packageManager === 'yarn') {
    return packageManager
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

export async function runProjectDependencyInstall(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn = spawn,
): Promise<void> {
  await installProjectDependencies(io, projectRoot, spawnProcess)
}

export async function installProjectDependencies(
  io: IoStreams,
  projectRoot: string,
  spawnProcess: typeof spawn,
  signal?: AbortSignal,
): Promise<void> {
  const invocation = await resolvePackageManagerInstallInvocation(projectRoot)
  const child = spawnProcess(invocation.command, [...invocation.args], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(signal ? { signal } : {}),
  }) as SpawnProcessLike
  let stdout = ''
  let stderr = ''

  child.stdout?.on('data', chunk => stdout += String(chunk))
  child.stderr?.on('data', chunk => stderr += String(chunk))

  const result = await new Promise<
    | { kind: 'close', code: number | null }
    | { kind: 'error', error: Error }
  >((resolvePromise) => {
    let processError: Error | undefined
    child.on('error', (error) => {
      processError = error
      if (!signal?.aborted) resolvePromise({ kind: 'error', error })
    })
    child.on('close', code => resolvePromise(processError ? { kind: 'error', error: processError } : { kind: 'close', code }))
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

