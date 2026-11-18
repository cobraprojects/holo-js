import { isAbsolute, relative, resolve, sep } from 'node:path'

export function toPosixSlashes(value: string): string {
  return value.replaceAll('\\', '/')
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

export function isVanishedEntryUnderWatchRoot(error: unknown, watchRoot: string): boolean {
  const path = error instanceof Error && 'code' in error && error.code === 'ENOENT' && 'path' in error ? error.path : undefined
  if (typeof path !== 'string') return false
  const entry = relative(resolve(watchRoot), resolve(path))
  return entry !== '' && entry !== '..' && !entry.startsWith(`..${sep}`) && !isAbsolute(entry)
}

export function normalizeWatchedFilePath(
  projectRoot: string,
  watchedRoot: string,
  fileName: string,
): string {
  return toPosixSlashes(relative(projectRoot, resolve(watchedRoot, fileName)))
}

