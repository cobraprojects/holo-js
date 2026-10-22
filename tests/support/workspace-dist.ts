import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isWorkspaceBuildCurrent, writeWorkspaceBuildMarker } from '../../scripts/workspace-build-fingerprint.mjs'

export type WorkspacePackage = { readonly name: string, readonly directory: string }

export type WorkspacePackageBuild = (name: string, workspaceRoot: string) => Promise<void>

export function isWorkspaceDistCurrent(directory: string, workspaceRoot: string): boolean {
  return isWorkspaceBuildCurrent(directory, workspaceRoot)
}

export function copyWorkspaceDist(workspaceDist: string, stagedDist: string): void {
  mkdirSync(stagedDist, { recursive: true })
  for (const entry of readdirSync(workspaceDist)) {
    const source = join(workspaceDist, entry)
    const target = join(stagedDist, entry)
    if (statSync(source).isDirectory()) copyWorkspaceDist(source, target)
    else copyFileSync(source, target)
  }
}

export async function rebuildStaleWorkspacePackages(
  workspaceRoot: string,
  packages: readonly WorkspacePackage[],
  build: WorkspacePackageBuild = buildWorkspacePackage,
): Promise<string[]> {
  const stale = packages.filter(({ directory }) => !isWorkspaceDistCurrent(directory, workspaceRoot))
  for (const { name, directory } of stale) {
    await build(name, workspaceRoot)
    writeWorkspaceBuildMarker(directory, workspaceRoot)
  }
  return stale.map(({ name }) => name)
}

export type WorkspaceBuildResult = { readonly status: number | null, readonly stdout: string, readonly stderr: string }

export function runWorkspaceBuild(
  filter: string,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WorkspaceBuildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', ['run', '--filter', filter, 'build'], {
      cwd: workspaceRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => stdout += String(chunk))
    child.stderr.on('data', chunk => stderr += String(chunk))
    child.once('error', reject)
    child.once('close', status => resolve({ status, stdout, stderr }))
  })
}

export async function buildWorkspacePackage(name: string, workspaceRoot: string): Promise<void> {
  const result = await runWorkspaceBuild(name, workspaceRoot)
  if (result.status !== 0) {
    throw new Error(`Building ${name} failed with exit code ${result.status}.\n${result.stderr || result.stdout}`)
  }
}
