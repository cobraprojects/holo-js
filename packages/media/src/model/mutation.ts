import { DB, type Entity, type TableDefinition } from '@holo-js/db'
import { Storage, type StorageContent } from '@holo-js/storage/runtime'
import type { MediaItem } from './item'
type StoredFile = { readonly disk: string, readonly path: string }

export class MediaMutation {
  private readonly created: StoredFile[] = []

  async put(disk: string, path: string, contents: StorageContent): Promise<void> {
    this.created.push({ disk, path })
    await Storage.disk(disk).put(path, contents)
  }

  async overwrite(disk: string, path: string, contents: StorageContent): Promise<void> {
    await Storage.disk(disk).put(path, contents)
  }

  async compensate(): Promise<void> {
    const failures: unknown[] = []
    for (const file of this.created.splice(0).reverse()) {
      try {
        await Storage.disk(file.disk).delete(file.path)
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, '[Holo Media] File compensation failed.')
  }
}

async function compensateAfterFailure(mutation: MediaMutation, error: unknown): Promise<unknown> {
  try {
    await mutation.compensate()
  } catch (cleanupError) {
    return new AggregateError([error, cleanupError], '[Holo Media] File compensation failed.')
  }

  return error
}

export async function runMediaMutation<TResult, TWritten = undefined>(options: {
  readonly write: (mutation: MediaMutation) => Promise<TWritten>
  readonly operation: (mutation: MediaMutation, written: TWritten) => Promise<TResult>
  readonly afterRollback?: () => Promise<void> | void
  readonly afterCommit?: readonly ((result: TResult) => Promise<void>)[]
  readonly afterEffects?: () => void
  readonly committedMessage: string
}): Promise<TResult> {
  const mutation = new MediaMutation()
  let written: TWritten
  try {
    written = await options.write(mutation)
  } catch (error) {
    throw await compensateAfterFailure(mutation, error)
  }

  let transactionStarted = false
  try {
    return await DB.writeTransaction(async (transaction) => {
      transactionStarted = true
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
      const result = await options.operation(mutation, written)
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
  } catch (error) {
    if (transactionStarted) throw error
    throw await compensateAfterFailure(mutation, error)
  }
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
    write: async () => undefined,
    operation: async () => {
      for (const item of items) await item.getEntity().delete()
      owner?.forgetRelation('media')
    },
    afterRollback: () => { owner?.forgetRelation('media') },
    afterCommit: [async () => { await removeObsoleteFiles(items, []) }],
  })
}
