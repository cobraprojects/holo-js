import { randomUUID } from 'node:crypto'
import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { readFile, realpath } from 'node:fs/promises'
import { request as requestHttp } from 'node:http'
import { request as requestHttps } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
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

const DEFAULT_REMOTE_MEDIA_MAX_SIZE = 10 * 1024 * 1024
const BLOCKED_REMOTE_MEDIA_ADDRESSES = createBlockedRemoteMediaAddresses()
const LOCAL_MEDIA_SOURCE_ROOTS = Object.freeze([
  tmpdir(),
  resolve(process.cwd(), 'storage'),
])

type RemoteMediaAddressResolver = (hostname: string) => Promise<readonly LookupAddress[]>
type RemoteMediaDownloader = (url: URL) => Promise<Response>

const defaultRemoteMediaAddressResolver: RemoteMediaAddressResolver = async hostname => await lookup(hostname, {
  all: true,
  verbatim: true,
})
function createRemoteMediaDownloader(
  resolver: RemoteMediaAddressResolver,
  requester: typeof requestRemoteMedia,
): RemoteMediaDownloader {
  return async (url) => {
    const address = await resolveRemoteMediaAddress(url, resolver)
    return await requester(url, address)
  }
}
const defaultRemoteMediaDownloader = createRemoteMediaDownloader(defaultRemoteMediaAddressResolver, requestRemoteMedia)
let remoteMediaDownloader = defaultRemoteMediaDownloader

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
  const parsedUrl = new URL(url)
  return basename(parsedUrl.pathname) || 'media.bin'
}

