import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Storage } from '@holo-js/storage/runtime'
import {
  getMediaPathGenerator,
  requireMediaDefinition,
  resolveMediaCollection,
} from '../registry'
import { dispatchQueuedMediaConversionsForModel } from '../queue'
import {
  getContentSize,
  getDisplayName,
  getExtension,
  inferMimeType,
  sanitizeFileName,
  toBinaryContent,
  type BinaryContent,
} from '../runtime/binary'
import { generateStoredConversions, resolveQueuedConversionNames } from './conversions'
import { Media } from './Media'
import { MediaItem } from './item'
import type {
  Entity,
  ModelRecord,
  TableDefinition,
} from '@holo-js/db'
import type { GeneratedMediaConversions } from './Media'

type MediaTable = typeof Media.definition.table
type MediaRecord = ModelRecord<MediaTable>
type MediaCapableEntity = Entity<TableDefinition> & {
  getMedia(collectionName?: string): Promise<MediaItem[]>
}

export type MediaSourceInput
  = | string
    | BinaryContent
    | { readonly path: string }
    | {
      readonly url: string
      readonly fileName?: string
      readonly mimeType?: string
      readonly name?: string
    }
    | {
      readonly contents: BinaryContent
      readonly fileName?: string
      readonly mimeType?: string
      readonly name?: string
    }

type ResolvedMediaSource = {
  readonly contents: BinaryContent
  readonly fileName: string
  readonly mimeType?: string
  readonly extension?: string
  readonly size: number
  readonly name: string
}

type StoredMediaFileSnapshot = {
  readonly disk: string
  readonly path: string
  readonly contents: Uint8Array
}

type DeletedMediaSnapshot = {
  readonly record: Pick<
    MediaRecord,
    | 'uuid'
    | 'model_type'
    | 'model_id'
    | 'collection_name'
    | 'name'
    | 'file_name'
    | 'disk'
    | 'conversions_disk'
    | 'mime_type'
    | 'extension'
    | 'size'
    | 'path'
    | 'generated_conversions'
    | 'order_column'
  >
  readonly files: readonly StoredMediaFileSnapshot[]
}

function resolveImplicitDiskName(): string {
  const defaultDisk = Storage.disk()
  if (defaultDisk.visibility === 'public') {
    return defaultDisk.name
  }

  try {
    const publicDisk = Storage.disk('public')
    if (publicDisk.visibility === 'public') {
      return publicDisk.name
    }
  } catch {
    // Fall back to the configured default disk when no public disk is available.
  }

  return defaultDisk.name
}

function parseRemoteFileName(url: string): string {
  try {
    const parsedUrl = new URL(url)
    return basename(parsedUrl.pathname) || 'media.bin'
  } catch {
    return 'media.bin'
  }
}

function createMaxSizeError(fileName: string, collectionName?: string): Error {
  return new Error(
    `[Holo Media] File "${fileName}" exceeds the max size for collection "${collectionName}".`,
  )
}

