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
  StorageStreamingUnsupportedError,
  type StorageByteStream,
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
const GLOBALLY_REACHABLE_BLOCKED_IPV4_ADDRESSES = createGloballyReachableBlockedIPv4Addresses()
const GLOBAL_UNICAST_IPV6_ADDRESSES = createGlobalUnicastIPv6Addresses()
const IETF_PROTOCOL_ASSIGNMENTS = createIETFProtocolAssignmentsBlockList()
const GLOBALLY_REACHABLE_IETF_PROTOCOL_ASSIGNMENTS = createGloballyReachableIETFProtocolAssignments()
const NAT64_WELL_KNOWN_PREFIX = Buffer.concat([Buffer.from([0x00, 0x64, 0xff, 0x9b]), Buffer.alloc(8)])
const SIX_TO_FOUR_PREFIX = Buffer.from([0x20, 0x02])
const IPV4_COMPATIBLE_PREFIX = Buffer.alloc(12)
const TRANSLATED_IPV4_PREFIX = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0])
const IPV4_MAPPED_PREFIX = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])
const TEREDO_PREFIX = Buffer.from([0x20, 0x01, 0x00, 0x00])
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
  const maxSize = options.maxSize
  const metadataAvailable = typeof maxSize === 'number'
    && await checkStoredFileSize(disk, input, fileName, maxSize, options.collectionName)
  const chunks = await openStoredFileStream(disk, input)
  if (chunks === null) {
    throw missingStoredFileError(input)
  }

  let contents: Uint8Array
  if (chunks) {
    contents = await readBoundedMediaContents(chunks, fileName, maxSize ?? Number.POSITIVE_INFINITY, options.collectionName)
  } else if (typeof maxSize !== 'number') {
    contents = await readWholeStoredFile(disk, input)
  } else if (!metadataAvailable) {
    throw new Error(
      `[@holo-js/media] Collection "${options.collectionName}" has a maxSize, so "${input.path}" on disk "${input.disk}" needs a disk that supports file metadata or streaming.`,
    )
  } else {
    contents = await readWholeStoredFile(disk, input)
    if (contents.byteLength > maxSize) {
      throw createMaxSizeError(fileName, options.collectionName, maxSize, contents.byteLength)
    }
  }

  return {
    contents,
    fileName,
    extension: getExtension(fileName),
    size: contents.byteLength,
    name: getDisplayName(fileName, overrideName),
  }
}

async function checkStoredFileSize(
  disk: StorageDisk,
  input: StoredMediaSource,
  fileName: string,
  maxSize: number,
  collectionName: string,
): Promise<boolean> {
  let metadata: StorageFileMetadata | null
  try {
    metadata = await disk.stat(input.path)
  } catch (error) {
    if (error instanceof StorageMetadataUnsupportedError) {
      return false
    }

    throw error
  }

  if (!metadata) {
    throw missingStoredFileError(input)
  }

  if (metadata.size > maxSize) {
    throw createMaxSizeError(fileName, collectionName, maxSize, metadata.size)
  }

  return true
}

async function openStoredFileStream(
  disk: StorageDisk,
  input: StoredMediaSource,
): Promise<StorageByteStream | null | undefined> {
  try {
    return await disk.readStream(input.path)
  } catch (error) {
    if (error instanceof StorageStreamingUnsupportedError) {
      return undefined
    }

    throw error
  }
}

async function readWholeStoredFile(disk: StorageDisk, input: StoredMediaSource): Promise<Uint8Array> {
  const contents = await disk.getBytes(input.path)
  if (!contents) {
    throw missingStoredFileError(input)
  }

  return contents
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

  if (isLocalRemoteMediaName(url.hostname)) {
    throw new Error('[@holo-js/media] Remote media URLs must not target local or private hosts.')
  }

  const literal = parseRemoteMediaIPLiteral(url.hostname)
  if (literal) {
    assertRemoteMediaAddressesAllowed([literal])
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
    ['192.88.99.2', 32],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
    ['255.255.255.255', 32],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4')
  }
  for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['100::', 64],
    ['100:0:0:1::', 64],
    ['2001:db8::', 32],
    ['3fff::', 20],
    ['5f00::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['fec0::', 10],
    ['ff00::', 8],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6')
  }
  return blockList
}

