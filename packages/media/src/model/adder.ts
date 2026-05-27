import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Storage } from '@holo-js/storage/runtime'
import { connectionAsyncContext, type Entity, type ModelRecord, type TableDefinition } from '@holo-js/db'
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

type NamedBinaryContent = BinaryContent & {
  readonly name?: string
  readonly type?: string
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

type MediaAddErrorCode
  = | 'max_size_exceeded'
    | 'invalid_mime_type'
    | 'invalid_extension'

type MediaAddErrorDetails
  = | {
    readonly code: 'max_size_exceeded'
    readonly collection: string
    readonly fileName: string
    readonly maxSize: number
    readonly actualSize: number
  }
    | {
      readonly code: 'invalid_mime_type'
      readonly collection: string
      readonly fileName: string
      readonly mimeType?: string
      readonly acceptedMimeTypes: readonly string[]
    }
    | {
      readonly code: 'invalid_extension'
      readonly collection: string
      readonly fileName: string
      readonly extension?: string
    readonly acceptedExtensions: readonly string[]
  }

type MediaAddError = {
  readonly code: MediaAddErrorCode
  readonly status: 422
  readonly message: string
  readonly collection: string
  readonly fileName: string
  readonly maxSize?: number
  readonly actualSize?: number
  readonly mimeType?: string
  readonly acceptedMimeTypes?: readonly string[]
  readonly extension?: string
  readonly acceptedExtensions?: readonly string[]
}

export type MediaAddResult<
  TCollectionName extends string = string,
  TConversionName extends string = string,
  TEntity extends Entity<TableDefinition> = Entity<TableDefinition>,
> = MediaItem<TCollectionName, TConversionName, TEntity> & {
  readonly data: MediaItem<TCollectionName, TConversionName, TEntity> | null
  readonly error: MediaAddError | null
}

class MediaAddValidationException extends Error {
  readonly error: MediaAddError

  constructor(details: MediaAddErrorDetails) {
    const error = createMediaAddError(details)
    super(error.message)
    this.name = 'MediaAddValidationException'
    this.error = error
  }
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 bytes'
  }

  const units = ['bytes', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const formatted = unitIndex === 0
    ? String(Math.round(value))
    : value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, '')

  return `${formatted} ${units[unitIndex]}`
}

function createMediaValidationMessage(details: MediaAddErrorDetails): string {
  if (details.code === 'max_size_exceeded') {
    return `The selected file must be ${formatBytes(details.maxSize)} or smaller.`
  }

  if (details.code === 'invalid_mime_type') {
    return `The selected file must be one of these types: ${details.acceptedMimeTypes.join(', ')}.`
  }

  return `The selected file must use one of these extensions: ${details.acceptedExtensions.join(', ')}.`
}

function createMediaAddError(details: MediaAddErrorDetails): MediaAddError {
  return Object.freeze({
    ...details,
    status: 422,
    message: createMediaValidationMessage(details),
  })
}

function createMaxSizeError(
  fileName: string,
  collectionName: string,
  maxSize: number,
  actualSize: number,
): MediaAddValidationException {
  return new MediaAddValidationException({
    code: 'max_size_exceeded',
    collection: collectionName,
    fileName,
    maxSize,
    actualSize,
  })
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
        /* v8 ignore next -- reader cancellation failures are intentionally swallowed. */
        await reader.cancel().catch(() => undefined)
        throw createMaxSizeError(fileName, collectionName ?? 'default', maxSize, totalSize)
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
  const fileName = sanitizeFileName(overrideFileName ?? getBinaryFileName(input))

  return {
    contents,
    fileName,
    mimeType: inferMimeType(fileName, getBinaryMimeType(input)),
    extension: getExtension(fileName),
    size: getContentSize(contents),
    name: getDisplayName(fileName, overrideName),
  }
}

function getBinaryFileName(input: BinaryContent): string {
  const name = (input as NamedBinaryContent).name
  return typeof name === 'string' && name.trim() ? name : 'media.bin'
}