async function readRemoteMediaContents(
  response: Response,
  fileName: string,
  maxSize?: number,
  collectionName?: string,
): Promise<Uint8Array> {
  if (typeof maxSize !== 'number' || !response.body) {
    return new Uint8Array(await response.arrayBuffer())
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalSize = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      if (!value) {
        continue
      }

      totalSize += value.byteLength
      if (totalSize > maxSize) {
        await reader.cancel().catch(() => undefined)
        throw createMaxSizeError(fileName, collectionName)
      }

      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const contents = new Uint8Array(totalSize)
  let offset = 0
  for (const chunk of chunks) {
    contents.set(chunk, offset)
    offset += chunk.byteLength
  }

  return contents
}

async function resolveMediaSource(
  input: MediaSourceInput,
  overrideFileName?: string,
  overrideName?: string,
  options?: {
    readonly maxSize?: number
    readonly collectionName: string
  },
): Promise<ResolvedMediaSource> {
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    return resolveRemoteMediaSource(
      { url: input },
      overrideFileName,
      overrideName,
      options?.maxSize,
      options?.collectionName,
    )
  }

  if (typeof input !== 'string' && isUrlInput(input)) {
    return resolveRemoteMediaSource(
      input,
      overrideFileName,
      overrideName,
      options?.maxSize,
      options?.collectionName,
    )
  }

  if (typeof input === 'string' || isPathInput(input)) {
    const path = typeof input === 'string' ? input : input.path
    const contents = await readFile(path)
    const fileName = sanitizeFileName(overrideFileName ?? basename(path))
    return {
      contents,
      fileName,
      mimeType: inferMimeType(fileName),
      extension: getExtension(fileName),
      size: contents.byteLength,
      name: getDisplayName(fileName, overrideName),
    }
  }

  if ('contents' in input) {
    const contents = await toBinaryContent(input.contents)
    const fileName = sanitizeFileName(overrideFileName ?? input.fileName ?? 'media.bin')
    return {
      contents,
      fileName,
      mimeType: inferMimeType(fileName, input.mimeType),
      extension: getExtension(fileName),
      size: getContentSize(contents),
      name: getDisplayName(fileName, overrideName ?? input.name),
    }
  }

  const contents = await toBinaryContent(input)
  const fileName = sanitizeFileName(overrideFileName ?? 'media.bin')

  return {
    contents,
    fileName,
    mimeType: inferMimeType(fileName),
    extension: getExtension(fileName),
    size: getContentSize(contents),
    name: getDisplayName(fileName, overrideName),
  }
}

function isPathInput(
  input: Exclude<MediaSourceInput, string>,
): input is { readonly path: string } {
  return typeof input === 'object' && input !== null && 'path' in input
}

function isUrlInput(
  input: Exclude<MediaSourceInput, string>,
): input is {
  readonly url: string
  readonly fileName?: string
  readonly mimeType?: string
  readonly name?: string
} {
  return typeof input === 'object' && input !== null && 'url' in input
}

async function resolveRemoteMediaSource(
  input: {
    readonly url: string
    readonly fileName?: string
    readonly mimeType?: string
    readonly name?: string
  },
  overrideFileName?: string,
  overrideName?: string,
  maxSize?: number,
  collectionName?: string,
): Promise<ResolvedMediaSource> {
  const response = await fetch(input.url)
  if (!response.ok) {
    throw new Error(
      `[Holo Media] Failed to download media from "${input.url}" (${response.status} ${response.statusText}).`,
    )
  }

  const fileName = sanitizeFileName(
    overrideFileName ?? input.fileName ?? parseRemoteFileName(input.url),
  )
  const responseMimeType = response.headers.get('content-type')?.split(';')[0]
  const contentLengthHeader = response.headers.get('content-length')
  const contentLength = contentLengthHeader?.trim()
    ? Number(contentLengthHeader)
    : Number.NaN

  if (typeof maxSize === 'number' && Number.isFinite(contentLength) && contentLength > maxSize) {
    throw createMaxSizeError(fileName, collectionName)
  }

  const contents = await readRemoteMediaContents(
    response,
    fileName,
    maxSize,
    collectionName,
  )

  return {
    contents,
    fileName,
    mimeType: inferMimeType(fileName, input.mimeType ?? responseMimeType ?? undefined),
    extension: getExtension(fileName),
    size: contents.byteLength,
    name: getDisplayName(fileName, overrideName ?? input.name),
  }
}

function validateSource(
  collection: ReturnType<typeof resolveMediaCollection>,
  source: ResolvedMediaSource,
): void {
  if (typeof collection.maxSize === 'number' && source.size > collection.maxSize) {
    throw new Error(
      `[Holo Media] File "${source.fileName}" exceeds the max size for collection "${collection.name}".`,
    )
  }

  if (collection.acceptedMimeTypes.length > 0) {
    const mimeType = source.mimeType?.trim().toLowerCase()

    if (!mimeType || !collection.acceptedMimeTypes.includes(mimeType)) {
      throw new Error(
        `[Holo Media] File "${source.fileName}" is not an accepted MIME type for collection "${collection.name}".`,
      )
    }
  }

  if (collection.acceptedExtensions.length > 0) {
    if (!source.extension || !collection.acceptedExtensions.includes(source.extension)) {
      throw new Error(
        `[Holo Media] File "${source.fileName}" is not an accepted extension for collection "${collection.name}".`,
      )
    }
  }
}

