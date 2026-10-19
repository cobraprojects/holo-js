import type * as FsPromises from 'node:fs/promises'

export type WindowsFsModelOptions = {
  readonly enabled?: boolean
  readonly freshFileMs?: number
  readonly failRate?: number
}

export type WindowsFsModel = {
  readonly unlink: typeof FsPromises.unlink
  readonly rmdir: typeof FsPromises.rmdir
  readonly rename: typeof FsPromises.rename
}

export function createWindowsFsModel(actual: typeof FsPromises, options?: WindowsFsModelOptions): WindowsFsModel
