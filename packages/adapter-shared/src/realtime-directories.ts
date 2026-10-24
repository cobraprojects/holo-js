import { existsSync, realpathSync } from 'node:fs'
import { join, posix, resolve, win32 } from 'node:path'

function normalizeDirectory(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '')
}

export function resolveRealtimeDefinitionDirectories(rootDir: string): readonly string[] {
  const configuredRoot = posix.isAbsolute(rootDir) || win32.isAbsolute(rootDir) ? rootDir : resolve(rootDir)
  const configured = join(configuredRoot, 'server', 'realtime')
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