async function resolveNextOrderColumn(
  modelType: string,
  modelId: string,
  collectionName: string,
): Promise<number> {
  const max = await Media.query()
    .where('model_type', modelType)
    .where('model_id', modelId)
    .where('collection_name', collectionName)
    .max('order_column')

  return (max ?? 0) + 1
}

async function deleteMediaItemsWithRollback(
  items: readonly MediaItem[],
): Promise<void> {
  const deletedSnapshots: DeletedMediaSnapshot[] = []

  try {
    for (const item of items) {
      const snapshot = await snapshotDeletedMediaItem(item)
      await item.delete()
      deletedSnapshots.push(snapshot)
    }
  } catch (error) {
    for (const snapshot of deletedSnapshots.reverse()) {
      await restoreDeletedMediaSnapshot(snapshot).catch(() => undefined)
    }

    throw error
  }
}

async function deleteOverflowItems(
  items: readonly MediaItem[],
  limit: number,
): Promise<void> {
  if (items.length <= limit) {
    return
  }

  await deleteMediaItemsWithRollback(items.slice(0, items.length - limit))
}

async function cleanupGeneratedConversions(
  conversions: GeneratedMediaConversions,
  _fallbackDisk: string,
): Promise<void> {
  for (const conversion of Object.values(conversions)) {
    await Storage.disk(conversion.disk).delete(conversion.path).catch(() => undefined)
  }
}

async function snapshotDeletedMediaItem(item: MediaItem): Promise<DeletedMediaSnapshot> {
  const record = item.record
  const fileTargets: Array<{ disk: string, path: string }> = [{
    disk: record.disk,
    path: record.path,
  }]
  const fallbackDisk = record.conversions_disk ?? record.disk

  for (const conversion of Object.values(record.generated_conversions ?? {})) {
    if (!conversion?.path) {
      continue
    }

    fileTargets.push({
      disk: conversion.disk ?? fallbackDisk,
      path: conversion.path,
    })
  }

  const files = (
    await Promise.all(fileTargets.map(async (file) => {
      const contents = await Storage.disk(file.disk).getBytes(file.path)
      return contents
        ? {
            ...file,
            contents,
          }
        : null
    }))
  ).filter((file): file is StoredMediaFileSnapshot => Boolean(file))

  return {
    record: {
      uuid: record.uuid,
      model_type: record.model_type,
      model_id: record.model_id,
      collection_name: record.collection_name,
      name: record.name,
      file_name: record.file_name,
      disk: record.disk,
      conversions_disk: record.conversions_disk,
      mime_type: record.mime_type,
      extension: record.extension,
      size: record.size,
      path: record.path,
      generated_conversions: record.generated_conversions,
      order_column: record.order_column,
    },
    files,
  }
}

async function restoreDeletedMediaSnapshot(snapshot: DeletedMediaSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    await Storage.disk(file.disk).put(file.path, file.contents)
  }

  await Media.create(snapshot.record as Partial<MediaRecord>)
}

export class MediaAdder<
  TEntity extends Entity<TableDefinition> = Entity<TableDefinition>,
  TCollectionName extends string = string,
  TConversionName extends string = string,