function getBinaryMimeType(input: BinaryContent): string | undefined {
  const type = (input as NamedBinaryContent).type
  return typeof type === 'string' && type.trim() ? type : undefined
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
    throw createMaxSizeError(fileName, collectionName ?? 'default', maxSize, contentLength)
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
    throw createMaxSizeError(source.fileName, collection.name, collection.maxSize, source.size)
  }

  if (collection.acceptedMimeTypes.length > 0) {
    const mimeType = source.mimeType?.trim().toLowerCase()

    if (!mimeType || !collection.acceptedMimeTypes.includes(mimeType)) {
      throw new MediaAddValidationException({
        code: 'invalid_mime_type',
        collection: collection.name,
        fileName: source.fileName,
        mimeType,
        acceptedMimeTypes: collection.acceptedMimeTypes,
      })
    }
  }

  if (collection.acceptedExtensions.length > 0) {
    if (!source.extension || !collection.acceptedExtensions.includes(source.extension)) {
      throw new MediaAddValidationException({
        code: 'invalid_extension',
        collection: collection.name,
        fileName: source.fileName,
        extension: source.extension,
        acceptedExtensions: collection.acceptedExtensions,
      })
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
): Promise<DeletedMediaSnapshot[]> {
  const deletedSnapshots: DeletedMediaSnapshot[] = []

  try {
    for (const item of items) {
      const snapshot = await snapshotDeletedMediaItem(item)
      await item.delete()
      deletedSnapshots.push(snapshot)
    }
  } catch (error) {
    await restoreDeletedMediaSnapshots(deletedSnapshots)

    throw error
  }

  return deletedSnapshots
}

async function deleteOverflowItems(
  items: readonly MediaItem[],
  limit: number,
): Promise<DeletedMediaSnapshot[]> {
  if (items.length <= limit) {
    return []
  }

  return await deleteMediaItemsWithRollback(items.slice(0, items.length - limit))
}

async function cleanupGeneratedConversions(
  conversions: GeneratedMediaConversions,
  _fallbackDisk: string,
): Promise<void> {
  for (const conversion of Object.values(conversions)) {
    /* v8 ignore next -- generated conversion cleanup failures are intentionally swallowed. */
    await Storage.disk(conversion.disk).delete(conversion.path).catch(() => undefined)
  }
}

function registerCreatedMediaRollbackCleanup(
  cleanup: () => Promise<void>,
): void {
  const active = connectionAsyncContext.getActive()?.connection
  if (!active || active.getScope().kind === 'root') {
    return
  }

  active.afterRollback(cleanup)
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

async function restoreDeletedMediaSnapshots(
  snapshots: DeletedMediaSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots.reverse()) {
    /* v8 ignore next -- rollback cleanup failures are intentionally swallowed. */
    await restoreDeletedMediaSnapshot(snapshot).catch(() => undefined)
  }
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
  ): Promise<MediaAddResult<TCollectionName | 'default', TConversionName, TEntity>> {
    try {
      const media = await this.storeInMediaCollection(collectionName)

      return Object.assign(media, {
        data: media,
        error: null,
      })
    } catch (error) {
      if (error instanceof MediaAddValidationException) {
        return {
          data: null,
          error: error.error,
        } as MediaAddResult<TCollectionName | 'default', TConversionName, TEntity>
      }

      throw error
    }
  }

  private async storeInMediaCollection(
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
    const deletedMediaSnapshots: DeletedMediaSnapshot[] = []

    try {
      await Storage.disk(diskName).put(originalPath, source.contents)
      originalStored = true
      registerCreatedMediaRollbackCleanup(async () => {
        /* v8 ignore next -- rollback cleanup failures are intentionally swallowed. */
        await cleanupGeneratedConversions(generatedConversions, conversionsDisk).catch(() => undefined)
        /* v8 ignore next -- rollback cleanup failures are intentionally swallowed. */
        await Storage.disk(diskName).delete(originalPath).catch(() => undefined)
      })

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

      deletedMediaSnapshots.push(...await deleteMediaItemsWithRollback(existing))

      if (typeof collection.onlyKeepLatest === 'number') {
        const items = await (this.entity as MediaCapableEntity).getMedia(collectionName)
        deletedMediaSnapshots.push(...await deleteOverflowItems(items, collection.onlyKeepLatest))
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
      /* v8 ignore next -- cleanup failures are intentionally swallowed. */
      await cleanupGeneratedConversions(generatedConversions, conversionsDisk).catch(() => undefined)

      /* v8 ignore else -- the storage mock cannot fail after entering this cleanup block before storing. */
      if (originalStored) {
        /* v8 ignore next -- original cleanup failures are intentionally swallowed. */
        await Storage.disk(diskName).delete(originalPath).catch(() => undefined)
      }

      if (createdMedia) {
        /* v8 ignore next -- refresh cleanup failures are intentionally swallowed. */
        await createdMedia.refresh().catch(() => undefined)
        /* v8 ignore next -- media-row cleanup failures are intentionally swallowed. */
        await createdMedia.delete().catch(() => undefined)
      }

      await restoreDeletedMediaSnapshots(deletedMediaSnapshots)
      this.entity.forgetRelation('media')

      throw error
    }
  }
}
