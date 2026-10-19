import type * as FsPromises from 'node:fs/promises'
import { createWindowsFsModel } from './windows-fs-model.mjs'

export type WindowsFsState = {
  readonly blockedRenameSources: Set<string>
  readonly renameAttempts: Map<string, number>
}

function permissionDenied(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

export function windowsFsOverrides(actual: typeof FsPromises, state: WindowsFsState): Partial<typeof FsPromises> {
  const model = createWindowsFsModel(actual)
  return {
    unlink: model.unlink,
    rmdir: model.rmdir,
    rename: async (source, target) => {
      const sourcePath = String(source)
      state.renameAttempts.set(sourcePath, (state.renameAttempts.get(sourcePath) ?? 0) + 1)
      if (state.blockedRenameSources.has(sourcePath)) throw permissionDenied('rename')
      return await model.rename(source, target)
    },
  }
}