> {
  constructor(
    private readonly entity: TEntity,
    private readonly source: MediaSourceInput,
    private readonly state: {
      readonly fileName?: string
      readonly name?: string
      readonly disk?: string
    } = {},
  ) {}

  usingName(name: string): MediaAdder<TEntity, TCollectionName, TConversionName> {
    return new MediaAdder(this.entity, this.source, {
      ...this.state,
      name,
    })
  }

  usingFileName(fileName: string): MediaAdder<TEntity, TCollectionName, TConversionName> {
    return new MediaAdder(this.entity, this.source, {
      ...this.state,
      fileName,
    })
  }

  onDisk(disk: string): MediaAdder<TEntity, TCollectionName, TConversionName> {
    return new MediaAdder(this.entity, this.source, {
      ...this.state,
      disk,
    })
  }

  async toMediaCollection(
    collectionName: TCollectionName | 'default' = 'default',
  ): Promise<MediaItem<TCollectionName | 'default', TConversionName, TEntity>> {
    const mediaDefinition = requireMediaDefinition(this.entity)
    const ownerDefinition = this.entity.getRepository().definition
    const ownerId = this.entity.get(ownerDefinition.primaryKey as never)

    if (ownerId === null || typeof ownerId === 'undefined') {
      throw new Error(
        `[Holo Media] Cannot attach media to "${ownerDefinition.name}" before it has a persisted primary key.`,
      )
    }

    const collection = resolveMediaCollection(this.entity, collectionName)
    const source = await resolveMediaSource(
      this.source,
      this.state.fileName,
      this.state.name,
      {
        maxSize: collection.maxSize,
        collectionName: collection.name,
      },
    )
    validateSource(collection, source)

    const existing = collection.singleFile
      ? await (this.entity as MediaCapableEntity).getMedia(collectionName)
      : []

    const uuid = randomUUID()
    const diskName = this.state.disk ?? collection.disk ?? resolveImplicitDiskName()
    const conversionsDisk = collection.conversionsDisk ?? diskName
    const originalPath = getMediaPathGenerator().originalPath({
      uuid,
      fileName: source.fileName,
      extension: source.extension,
      collection,
    })

    let originalStored = false
    let createdMedia: Entity<MediaTable> | undefined
    let generatedConversions = Object.freeze({}) as GeneratedMediaConversions

    try {
      await Storage.disk(diskName).put(originalPath, source.contents)
      originalStored = true

      generatedConversions = await generateStoredConversions({
        definition: mediaDefinition,
        collection,
        conversionsDisk,
        source: {
          uuid,
          fileName: source.fileName,
          extension: source.extension,
          mimeType: source.mimeType,
          size: source.size,
          contents: source.contents,
        },
      })

      const media = await Media.create({
        uuid,
        model_type: ownerDefinition.morphClass,
        model_id: String(ownerId),
        collection_name: collectionName,
        name: source.name,
        file_name: source.fileName,
        disk: diskName,
        conversions_disk: conversionsDisk,
        mime_type: source.mimeType ?? null,
        extension: source.extension ?? null,
        size: source.size,
        path: originalPath,
        generated_conversions: generatedConversions,
        order_column: await resolveNextOrderColumn(
          ownerDefinition.morphClass,
          String(ownerId),
          collectionName,
        ),
      } as Partial<MediaRecord>)
      createdMedia = media

      this.entity.forgetRelation('media')

      await deleteMediaItemsWithRollback(existing)

      if (typeof collection.onlyKeepLatest === 'number') {
        const items = await (this.entity as MediaCapableEntity).getMedia(collectionName)
        await deleteOverflowItems(items, collection.onlyKeepLatest)
      }

      const queuedConversions = resolveQueuedConversionNames({
        definition: mediaDefinition,
        collectionName: collection.name,
      })

      await dispatchQueuedMediaConversionsForModel({
        mediaId: media.get('id'),
        conversionNames: queuedConversions,
      }, async () => {
        await media.refresh()
      })

      return new MediaItem(media, this.entity)
    } catch (error) {
      await cleanupGeneratedConversions(generatedConversions, conversionsDisk).catch(() => undefined)

      if (originalStored) {
        await Storage.disk(diskName).delete(originalPath).catch(() => undefined)
      }

      if (createdMedia) {
        await createdMedia.refresh().catch(() => undefined)
        await createdMedia.delete().catch(() => undefined)
      }
      this.entity.forgetRelation('media')

      throw error
    }
  }
}
