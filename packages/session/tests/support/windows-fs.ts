import type * as FsPromises from 'node:fs/promises'
import { createWindowsFsModel } from './windows-fs-model.mjs'

export type WindowsFsState = {
  readonly blockedRenamePrefixes: Set<string>
  readonly blockedRenameSources: Set<string>
  readonly blockedUnlinkPrefixes: Set<string>
  readonly blockedWritePrefixes: Set<string>
  readonly ioErrorOpenPrefixes: Set<string>
  readonly ioErrorRenamePrefixes: Set<string>
  readonly ioErrorUnlinkPrefixes: Set<string>
  readonly renameAttempts: Map<string, number>
  readonly writeAttempts?: Map<string, number>
  readonly pausedRenameSources?: Map<string, Promise<void>>
}

function permissionDenied(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

function ioError(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EIO: i/o error, ${operation}`), { code: 'EIO' })
}

function startsWithAny(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) if (path.startsWith(prefix)) return true
  return false
}

export function windowsFsOverrides(actual: typeof FsPromises, state: WindowsFsState): Partial<typeof FsPromises> {
  const model = createWindowsFsModel(actual)
  return {
    rmdir: model.rmdir,
    open: async (...args) => {
      if (startsWithAny(String(args[0]), state.ioErrorOpenPrefixes)) throw ioError('open')
      return await actual.open(...args)
    },
    unlink: async (path, ...rest) => {
      if (startsWithAny(String(path), state.ioErrorUnlinkPrefixes)) throw ioError('unlink')
      if (startsWithAny(String(path), state.blockedUnlinkPrefixes)) throw permissionDenied('unlink')
      return await model.unlink(path, ...rest)
    },
    writeFile: async (path, data, options) => {
      const targetPath = String(path)
      if (state.writeAttempts) state.writeAttempts.set(targetPath, (state.writeAttempts.get(targetPath) ?? 0) + 1)
      if (startsWithAny(targetPath, state.blockedWritePrefixes)) throw permissionDenied('write')
      return await actual.writeFile(path, data, options)
    },
    rename: async (source, target) => {
      const sourcePath = String(source)
      await state.pausedRenameSources?.get(sourcePath)
      state.renameAttempts.set(sourcePath, (state.renameAttempts.get(sourcePath) ?? 0) + 1)
      if (startsWithAny(sourcePath, state.ioErrorRenamePrefixes)) throw ioError('rename')
      if (state.blockedRenameSources.has(sourcePath) || startsWithAny(sourcePath, state.blockedRenamePrefixes)) throw permissionDenied('rename')
      return await model.rename(source, target)
    },
  }
}
