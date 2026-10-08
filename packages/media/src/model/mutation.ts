import { DB, type Entity, type TableDefinition } from '@holo-js/db'
import { Storage, type StorageContent } from '@holo-js/storage/runtime'
import type { MediaItem } from './item'
type StoredFile = { readonly disk: string, readonly path: string }
type WrittenFile = StoredFile & { readonly previous: Uint8Array | null }

export class MediaMutation {
  private readonly written: WrittenFile[] = []

  async put(disk: string, path: string, contents: StorageContent): Promise<void> {
    const previous = await Storage.disk(disk).getBytes(path)
    this.written.push({ disk, path, previous })
    await Storage.disk(disk).put(path, contents)
  }

  async compensate(): Promise<void> {
    const failures: unknown[] = []
    for (const file of this.written.splice(0).reverse()) {
      try {
        if (file.previous) {
          await Storage.disk(file.disk).put(file.path, file.previous)
        } else {
          await Storage.disk(file.disk).delete(file.path)
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, '[Holo Media] File compensation failed.')
  }
}

export async function runMediaMutation<TResult>(options: {
  readonly operation: (mutation: MediaMutation) => Promise<TResult>
  readonly afterRollback?: () => Promise<void> | void
  readonly afterCommit?: readonly ((result: TResult) => Promise<void>)[]
  readonly afterEffects?: () => void
  readonly committedMessage: string
}): Promise<TResult> {
  const mutation = new MediaMutation()
  return await DB.writeTransaction(async (transaction) => {
    transaction.afterRollback(async () => {
      const failures: unknown[] = []
      try {
        await mutation.compensate()
      } catch (error) {
        failures.push(error)
      }
      try {
        await options.afterRollback?.()
      } catch (error) {
        failures.push(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, '[Holo Media] Rollback restoration failed.')
    })
    const result = await options.operation(mutation)
    transaction.afterCommit(async () => {
      const failures: unknown[] = []
      for (const effect of options.afterCommit ?? []) {
        try {
          await effect(result)
        } catch (error) {
          failures.push(error)
        }
      }
      options.afterEffects?.()
      if (failures.length === 0) return
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, '[Holo Media] Post-commit effects failed.')
      throw new Error(options.committedMessage, { cause })
    })
    return result
  })
}

export async function removeStoredFiles(files: readonly StoredFile[], retained: readonly StoredFile[] = []): Promise<void> {
  const failures: unknown[] = []
  for (const file of files) {
    if (retained.some(current => current.disk === file.disk && current.path === file.path)) continue
    try {
      await Storage.disk(file.disk).delete(file.path)
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, '[Holo Media] Obsolete-file cleanup failed.')
}

export async function removeObsoleteFiles(items: readonly MediaItem[], retained: readonly StoredFile[]): Promise<void> {
  await removeStoredFiles(items.flatMap(({ record }) => [
    { disk: record.disk, path: record.path },
    ...Object.values(record.generated_conversions ?? {}).filter(conversion => conversion?.path).map(conversion => ({
      disk: conversion.disk ?? record.conversions_disk ?? record.disk,
      path: conversion.path,
    })),
  ]), retained)
}

export async function deleteMediaItems(items: readonly MediaItem[], owner?: Entity<TableDefinition>): Promise<void> {
  if (items.length === 0) return
  await runMediaMutation({
    committedMessage: '[Holo Media] Deletion remains committed; post-commit file cleanup failed.',
    operation: async () => {
      for (const item of items) await item.getEntity().delete()
      owner?.forgetRelation('media')
    },
    afterRollback: () => { owner?.forgetRelation('media') },
    afterCommit: [async () => { await removeObsoleteFiles(items, []) }],
  })
}