function formatBytes(bytes: number): string {
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
  maxSize: number | undefined,
  collectionName: string,
): Promise<Uint8Array> {
  const resolvedMaxSize = typeof maxSize === 'number' ? maxSize : DEFAULT_REMOTE_MEDIA_MAX_SIZE

  if (!response.body) {
    const contents = new Uint8Array(await response.arrayBuffer())
    if (contents.byteLength > resolvedMaxSize) {
      throw createMaxSizeError(fileName, collectionName, resolvedMaxSize, contents.byteLength)
    }

    return contents
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
      if (totalSize > resolvedMaxSize) {
        /* v8 ignore next -- reader cancellation failures are intentionally swallowed. */
        await reader.cancel().catch(() => undefined)
        throw createMaxSizeError(fileName, collectionName, resolvedMaxSize, totalSize)
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
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  options: {
    readonly maxSize?: number
    readonly collectionName: string
  },
): Promise<ResolvedMediaSource> {
  if (typeof input === 'string' && /^https?:\/\//i.test(input)) {
    return resolveRemoteMediaSource(
      { url: input },
      overrideFileName,
      overrideName,
      options.maxSize,
      options.collectionName,
    )
  }

  if (typeof input !== 'string' && isUrlInput(input)) {
    return resolveRemoteMediaSource(
      input,
      overrideFileName,
      overrideName,
      options.maxSize,
      options.collectionName,
    )
  }

  if (typeof input === 'string' || isPathInput(input)) {
    const path = await resolveLocalMediaSourcePath(typeof input === 'string' ? input : input.path)
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
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  maxSize: number | undefined,
  collectionName: string,
): Promise<ResolvedMediaSource> {
  const remoteUrl = resolveRemoteMediaUrl(input.url)
  const response = await remoteMediaDownloader(remoteUrl)
  if (response.status >= 300 && response.status < 400) {
    throw new Error('[@holo-js/media] Remote media downloads do not follow redirects.')
  }

  if (!response.ok) {
    throw new Error(
      `[Holo Media] Failed to download media from "${remoteUrl.toString()}" (${response.status} ${response.statusText}).`,
    )
  }

  const fileName = sanitizeFileName(
    overrideFileName ?? input.fileName ?? parseRemoteFileName(remoteUrl.toString()),
  )
  const responseMimeType = response.headers.get('content-type')?.split(';')[0]
  const contentLengthHeader = response.headers.get('content-length')
  const contentLength = contentLengthHeader?.trim()
    ? Number(contentLengthHeader)
    : Number.NaN

  const resolvedMaxSize = typeof maxSize === 'number' ? maxSize : DEFAULT_REMOTE_MEDIA_MAX_SIZE
  if (Number.isFinite(contentLength) && contentLength > resolvedMaxSize) {
    throw createMaxSizeError(fileName, collectionName, resolvedMaxSize, contentLength)
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

async function resolveLocalMediaSourcePath(path: string): Promise<string> {
  const resolvedPath = await realpath(path)
  const allowedRoots = await Promise.all(LOCAL_MEDIA_SOURCE_ROOTS.map(async root => await realpath(root).catch(() => null)))
  if (allowedRoots.some(root => root && isPathWithinRoot(resolvedPath, root))) {
    return resolvedPath
  }

  throw new Error('[@holo-js/media] Media path sources must resolve inside an allowed upload directory.')
}

function isPathWithinRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`)
}

function resolveRemoteMediaUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('[@holo-js/media] Remote media URLs must be valid absolute URLs.')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('[@holo-js/media] Remote media URLs must use http or https.')
  }

  if (url.username || url.password) {
    throw new Error('[@holo-js/media] Remote media URLs must not include credentials.')
  }

  if (isBlockedRemoteMediaHost(url.hostname)) {
    throw new Error('[@holo-js/media] Remote media URLs must not target local or private hosts.')
  }

  return url
}

function createBlockedRemoteMediaAddresses(): BlockList {
  const blockList = new BlockList()
  for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4')
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6')
  }
  return blockList
}

function isBlockedRemoteMediaAddress(address: LookupAddress): boolean {
  return BLOCKED_REMOTE_MEDIA_ADDRESSES.check(address.address, address.family === 4 ? 'ipv4' : 'ipv6')
}

async function resolveRemoteMediaAddress(
  url: URL,
  resolver: RemoteMediaAddressResolver,
): Promise<LookupAddress> {
  const addresses = await resolver(url.hostname)
  if (addresses.length === 0 || addresses.some(isBlockedRemoteMediaAddress)) {
    throw new Error('[@holo-js/media] Remote media URLs must not resolve to local or private hosts.')
  }

  return addresses[0]!
}

function requestRemoteMedia(url: URL, address: LookupAddress): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const request = resolveRemoteMediaRequest(url.protocol)(url, {
      headers: {
        host: url.host,
      },
      lookup: createPinnedRemoteMediaLookup(address),
    }, (response) => {
      const headers = new Headers()
      appendRemoteMediaHeaders(headers, response.headers)
      resolveResponse(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, {
        status: response.statusCode,
        statusText: response.statusMessage,
        headers,
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

function createPinnedRemoteMediaLookup(address: LookupAddress): NonNullable<Parameters<typeof requestHttp>[1]>['lookup'] {
  return (_hostname, options, callback) => options.all
    ? callback(null, [address])
    : callback(null, address.address, address.family)
}

function appendRemoteMediaHeaders(
  headers: Headers,
  source: Readonly<Record<string, string | readonly string[] | undefined>>,
): void {
  for (const [name, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry)
    } else if (typeof value === 'string') {
      headers.set(name, value)
    }
  }
}

function resolveRemoteMediaRequest(protocol: string): typeof requestHttp {
  return protocol === 'https:' ? requestHttps : requestHttp
}

function isBlockedRemoteMediaHost(hostname: string): boolean {
  const lowerCaseHostname = hostname.toLowerCase()
  const normalized = lowerCaseHostname.startsWith('[') && lowerCaseHostname.endsWith(']')
    ? lowerCaseHostname.slice(1, -1)
    : lowerCaseHostname
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) {
    return true
  }

  const family = isIP(normalized)
  return family !== 0 && isBlockedRemoteMediaAddress({ address: normalized, family })
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

export const mediaAdderInternals = {
  appendRemoteMediaHeaders,
  createPinnedRemoteMediaLookup,
  createRemoteMediaDownloader,
  defaultRemoteMediaAddressResolver,
  resetRemoteMediaTransport(): void {
    remoteMediaDownloader = defaultRemoteMediaDownloader
  },
  async resolveRemoteMediaAddress(url: URL, resolver: RemoteMediaAddressResolver): Promise<LookupAddress> {
    return await resolveRemoteMediaAddress(url, resolver)
  },
  requestRemoteMedia,
  resolveRemoteMediaRequest,
  setRemoteMediaDownloader(downloader: RemoteMediaDownloader): void {
    remoteMediaDownloader = downloader
  },
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