function createGloballyReachableBlockedIPv4Addresses(): BlockList {
  const blockList = new BlockList()
  for (const [network, prefix] of [
    ['192.0.0.9', 32],
    ['192.0.0.10', 32],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv4')
  }
  return blockList
}

function createGlobalUnicastIPv6Addresses(): BlockList {
  const blockList = new BlockList()
  blockList.addSubnet('2000::', 3, 'ipv6')
  return blockList
}

function createIETFProtocolAssignmentsBlockList(): BlockList {
  const blockList = new BlockList()
  blockList.addSubnet('2001::', 23, 'ipv6')
  return blockList
}

function createGloballyReachableIETFProtocolAssignments(): BlockList {
  const blockList = new BlockList()
  for (const [network, prefix] of [
    ['2001::', 32],
    ['2001:1::1', 128],
    ['2001:1::2', 128],
    ['2001:1::3', 128],
    ['2001:3::', 32],
    ['2001:4:112::', 48],
    ['2001:20::', 28],
    ['2001:30::', 28],
  ] as const) {
    blockList.addSubnet(network, prefix, 'ipv6')
  }
  return blockList
}

function isBlockedRemoteMediaIPv4Address(address: string): boolean {
  return BLOCKED_REMOTE_MEDIA_ADDRESSES.check(address, 'ipv4')
    && !GLOBALLY_REACHABLE_BLOCKED_IPV4_ADDRESSES.check(address, 'ipv4')
}

function isBlockedRemoteMediaAddress(address: LookupAddress): boolean {
  if (address.family === 4) {
    return isBlockedRemoteMediaIPv4Address(address.address)
  }

  return isBlockedRemoteMediaIPv6Address(address.address)
}

function isBlockedRemoteMediaIPv6Address(address: string): boolean {
  const bytes = findIPv6Bytes(address)
  if (!bytes) {
    return true
  }

  if (!GLOBAL_UNICAST_IPV6_ADDRESSES.check(address, 'ipv6')) {
    const mappedAddress = findMappedIPv4Address(bytes)
    return mappedAddress === null || isBlockedRemoteMediaIPv4Address(mappedAddress)
  }

  if (BLOCKED_REMOTE_MEDIA_ADDRESSES.check(address, 'ipv6')) {
    return true
  }

  if (
    IETF_PROTOCOL_ASSIGNMENTS.check(address, 'ipv6')
    && !GLOBALLY_REACHABLE_IETF_PROTOCOL_ASSIGNMENTS.check(address, 'ipv6')
  ) {
    return true
  }

  return findEmbeddedIPv4Addresses(bytes).some(isBlockedRemoteMediaIPv4Address)
}

function findMappedIPv4Address(bytes: Buffer): string | null {
  const mappedPrefixes = [NAT64_WELL_KNOWN_PREFIX, IPV4_COMPATIBLE_PREFIX, IPV4_MAPPED_PREFIX, TRANSLATED_IPV4_PREFIX]
  if (!mappedPrefixes.some(prefix => bytes.subarray(0, 12).equals(prefix))) {
    return null
  }

  return formatIPv4Octets(bytes.subarray(12, 16))
}

function findEmbeddedIPv4Addresses(bytes: Buffer): string[] {
  const embeddedAddresses: string[] = []

  if (bytes.subarray(0, 2).equals(SIX_TO_FOUR_PREFIX)) {
    embeddedAddresses.push(formatIPv4Octets(bytes.subarray(2, 6)))
  }

  if (bytes.subarray(0, 4).equals(TEREDO_PREFIX)) {
    embeddedAddresses.push(formatIPv4Octets(bytes.subarray(12, 16).map(octet => octet ^ 0xff)))
  }

  const interfaceIdentifierPrefix = bytes.readUInt16BE(8)
  if ((interfaceIdentifierPrefix === 0x0000 || interfaceIdentifierPrefix === 0x0200) && bytes.readUInt16BE(10) === 0x5efe) {
    embeddedAddresses.push(formatIPv4Octets(bytes.subarray(12, 16)))
  }

  return embeddedAddresses
}

function findIPv6Bytes(address: string): Buffer | null {
  let canonical: string
  try {
    canonical = new URL(`http://[${address}]`).hostname.slice(1, -1)
  } catch {
    return null
  }

  const halves = canonical.split('::')
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves[1] ? halves[1].split(':') : []
  const zeroGroups = halves.length === 2 ? 8 - head.length - tail.length : 0
  const groups = [...head, ...Array<string>(zeroGroups).fill('0'), ...tail]
  if (groups.length !== 8) {
    return null
  }

  return Buffer.from(groups.flatMap((group) => {
    const value = Number.parseInt(group, 16)
    return [value >> 8, value & 0xff]
  }))
}

function formatIPv4Octets(octets: Uint8Array): string {
  return Array.from(octets).join('.')
}

async function resolveRemoteMediaAddress(
  url: URL,
  resolver: RemoteMediaAddressResolver,
): Promise<LookupAddress> {
  const addresses = await resolveRemoteMediaHostAddresses(url.hostname, resolver)
  assertRemoteMediaAddressesAllowed(addresses)
  return addresses[0]!
}

function assertRemoteMediaAddressesAllowed(addresses: readonly LookupAddress[]): void {
  if (addresses.length === 0 || addresses.some(isBlockedRemoteMediaAddress)) {
    throw new Error('[@holo-js/media] Remote media URLs must not resolve to local or private hosts.')
  }
}

async function resolveRemoteMediaHostAddresses(
  hostname: string,
  resolver: RemoteMediaAddressResolver,
): Promise<readonly LookupAddress[]> {
  const literal = parseRemoteMediaIPLiteral(hostname)
  return literal ? [literal] : await resolver(hostname)
}

function parseRemoteMediaIPLiteral(hostname: string): LookupAddress | null {
  const address = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const family = isIP(address)
  return family === 0 ? null : { address, family }
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

function isLocalRemoteMediaName(hostname: string): boolean {
  const lowerCaseHostname = hostname.toLowerCase()
  return lowerCaseHostname === 'localhost' || lowerCaseHostname.endsWith('.localhost')
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
