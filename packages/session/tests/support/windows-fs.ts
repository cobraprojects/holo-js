import type * as FsPromises from 'node:fs/promises'

export type WindowsFsState = {
  readonly blockedRenameSources: Set<string>
  readonly renameAttempts: Map<string, number>
}

export function createWindowsFsState(): WindowsFsState {
  return { blockedRenameSources: new Set(), renameAttempts: new Map() }
}

function permissionDenied(operation: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`EPERM: operation not permitted, ${operation}`), { code: 'EPERM' })
}

export function windowsFsOverrides(actual: typeof FsPromises, state: WindowsFsState): Partial<typeof FsPromises> {
  return {
    rename: async (source, target) => {
      const sourcePath = String(source)
      state.renameAttempts.set(sourcePath, (state.renameAttempts.get(sourcePath) ?? 0) + 1)
      if (state.blockedRenameSources.has(sourcePath)) throw permissionDenied('rename')
      if (await actual.stat(target).then(value => value.isDirectory(), () => false)) throw permissionDenied('rename')
      return await actual.rename(source, target)
    },
  }
}
