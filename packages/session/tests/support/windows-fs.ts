import type * as FsPromises from 'node:fs/promises'
import { createWindowsFsModel } from './windows-fs-model.mjs'

export type WindowsFsState = {
  readonly blockedRenameSources: Set<string>
  readonly blockedUnlinkPrefixes: Set<string>
  readonly blockedWritePrefixes: Set<string>
  readonly renameAttempts: Map<string, number>
}

function permissionDenied(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

function startsWithAny(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) if (path.startsWith(prefix)) return true
  return false
}

export function windowsFsOverrides(actual: typeof FsPromises, state: WindowsFsState): Partial<typeof FsPromises> {
  const model = createWindowsFsModel(actual)
  return {
    rmdir: model.rmdir,
    unlink: async (path, ...rest) => {
      if (startsWithAny(String(path), state.blockedUnlinkPrefixes)) throw permissionDenied('unlink')
      return await model.unlink(path, ...rest)
    },
    writeFile: async (path, data, options) => {
      if (startsWithAny(String(path), state.blockedWritePrefixes)) throw permissionDenied('write')
      return await actual.writeFile(path, data, options)
    },
    rename: async (source, target) => {
      const sourcePath = String(source)
      state.renameAttempts.set(sourcePath, (state.renameAttempts.get(sourcePath) ?? 0) + 1)
      if (state.blockedRenameSources.has(sourcePath)) throw permissionDenied('rename')
      return await model.rename(source, target)
    },
  }
}
