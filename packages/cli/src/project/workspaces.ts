import { readdir } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { minimatch } from 'minimatch'
import { parse } from 'yaml'
import { readTextFile } from './runtime'

function workspacePatterns(value: unknown): readonly string[] {
  let patterns: unknown
  if (Array.isArray(value)) {
    patterns = value
  } else if (value && typeof value === 'object') {
    patterns = Reflect.get(value, 'packages')
  }
  if (!Array.isArray(patterns)) return []
  return patterns.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim().length > 0)
}

function workspacePatternMatches(pattern: string, path: string): boolean {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/$/u, '')
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) return false
  return minimatch(path, normalized, { dot: true, nonegate: true })
}

function belongsToWorkspace(path: string, patterns: readonly string[]): boolean {
  const included = patterns.filter(pattern => !pattern.startsWith('!')).some(pattern => workspacePatternMatches(pattern, path))
  const excluded = patterns.filter(pattern => pattern.startsWith('!')).some(pattern => workspacePatternMatches(pattern.slice(1), path))
  return included && !excluded
}

async function readPackageManifest(path: string): Promise<Record<string, unknown> | undefined> {
  const source = await readTextFile(resolve(path, 'package.json'))
  if (!source) return undefined
  try {
    return JSON.parse(source) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function readPnpmWorkspacePatterns(path: string): Promise<readonly string[]> {
  const source = await readTextFile(resolve(path, 'pnpm-workspace.yaml'))
  if (!source) return []
  try {
    const manifest: unknown = parse(source)
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return []
    return workspacePatterns(Reflect.get(manifest, 'packages'))
  } catch {
    return []
  }
}

async function findWorkspaceRoot(projectRoot: string): Promise<Readonly<{ patterns: readonly string[], root: string }> | undefined> {
  const resolvedProjectRoot = resolve(projectRoot)
  let current = resolvedProjectRoot
  while (true) {
    const manifest = await readPackageManifest(current)
    const pnpmPatterns = await readPnpmWorkspacePatterns(current)
    const patterns = pnpmPatterns.length > 0 ? pnpmPatterns : workspacePatterns(manifest?.workspaces)
    const projectPath = relative(current, resolvedProjectRoot).split(sep).join('/')
    if (patterns.length > 0 && (projectPath === '' || belongsToWorkspace(projectPath, patterns))) return { patterns, root: current }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export async function resolveWorkspacePackageNames(projectRoot: string): Promise<ReadonlySet<string>> {
  const workspace = await findWorkspaceRoot(projectRoot)
  if (!workspace) return new Set()
  const packageNames = new Set<string>()
  const excludedDirectories = new Set(['.git', '.holo-js', '.next', '.nuxt', '.svelte-kit', 'build', 'dist', 'node_modules'])
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || excludedDirectories.has(entry.name)) continue
      const child = resolve(directory, entry.name)
      const workspacePath = relative(workspace.root, child).split(sep).join('/')
      if (belongsToWorkspace(workspacePath, workspace.patterns)) {
        const manifest = await readPackageManifest(child)
        if (typeof manifest?.name === 'string' && manifest.name.trim()) {
          packageNames.add(manifest.name)
          continue
        }
      }
      await visit(child)
    }
  }
  await visit(workspace.root)
  return packageNames
}
