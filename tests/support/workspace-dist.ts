import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isWorkspaceBuildCurrent, writeWorkspaceBuildMarker } from '../../scripts/workspace-build-fingerprint.mjs'

export type WorkspacePackage = { readonly name: string, readonly directory: string }

export type WorkspacePackageBuild = (name: string, workspaceRoot: string) => Promise<void>

/**
 * A dist is current when its marker matches the content fingerprint of the package and every manifest entry point
 * exists. Modification times are not consulted, so a touch alone does not invalidate a build.
 */
export function isWorkspaceDistCurrent(directory: string): boolean {
  return isWorkspaceBuildCurrent(directory)
}

/**
 * Copies a workspace dist into a staged package as real files. A link would make the staged package's dependencies
 * resolve from the workspace's real path, which can hide a dependency the staged package does not declare.
 */
export function copyWorkspaceDist(workspaceDist: string, stagedDist: string): void {
  // cpSync's dereference option leaves file symlinks as links on some Node versions, so copy each entry explicitly.
  // statSync and copyFileSync both follow links, so the staged package gets real files.
  mkdirSync(stagedDist, { recursive: true })
  for (const entry of readdirSync(workspaceDist)) {
    const source = join(workspaceDist, entry)
    const target = join(stagedDist, entry)
    if (statSync(source).isDirectory()) copyWorkspaceDist(source, target)
    else copyFileSync(source, target)
  }
}

/**
 * Rebuilds, one at a time, only the packages whose build is missing or stale. The builds are asynchronous so the
 * test process keeps its event loop free while they run. A marker is written only after a build succeeds.
 */
export async function rebuildStaleWorkspacePackages(
  workspaceRoot: string,
  packages: readonly WorkspacePackage[],
  build: WorkspacePackageBuild = buildWorkspacePackage,
): Promise<string[]> {
  const stale = packages.filter(({ directory }) => !isWorkspaceDistCurrent(directory))
  for (const { name, directory } of stale) {
    await build(name, workspaceRoot)
    writeWorkspaceBuildMarker(directory)
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

async function buildWorkspacePackage(name: string, workspaceRoot: string): Promise<void> {
  const result = await runWorkspaceBuild(name, workspaceRoot)
  if (result.status !== 0) {
    throw new Error(`Building ${name} failed with exit code ${result.status}.\n${result.stderr || result.stdout}`)
  }
}
