import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, posix, relative, resolve, win32 } from 'node:path'

function normalizeDirectory(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '')
}

function resolveConfiguredRoot(rootDir: string): string {
  return posix.isAbsolute(rootDir) || win32.isAbsolute(rootDir) ? rootDir : resolve(rootDir)
}

function symlinkTargetStaysInTree(linkPath: string, tree: string): boolean {
  if (!existsSync(linkPath)) return false
  const target = realpathSync.native(linkPath)
  return statSync(target).isDirectory() && normalizeDirectory(target).startsWith(`${normalizeDirectory(tree)}/`)
}

function symlinkError(tree: string, linkPath: string): Error {
  const displayPath = `server/realtime/${normalizeDirectory(relative(tree, linkPath))}`
  const replacement = existsSync(linkPath) && statSync(linkPath).isDirectory() ? 'folder' : 'file'
  return new Error(`${displayPath} is a symbolic link; Holo can't guarantee its server code stays out of the browser bundle. Replace it with a regular ${replacement}.`)
}

function assertTreeEntries(tree: string, directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (!symlinkTargetStaysInTree(path, tree)) throw symlinkError(tree, path)
    } else if (entry.isDirectory()) {
      assertTreeEntries(tree, path)
    }
  }
}

export function assertRealtimeDefinitionTree(rootDir: string): void {
  const configured = join(resolveConfiguredRoot(rootDir), 'server', 'realtime')
  if (!existsSync(configured)) return
  const tree = realpathSync.native(configured)
  assertTreeEntries(tree, tree)
}

export function resolveRealtimeDefinitionDirectories(rootDir: string): readonly string[] {
  const configuredRoot = resolveConfiguredRoot(rootDir)
  const configured = join(configuredRoot, 'server', 'realtime')
  assertRealtimeDefinitionTree(rootDir)
  const directories = new Set([`${normalizeDirectory(configuredRoot)}/server/realtime`])
  if (existsSync(configuredRoot)) {
    directories.add(`${normalizeDirectory(realpathSync.native(configuredRoot))}/server/realtime`)
  }
  if (existsSync(configured)) {
    directories.add(normalizeDirectory(realpathSync.native(configured)))
  }
  return [...directories]
}

export function isInRealtimeDefinitionDirectory(directories: readonly string[], id: string): boolean {
  const path = (id.split('?')[0] as string).replaceAll('\\', '/')
  return directories.some(directory => path.startsWith(`${directory}/`))
}
