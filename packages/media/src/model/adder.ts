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
import { config } from '@holo-js/config'
import { localStoragePathInternals } from '@holo-js/kernel'
import { inspectFileContent } from '@holo-js/kernel/file-content'
import {
  Storage,
  StorageMetadataUnsupportedError,
  type StorageDisk,
  type StorageFileMetadata,
} from '@holo-js/storage/runtime'
import type { Entity, ModelRecord, TableDefinition } from '@holo-js/db'
import {
  getMediaPathGenerator,
  type MediaConversionExecutorSource,
  requireMediaDefinition,
  resolveMediaCollection,
} from '../registry'
import {
  getContentSize,
  getDisplayName,
  getExtension,
  sanitizeFileName,
  toBinaryContent,
  type BinaryContent,
} from '../runtime/binary'
import type { NormalizedMediaCollectionDefinition } from '../definitions/collections'
import type { NormalizedMediaDefinition } from '../definitions/config'
import { dispatchQueuedMediaConversionsForModel } from '../queue'
import {
  resolveQueuedConversionNames,
  writeStoredConversions,
} from './conversions'
import { Media } from './Media'
import { removeObsoleteFiles, runMediaMutation } from './mutation'
import { MediaItem } from './item'

type MediaOwner<TEntity extends Entity<TableDefinition>> = TEntity & {
  getMedia(collectionName?: string): Promise<MediaItem[]>
}

export type MediaSourceInput
  = | string
    | BinaryContent
    | { readonly path: string }
    | {
      readonly contents: BinaryContent
      readonly fileName?: string
      readonly name?: string
    }

export class RemoteMediaSource {
  constructor(readonly url: string) {}
}

export class StoredMediaSource {
  constructor(
    readonly disk: string,
    readonly path: string,
  ) {}
}

type MediaAdderSource = MediaSourceInput | RemoteMediaSource | StoredMediaSource

type ReadMediaSource = {
  readonly contents: Uint8Array
  readonly fileName: string
  readonly extension?: string
  readonly size: number
  readonly name: string
}

type ResolvedMediaSource = ReadMediaSource & {
  readonly mimeType?: string
}

type NamedBinaryContent = BinaryContent & {
  readonly name?: string
}

const DEFAULT_REMOTE_MEDIA_MAX_SIZE = 10 * 1024 * 1024
const REMOTE_MEDIA_TIMEOUT_MS = 30_000
const DEFAULT_MEDIA_DISK = 'public'
const BLOCKED_REMOTE_MEDIA_ADDRESSES = createBlockedRemoteMediaAddresses()
const LOCAL_MEDIA_SOURCE_ROOTS = Object.freeze([
  tmpdir(),
  resolve(process.cwd(), 'storage'),
])

type RemoteMediaAddressResolver = (hostname: string) => Promise<readonly LookupAddress[]>
type RemoteMediaDownloader = (url: URL, signal: AbortSignal) => Promise<Response>

