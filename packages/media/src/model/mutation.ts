import { randomUUID } from 'node:crypto'
import { DB, type Entity, type ModelRecord, type TableDefinition } from '@holo-js/db'
import { Storage, type StorageContent } from '@holo-js/storage/runtime'
import type { NormalizedMediaCollectionDefinition } from '../definitions/collections'
import type { NormalizedMediaDefinition } from '../definitions/config'
import { getMediaPathGenerator, type MediaConversionExecutorSource } from '../registry'
import { dispatchQueuedMediaConversionsForModel } from '../queue'
import { generateStoredConversions, resolveQueuedConversionNames } from './conversions'
import { Media } from './Media'
import { MediaItem } from './item'

type MediaOwner<TEntity extends Entity<TableDefinition>> = TEntity & {
  getMedia(collectionName?: string): Promise<MediaItem[]>
}
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
  readonly afterCommit?: (result: TResult) => Promise<void>
  readonly committedMessage: string
}): Promise<TResult> {
  const mutation = new MediaMutation()
  return await DB.writeTransaction(async (transaction) => {
    transaction.afterRollback(() => mutation.compensate())
    if (options.afterRollback) transaction.afterRollback(options.afterRollback)
    const result = await options.operation(mutation)
    const afterCommit = options.afterCommit
    if (afterCommit) {
      transaction.afterCommit(async () => {
        try {
          await afterCommit(result)
        } catch (cause) {
          throw new Error(options.committedMessage, { cause })
        }
      })
    }
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
    afterCommit: async () => { await removeObsoleteFiles(items, []) },
  })
}

export async function attachMedia<
  TEntity extends Entity<TableDefinition>,
  TCollectionName extends string,
  TConversionName extends string,
>(options: {
  readonly owner: TEntity
  readonly collectionName: TCollectionName
  readonly collection: NormalizedMediaCollectionDefinition
  readonly definition: NormalizedMediaDefinition
  readonly source: Omit<MediaConversionExecutorSource, 'uuid'> & { readonly name: string }
  readonly disk: string
}): Promise<MediaItem<TCollectionName, TConversionName, TEntity>> {
  const { owner, collection, source, disk } = options
  const ownerDefinition = owner.getRepository().definition
  const ownerId = String(owner.get(ownerDefinition.primaryKey as never))
  const uuid = randomUUID()
  const conversionsDisk = collection.conversionsDisk ?? disk
  const path = getMediaPathGenerator().originalPath({ uuid, fileName: source.fileName, extension: source.extension, collection })
  const obsolete: MediaItem[] = []
  return await runMediaMutation({
    committedMessage: '[Holo Media] Attachment remains committed; post-commit cleanup or conversion dispatch failed.',
    afterRollback: () => { owner.forgetRelation('media') },
    operation: async (mutation) => {
      const existing = collection.singleFile
        ? await (owner as MediaOwner<TEntity>).getMedia(options.collectionName)
        : []
      await mutation.put(disk, path, source.contents)
      const generatedConversions = await generateStoredConversions({
        definition: options.definition,
        collection,
        conversionsDisk,
        source: { ...source, uuid },
        mutation,
      })
      const max = await Media.query()
        .where('model_type', ownerDefinition.morphClass)
        .where('model_id', ownerId)
        .where('collection_name', options.collectionName)
        .max('order_column')
      const media = await Media.create({
        uuid,
        model_type: ownerDefinition.morphClass,
        model_id: ownerId,
        collection_name: options.collectionName,
        name: source.name,
        file_name: source.fileName,
        disk,
        conversions_disk: conversionsDisk,
        mime_type: source.mimeType ?? null,
        extension: source.extension ?? null,
        size: source.size,
        path,
        generated_conversions: generatedConversions,
        order_column: (max ?? 0) + 1,
      } as Partial<ModelRecord<typeof Media.definition.table>>)
      for (const item of existing) await item.getEntity().delete()
      owner.forgetRelation('media')
      obsolete.push(...existing)
      if (typeof collection.onlyKeepLatest === 'number') {
        const items = await (owner as MediaOwner<TEntity>).getMedia(options.collectionName)
        const overflow = items.slice(0, Math.max(0, items.length - collection.onlyKeepLatest))
        for (const item of overflow) await item.getEntity().delete()
        obsolete.push(...overflow)
        owner.forgetRelation('media')
      }
      return new MediaItem<TCollectionName, TConversionName, TEntity>(media, owner)
    },
    afterCommit: async (item) => {
      const media = item.getEntity()
      const generatedConversions = item.record.generated_conversions
      const failures: unknown[] = []
      try {
        await removeObsoleteFiles(obsolete, [
          { disk, path },
          ...Object.values(generatedConversions).map(conversion => ({
            disk: conversion.disk ?? conversionsDisk,
            path: conversion.path,
          })),
        ])
      } catch (error) {
        failures.push(error)
      }
      try {
        await dispatchQueuedMediaConversionsForModel({
          mediaId: media.get('id'),
          conversionNames: resolveQueuedConversionNames({ definition: options.definition, collectionName: collection.name }),
        }, async () => { await media.refresh() })
      } catch (error) {
        failures.push(error)
      }
      owner.forgetRelation('media')
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, '[Holo Media] Post-commit effects failed.')
    },
  })
}