const defaultRemoteMediaAddressResolver: RemoteMediaAddressResolver = async hostname => await lookup(hostname, {
  all: true,
  verbatim: true,
})
function createRemoteMediaDownloader(
  resolver: RemoteMediaAddressResolver,
  requester: typeof requestRemoteMedia,
): RemoteMediaDownloader {
  return async (url, signal) => {
    const address = await resolveRemoteMediaAddress(url, resolver)
    return await requester(url, address, signal)
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

function resolveMediaDefaultDisk(): string {
  let configuredDisk: unknown
  try {
    configuredDisk = config('media.disk')
  } catch {
    return DEFAULT_MEDIA_DISK
  }

  return typeof configuredDisk === 'string' && configuredDisk.trim()
    ? configuredDisk.trim()
    : DEFAULT_MEDIA_DISK
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

  return await readBoundedMediaContents(
    readWebStreamChunks(response.body),
    fileName,
    resolvedMaxSize,
    collectionName,
  )
}

async function* readWebStreamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }

      if (value) {
        yield value
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function readBoundedMediaContents(
  chunks: AsyncIterable<Uint8Array>,
  fileName: string,
  maxSize: number,
  collectionName: string,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let totalSize = 0

  for await (const chunk of chunks) {
    totalSize += chunk.byteLength
    if (totalSize > maxSize) {
      throw createMaxSizeError(fileName, collectionName, maxSize, totalSize)
    }

    parts.push(chunk)
  }

  const contents = new Uint8Array(totalSize)
  let offset = 0
  for (const part of parts) {
    contents.set(part, offset)
    offset += part.byteLength
  }

  return contents
}

async function resolveMediaSource(
  input: MediaAdderSource,
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  options: {
    readonly maxSize?: number
    readonly collectionName: string
  },
): Promise<ResolvedMediaSource> {
  const source = await readMediaSource(input, overrideFileName, overrideName, options)
  const { mimeType } = await inspectFileContent(source.contents, source.fileName)
  return mimeType ? { ...source, mimeType } : source
}

async function readMediaSource(
  input: MediaAdderSource,
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  options: {
    readonly maxSize?: number
    readonly collectionName: string
  },
): Promise<ReadMediaSource> {
  if (input instanceof RemoteMediaSource) {
    return resolveRemoteMediaSource(
      input,
      overrideFileName,
      overrideName,
      options.maxSize,
      options.collectionName,
    )
  }

  if (input instanceof StoredMediaSource) {
    return resolveStorageMediaSource(input, overrideFileName, overrideName, options)
  }

  if ((typeof input === 'string' && /^https?:\/\//i.test(input)) || (typeof input === 'object' && input !== null && 'url' in input)) {
    throw new Error('[@holo-js/media] addMedia() reads file paths and binary contents. Use addMediaFromUrl() to download a URL.')
  }

  if (typeof input === 'string' || isPathInput(input)) {
    const path = await resolveLocalMediaSourcePath(typeof input === 'string' ? input : input.path)
    const contents = await readFile(path)
    const fileName = sanitizeFileName(overrideFileName ?? basename(path))
    return {
      contents,
      fileName,
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
    extension: getExtension(fileName),
    size: getContentSize(contents),
    name: getDisplayName(fileName, overrideName),
  }
}

function getBinaryFileName(input: BinaryContent): string {
  const name = (input as NamedBinaryContent).name
  return typeof name === 'string' && name.trim() ? name : 'media.bin'
}

function isPathInput(
  input: Exclude<MediaSourceInput, string>,
): input is { readonly path: string } {
  return typeof input === 'object' && input !== null && 'path' in input
}

async function resolveStorageMediaSource(
  input: StoredMediaSource,
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  options: {
    readonly maxSize?: number
    readonly collectionName: string
  },
): Promise<ReadMediaSource> {
  const disk = Storage.disk(input.disk)
  const fileName = sanitizeFileName(overrideFileName ?? localStoragePathInternals.splitLocalStoragePath(input.path).at(-1) ?? '')
  if (typeof options.maxSize === 'number') {
    await rejectOversizedStoredFile(disk, input, fileName, options.maxSize, options.collectionName)
  }

  const chunks = await disk.readStream(input.path)
  if (!chunks) {
    throw missingStoredFileError(input)
  }

  const contents = await readBoundedMediaContents(
    chunks,
    fileName,
    options.maxSize ?? Number.POSITIVE_INFINITY,
    options.collectionName,
  )

  return {
    contents,
    fileName,
    extension: getExtension(fileName),
    size: contents.byteLength,
    name: getDisplayName(fileName, overrideName),
  }
}

async function rejectOversizedStoredFile(
  disk: StorageDisk,
  input: StoredMediaSource,
  fileName: string,
  maxSize: number,
  collectionName: string,
): Promise<void> {
  let metadata: StorageFileMetadata | null
  try {
    metadata = await disk.stat(input.path)
  } catch (error) {
    if (error instanceof StorageMetadataUnsupportedError) {
      return
    }

    throw error
  }

  if (!metadata) {
    throw missingStoredFileError(input)
  }

  if (metadata.size > maxSize) {
    throw createMaxSizeError(fileName, collectionName, maxSize, metadata.size)
  }
}

function missingStoredFileError(input: StoredMediaSource): Error {
  return new Error(`[@holo-js/media] File "${input.path}" was not found on disk "${input.disk}".`)
}

async function withRemoteMediaDeadline<TResult>(
  download: (signal: AbortSignal) => Promise<TResult>,
): Promise<TResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `[@holo-js/media] Remote media downloads must finish within ${REMOTE_MEDIA_TIMEOUT_MS / 1000} seconds.`,
      )
      controller.abort(error)
      reject(error)
    }, REMOTE_MEDIA_TIMEOUT_MS)
  })

  try {
    return await Promise.race([download(controller.signal), deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function resolveRemoteMediaSource(
  input: RemoteMediaSource,
  overrideFileName: string | undefined,
  overrideName: string | undefined,
  maxSize: number | undefined,
  collectionName: string,
): Promise<ReadMediaSource> {
  const remoteUrl = resolveRemoteMediaUrl(input.url)
  return await withRemoteMediaDeadline(async (signal) => {
    const response = await remoteMediaDownloader(remoteUrl, signal)
    if (response.status >= 300 && response.status < 400) {
      throw new Error('[@holo-js/media] Remote media downloads do not follow redirects.')
    }

    if (!response.ok) {
      throw new Error(
        `[Holo Media] Failed to download media from "${remoteUrl.toString()}" (${response.status} ${response.statusText}).`,
      )
    }

    const fileName = sanitizeFileName(
      overrideFileName ?? parseRemoteFileName(remoteUrl.toString()),
    )
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
      extension: getExtension(fileName),
      size: contents.byteLength,
      name: getDisplayName(fileName, overrideName),
    }
  })
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

function requestRemoteMedia(url: URL, address: LookupAddress, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const request = resolveRemoteMediaRequest(url.protocol)(url, {
      headers: {
        host: url.host,
      },
      lookup: createPinnedRemoteMediaLookup(address),
      signal,
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
    private readonly source: MediaAdderSource,
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

    return await attachMedia<TEntity, TCollectionName | 'default', TConversionName>({
      owner: this.entity,
      collectionName,
      collection,
      definition: mediaDefinition,
      source,
      disk: this.state.disk ?? collection.disk ?? resolveMediaDefaultDisk(),
    })
  }
}

async function attachMedia<
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
    write: async (mutation) => {
      await mutation.put(disk, path, source.contents)
      return await writeStoredConversions({
        definition: options.definition,
        collection,
        conversionsDisk,
        source: { ...source, uuid },
        mutation,
      })
    },
    operation: async (_mutation, generatedConversions) => {
      const existing = collection.singleFile
        ? await (owner as MediaOwner<TEntity>).getMedia(options.collectionName)
        : []
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
    afterCommit: [
      async (item) => {
        await removeObsoleteFiles(obsolete, [
          { disk, path },
          ...Object.values(item.record.generated_conversions).map(conversion => ({
            disk: conversion.disk ?? conversionsDisk,
            path: conversion.path,
          })),
        ])
      },
      async (item) => {
        const media = item.getEntity()
        await dispatchQueuedMediaConversionsForModel({
          mediaId: media.get('id'),
          conversionNames: resolveQueuedConversionNames({ definition: options.definition, collectionName: collection.name }),
        }, async () => { await media.refresh() })
      },
    ],
    afterEffects: () => { owner.forgetRelation('media') },
  })
}
