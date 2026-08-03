import { createHmac, createHash } from 'node:crypto'
import type {
  RuntimeDiskConfig,
  StorageVisibility,
  HoloStorageRuntimeConfig,
} from '../../config'

type RawStorageValue = string | Uint8Array | ArrayBuffer | Buffer | null
const NAMED_PUBLIC_DISK_ROUTE_SEGMENT = '__holo'
type StorageRuntimeConfigValue = {
  holoStorage: HoloStorageRuntimeConfig
  holo?: { appUrl?: string }
}

export interface StorageBackend {
  getItem<T = unknown>(key: string): Promise<T | null>
  getItemRaw(key: string): Promise<RawStorageValue>
  setItem(key: string, value: unknown): Promise<void>
  setItemRaw(key: string, value: Exclude<RawStorageValue, null>): Promise<void>
  hasItem(key: string): Promise<boolean>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
  getKeysPage?(
    base: string | undefined,
    request: Required<StorageFileListRequest>,
  ): Promise<StorageFileListPage>
  getItemStream?(
    key: string,
    options: StorageStreamReadOptions,
  ): Promise<StorageByteStream | null>
  setItemStream?(
    key: string,
    source: StorageByteStream,
    options: Required<StorageStreamWriteOptions>,
  ): Promise<void>
  getMeta?<T = unknown>(key: string): Promise<T | null>
  setMeta?(key: string, value: unknown): Promise<void>
  removeMeta?(key: string): Promise<void>
  clear?(base?: string): Promise<void>
  watch?(callback: (event: string, key: string) => void): Promise<unknown> | unknown
}

export type StorageContent
  = string
    | Uint8Array
    | ArrayBuffer
    | Buffer
    | Blob

export type StorageByteStream = AsyncIterable<Uint8Array>

export interface StorageStreamReadOptions {
  readonly chunkBytes?: number
}

export interface StorageStreamWriteOptions {
  readonly overwrite?: boolean
}

export class StorageStreamingUnsupportedError extends Error {
  constructor() {
    super('[Holo Storage] The configured storage backend does not support bounded streaming.')
    this.name = 'StorageStreamingUnsupportedError'
  }
}

export interface TemporaryUrlOptions {
  expiresAt?: Date | number | string
  expiresIn?: number
}

export interface StorageFileListRequest {
  readonly cursor?: string | null
  readonly limit?: number
}

export interface StorageFileListPage {
  readonly nextCursor: string | null
  readonly paths: readonly string[]
}

type StoragePaginationCursor = {
  readonly continuation: string
  readonly directory: string
  readonly disk: string
  readonly version: 1
}

export class StoragePaginationError extends Error {
  constructor() {
    super('[Holo Storage] File pagination failed.')
    this.name = 'StoragePaginationError'
  }
}

export interface StorageDisk {
  readonly name: string
  readonly driver: RuntimeDiskConfig['driver']
  readonly visibility: StorageVisibility
  put(path: string, contents: StorageContent): Promise<boolean>
  putJson(path: string, value: unknown): Promise<boolean>
  get(path: string): Promise<string | null>
  getBytes(path: string): Promise<Uint8Array | null>
  readStream(path: string, options?: StorageStreamReadOptions): Promise<StorageByteStream | null>
  writeStream(path: string, source: StorageByteStream, options?: StorageStreamWriteOptions): Promise<boolean>
  json<T>(path: string): Promise<T | null>
  exists(path: string): Promise<boolean>
  missing(path: string): Promise<boolean>
  delete(path: string | string[]): Promise<boolean>
  copy(from: string, to: string): Promise<boolean>
  move(from: string, to: string): Promise<boolean>
  listFiles(directory?: string, request?: StorageFileListRequest): Promise<StorageFileListPage>
  path(path: string): string
  url(path: string): string
  temporaryUrl(path: string, options?: TemporaryUrlOptions): string
}

export type StorageInstance = StorageBackend & StorageDisk

export interface StorageRuntimeBindings {
  getRuntimeConfig(): StorageRuntimeConfigValue
  getStorage(base: string): StorageBackend
}

let storageRuntimeBindings: StorageRuntimeBindings | undefined

type StorageRuntimeGlobals = typeof globalThis & {
  __holoStorageRuntimeBindings__?: StorageRuntimeBindings
  useRuntimeConfig?: () => StorageRuntimeConfigValue
  useStorage?: (base: string) => StorageBackend
}

function getStorageRuntimeGlobals(): StorageRuntimeGlobals {
  return globalThis as StorageRuntimeGlobals
}

function encodeStorageSegment(segment: string): string {
  return encodeURIComponent(segment)
}

function encodeRfc3986ExtraCharacters(value: string): string {
  return value.replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

function encodeRfc3986(value: string): string {
  return encodeRfc3986ExtraCharacters(encodeURIComponent(value))
}

function decodeStorageSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function normalizeRelativePath(input: string): string {
  return input
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
}

function assertNoTraversal(path: string): void {
  if (normalizeRelativePath(path).split('/').includes('..')) {
    throw new Error('[Holo Storage] Storage paths must not contain ".." segments.')
  }
}

function normalizeKey(input: string): string {
  const normalized = normalizeRelativePath(input)
  if (normalized.split('/').includes('..')) {
    throw new Error('[Holo Storage] Storage paths must not contain ".." segments.')
  }

  return normalized
    .split('/')
    .filter(Boolean)
    .map(encodeStorageSegment)
    .join(':')
}

function normalizeDirectory(input = ''): string {
  const normalized = normalizeKey(input)
  return normalized ? `${normalized}:` : ''
}

function normalizeFileListRequest(request: StorageFileListRequest = {}): Required<StorageFileListRequest> {
  const limit = request.limit ?? 100
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new StoragePaginationError()
  const cursor = request.cursor ?? null
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || Buffer.byteLength(cursor, 'utf8') > 2048)) {
    throw new StoragePaginationError()
  }

  return Object.freeze({ cursor, limit })
}

function encodePaginationCursor(cursor: StoragePaginationCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  if (Buffer.byteLength(encoded, 'utf8') > 2048) throw new StoragePaginationError()
  return encoded
}

function decodePaginationCursor(value: string | null, disk: string, directory: string): string | null {
  if (value === null) return null

  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<StoragePaginationCursor>
    if (parsed.version !== 1 || parsed.disk !== disk || parsed.directory !== directory || typeof parsed.continuation !== 'string' || !parsed.continuation) {
      throw new StoragePaginationError()
    }
    return parsed.continuation
  } catch (error) {
    if (error instanceof StoragePaginationError) throw error
    throw new StoragePaginationError()
  }
}

function normalizeBackendPage(
  value: StorageFileListPage,
  directory: string,
  limit: number,
  requestCursor: string | null,
): StorageFileListPage {
  if (!value || !Array.isArray(value.paths) || (value.nextCursor !== null && typeof value.nextCursor !== 'string')) {
    throw new StoragePaginationError()
  }
  if (value.paths.length > limit || (value.nextCursor !== null && (!value.nextCursor || value.nextCursor === requestCursor))) {
    throw new StoragePaginationError()
  }

  const normalizedDirectory = normalizeRelativePath(directory)
  const prefix = normalizedDirectory ? `${normalizedDirectory}/` : ''
  const paths = value.paths.filter(path => !path.endsWith('$')).map(keyToPath)
  const seen = new Set<string>()
  for (const path of paths) {
    const hasControlCharacter = Array.from(path).some(character => {
      const code = character.charCodeAt(0)
      return code <= 31 || code === 127
    })
    if (!path || hasControlCharacter || path.split('/').includes('..') || (prefix && !path.startsWith(prefix)) || seen.has(path)) {
      throw new StoragePaginationError()
    }
    seen.add(path)
  }

  return Object.freeze({ nextCursor: value.nextCursor, paths: Object.freeze(paths) })
}

function keyToPath(key: string): string {
  return key
    .split(':')
    .map(decodeStorageSegment)
    .join('/')
}

function joinUrl(base: string, path: string): string {
  assertNoTraversal(path)
  const normalizedBase = base.replace(/\/+$/, '')
  const normalizedPath = normalizeRelativePath(path)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/')

  if (!normalizedPath) {
    return normalizedBase
  }

  const suffixMatch = /([?#].*)$/.exec(normalizedBase)
  const suffix = suffixMatch?.[1] ?? ''
  const baseWithoutSuffix = suffix
    ? normalizedBase.slice(0, -suffix.length)
    : normalizedBase

  return `${baseWithoutSuffix}/${normalizedPath}${suffix}`
}

function joinFilePath(base: string, path: string): string {
  assertNoTraversal(path)
  const normalizedBase = base.replace(/\/+$/, '')
  const normalizedPath = normalizeRelativePath(path)

  if (!normalizedPath) {
    return normalizedBase
  }

  return `${normalizedBase}/${normalizedPath}`
}

function joinUrlPath(basePath: string, path: string): string {
  const normalizedBase = basePath.replace(/\/+$/, '')
  const normalizedPath = normalizeRelativePath(path)

  if (!normalizedBase || normalizedBase === '/') {
    return normalizedPath ? `/${normalizedPath}` : '/'
  }

  if (!normalizedPath) {
    return normalizedBase
  }

  return `${normalizedBase}/${normalizedPath}`
}

function encodeS3Path(path: string): string {
  return normalizeRelativePath(path)
    .split('/')
    .filter(Boolean)
    .map(segment => encodeRfc3986(segment))
    .join('/')
}

function toUint8Array(value: RawStorageValue): Uint8Array | null {
  if (value === null) {
    return null
  }

  if (typeof value === 'string') {
    return new TextEncoder().encode(value)
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value)
  }

  return value
}

function asString(value: RawStorageValue): string | null {
  if (value === null) {
    return null
  }

  if (typeof value === 'string') {
    return value
  }

  const bytes = toUint8Array(value)
  return bytes ? new TextDecoder().decode(bytes) : null
}

async function normalizeContent(value: StorageContent): Promise<Exclude<RawStorageValue, null>> {
  if (typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer || Buffer.isBuffer(value)) {
    return value
  }

  return new Uint8Array(await value.arrayBuffer())
}

function resolveStorageRuntimeBindings(): StorageRuntimeBindings {
  const runtimeGlobals = getStorageRuntimeGlobals()
  const configuredBindings = storageRuntimeBindings ?? runtimeGlobals.__holoStorageRuntimeBindings__
  if (configuredBindings) {
    storageRuntimeBindings = configuredBindings
    return configuredBindings
  }

  if (typeof runtimeGlobals.useRuntimeConfig === 'function' && typeof runtimeGlobals.useStorage === 'function') {
    return {
      getRuntimeConfig: runtimeGlobals.useRuntimeConfig,
      getStorage: runtimeGlobals.useStorage,
    }
  }

  throw new Error(
    '[Holo Storage] Storage runtime is not configured. '
    + 'In Nuxt/Nitro this should be initialized automatically; in plain Node call configureStorageRuntime().',
  )
}

export function configureStorageRuntime(bindings?: StorageRuntimeBindings): void {
  storageRuntimeBindings = bindings
  const runtimeGlobals = getStorageRuntimeGlobals()
  if (bindings) {
    runtimeGlobals.__holoStorageRuntimeBindings__ = bindings
    return
  }

  delete runtimeGlobals.__holoStorageRuntimeBindings__
}

export function resetStorageRuntime(): void {
  storageRuntimeBindings = undefined
  delete getStorageRuntimeGlobals().__holoStorageRuntimeBindings__
}

function getRuntimeConfig(): HoloStorageRuntimeConfig & { appUrl?: string } {
  const runtimeConfig = resolveStorageRuntimeBindings().getRuntimeConfig()

  return {
    ...runtimeConfig.holoStorage,
    appUrl: runtimeConfig.holo?.appUrl,
  }
}

function resolveDiskConfig(diskName?: string): RuntimeDiskConfig {
  const config = getRuntimeConfig()
  const resolvedDiskName = diskName ?? config.defaultDisk

  if (!resolvedDiskName) {
    throw new Error(
      '[Holo Storage] No disk name provided and no default disk configured. '
      + 'Set STORAGE_DEFAULT_DISK or configure the default disk in config/storage.ts.',
    )
  }

  const disk = config.disks[resolvedDiskName]
  if (!disk) {
    throw new Error(
      `[Holo Storage] Disk "${resolvedDiskName}" is not configured. `
      + `Available disks: ${config.diskNames.join(', ')}`,
    )
  }

  return disk
}

function resolveBackend(diskName: string): StorageBackend {
  return resolveStorageRuntimeBindings().getStorage(`holo:${diskName}`)
}

function normalizeStreamChunkBytes(chunkBytes = 64 * 1024): number {
  if (!Number.isInteger(chunkBytes) || chunkBytes < 4 * 1024 || chunkBytes > 1024 * 1024) {
    throw new TypeError('[Holo Storage] Stream chunkBytes must be an integer from 4096 through 1048576.')
  }

  return chunkBytes
}

function resolvePublicLocalBaseUrl(
  disk: RuntimeDiskConfig,
  config: HoloStorageRuntimeConfig & { appUrl?: string },
): string {
  const baseUrl = joinUrl(config.appUrl ?? '', config.routePrefix)

  if (disk.name === 'public') {
    return baseUrl
  }

  return joinUrl(baseUrl, `${NAMED_PUBLIC_DISK_ROUTE_SEGMENT}/${disk.name}`)
}

function resolveBaseUrl(
  disk: RuntimeDiskConfig,
  config: HoloStorageRuntimeConfig & { appUrl?: string },
): string {
  if (disk.url) {
    return disk.url
  }

  if (disk.visibility === 'public' && disk.driver !== 's3') {
    return resolvePublicLocalBaseUrl(disk, config)
  }

  if (disk.driver === 's3' && disk.bucket && disk.endpoint) {
    const endpoint = new URL(disk.endpoint)

    if (disk.forcePathStyleEndpoint) {
      return joinUrl(endpoint.toString().replace(/\/+$/, ''), disk.bucket)
    }

    endpoint.host = `${disk.bucket}.${endpoint.host}`
    return endpoint.toString().replace(/\/+$/, '')
  }

  throw new Error(`[Holo Storage] Disk "${disk.name}" does not expose a public URL.`)
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function formatScopeDate(date: Date): string {
  return formatAmzDate(date).slice(0, 8)
}

function getSigningKey(secretAccessKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function resolveS3RequestTarget(disk: RuntimeDiskConfig, path: string): URL {
  if (!disk.bucket) {
    throw new Error(`[Holo Storage] Disk "${disk.name}" requires a bucket for s3 URLs.`)
  }

  if (!disk.endpoint) {
    throw new Error(`[Holo Storage] Disk "${disk.name}" requires an endpoint for s3 URLs.`)
  }

  assertNoTraversal(path)
  const endpoint = new URL(disk.endpoint)
  const normalizedPath = encodeS3Path(path)

  if (disk.forcePathStyleEndpoint) {
    endpoint.pathname = joinUrlPath(endpoint.pathname, `${disk.bucket}/${normalizedPath}`)
    return endpoint
  }

  endpoint.host = `${disk.bucket}.${endpoint.host}`
  endpoint.pathname = joinUrlPath(endpoint.pathname, normalizedPath)
  return endpoint
}

function canonicalizeUriPath(pathname: string): string {
  return encodeRfc3986ExtraCharacters(pathname)
}

function resolveExpiration(options?: TemporaryUrlOptions): number {
  if (typeof options?.expiresIn !== 'undefined') {
    if (!Number.isFinite(options.expiresIn)) {
      throw new TypeError('[Holo Storage] temporaryUrl() requires a finite expiresIn value.')
    }

    return Math.max(1, Math.min(604800, Math.floor(options.expiresIn)))
  }

  if (!options?.expiresAt) {
    return 300
  }

  const expiresAt = new Date(options.expiresAt!)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('[Holo Storage] temporaryUrl() requires a valid expiresAt value.')
  }

  const expiresIn = Math.floor((expiresAt.getTime() - Date.now()) / 1000)
  return Math.max(1, Math.min(604800, expiresIn))
}

export function createS3TemporaryUrl(
  disk: RuntimeDiskConfig,
  path: string,
  options?: TemporaryUrlOptions,
): string {
  if (disk.driver !== 's3') {
    throw new Error(`[Holo Storage] temporaryUrl() is only supported for s3-compatible disks. "${disk.name}" is ${disk.driver}.`)
  }

  if (!disk.accessKeyId || !disk.secretAccessKey || !disk.region) {
    throw new Error(`[Holo Storage] Disk "${disk.name}" requires accessKeyId, secretAccessKey, and region for temporaryUrl().`)
  }

  const requestUrl = resolveS3RequestTarget(disk, path)
  const now = new Date()
  const amzDate = formatAmzDate(now)
  const scopeDate = formatScopeDate(now)
  const expiresIn = resolveExpiration(options)
  const credentialScope = `${scopeDate}/${disk.region}/s3/aws4_request`

  requestUrl.searchParams.set('X-Amz-Algorithm', 'AWS4-HMAC-SHA256')
  requestUrl.searchParams.set('X-Amz-Credential', `${disk.accessKeyId}/${credentialScope}`)
  requestUrl.searchParams.set('X-Amz-Date', amzDate)
  requestUrl.searchParams.set('X-Amz-Expires', String(expiresIn))
  requestUrl.searchParams.set('X-Amz-SignedHeaders', 'host')

  if (disk.sessionToken) {
    requestUrl.searchParams.set('X-Amz-Security-Token', disk.sessionToken)
  }

  const sortedEntries = Array.from(requestUrl.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) {
        return leftValue.localeCompare(rightValue)
      }

      return leftKey.localeCompare(rightKey)
    })

  const canonicalQueryString = sortedEntries
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .join('&')

  const canonicalRequest = [
    'GET',
    canonicalizeUriPath(requestUrl.pathname),
    canonicalQueryString,
    `host:${requestUrl.host}`,
    '',
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n')

  const signature = createHmac('sha256', getSigningKey(disk.secretAccessKey, scopeDate, disk.region))
    .update(stringToSign)
    .digest('hex')

  requestUrl.searchParams.set('X-Amz-Signature', signature)
  return requestUrl.toString()
}

function createDisk(diskName?: string): StorageInstance {
  const config = getRuntimeConfig()
  const disk = resolveDiskConfig(diskName)
  const backend = resolveBackend(disk.name)

  const facade: StorageDisk = {
    name: disk.name,
    driver: disk.driver,
    visibility: disk.visibility,

    async put(path, contents) {
      await backend.setItemRaw(normalizeKey(path), await normalizeContent(contents))
      return true
    },

    async putJson(path, value) {
      await backend.setItemRaw(normalizeKey(path), JSON.stringify(value))
      return true
    },

    async get(path) {
      return asString(await backend.getItemRaw(normalizeKey(path)))
    },

    async getBytes(path) {
      return toUint8Array(await backend.getItemRaw(normalizeKey(path)))
    },

    async readStream(path, options = {}) {
      if (!backend.getItemStream) {
        throw new StorageStreamingUnsupportedError()
      }

      return backend.getItemStream(normalizeKey(path), {
        chunkBytes: normalizeStreamChunkBytes(options.chunkBytes),
      })
    },

    async writeStream(path, source, options = {}) {
      if (!backend.setItemStream) {
        throw new StorageStreamingUnsupportedError()
      }

      try {
        await backend.setItemStream(normalizeKey(path), source, {
          overwrite: options.overwrite ?? true,
        })
        return true
      } catch (error) {
        if (error instanceof Error && error.name === 'StorageDestinationExistsError') {
          return false
        }
        throw error
      }
    },

    async json<T>(path: string) {
      const value = await this.get(path)
      return value ? JSON.parse(value) as T : null
    },

    async exists(path) {
      return backend.hasItem(normalizeKey(path))
    },

    async missing(path) {
      return !(await this.exists(path))
    },

    async delete(path) {
      const paths = Array.isArray(path) ? path : [path]
      const keys = paths.map(normalizeKey)
      await Promise.all(keys.map(key => backend.removeItem(key)))
      return true
    },

    async copy(from, to) {
      const fromKey = normalizeKey(from)
      const toKey = normalizeKey(to)
      const value = await backend.getItemRaw(fromKey)
      if (value === null) {
        return false
      }

      await backend.setItemRaw(toKey, value)
      return true
    },

    async move(from, to) {
      const fromKey = normalizeKey(from)
      const toKey = normalizeKey(to)
      const value = await backend.getItemRaw(fromKey)
      if (value === null) {
        return false
      }

      await backend.setItemRaw(toKey, value)
      await backend.removeItem(fromKey)
      return true
    },

    async listFiles(directory = '', request = {}) {
      const normalizedDirectory = normalizeRelativePath(directory)
      normalizeDirectory(normalizedDirectory)
      const normalizedRequest = normalizeFileListRequest(request)
      const continuation = decodePaginationCursor(normalizedRequest.cursor, disk.name, normalizedDirectory)
      const getKeysPage = backend.getKeysPage?.bind(backend)
      if (!getKeysPage) throw new StoragePaginationError()
      const backendPage = await getKeysPage(normalizeDirectory(normalizedDirectory) || undefined, {
        cursor: continuation,
        limit: normalizedRequest.limit,
      }).catch(() => {
        throw new StoragePaginationError()
      })
      const page = normalizeBackendPage(backendPage, normalizedDirectory, normalizedRequest.limit, continuation)

      return Object.freeze({
        nextCursor: page.nextCursor
          ? encodePaginationCursor({
              continuation: page.nextCursor,
              directory: normalizedDirectory,
              disk: disk.name,
              version: 1,
            })
          : null,
        paths: page.paths,
      })
    },

    path(path) {
      if (disk.driver === 's3') {
        if (!disk.bucket) {
          throw new Error(`[Holo Storage] Disk "${disk.name}" requires a bucket for s3 paths.`)
        }

        assertNoTraversal(path)
        return `s3://${disk.bucket}/${normalizeRelativePath(path)}`
      }

      return joinFilePath(disk.root ?? './storage/app', path)
    },

    url(path) {
      if (disk.visibility !== 'public') {
        throw new Error(`[Holo Storage] Disk "${disk.name}" is private. Use get() or temporaryUrl() instead.`)
      }

      return joinUrl(resolveBaseUrl(disk, config), path)
    },

    temporaryUrl(path, options) {
      if (disk.driver !== 's3') {
        throw new Error(`[Holo Storage] temporaryUrl() is currently supported only for s3-compatible disks. "${disk.name}" is ${disk.driver}.`)
      }

      return createS3TemporaryUrl(disk, path, options)
    },
  }

  return Object.assign(backend, facade)
}

export function useStorage(diskName?: string): StorageInstance {
  return createDisk(diskName)
}

export const Storage = {
  disk(diskName?: string): StorageDisk {
    return createDisk(diskName)
  },
  put(path: string, contents: StorageContent): Promise<boolean> {
    return createDisk().put(path, contents)
  },
  putJson(path: string, value: unknown): Promise<boolean> {
    return createDisk().putJson(path, value)
  },
  get(path: string): Promise<string | null> {
    return createDisk().get(path)
  },
  getBytes(path: string): Promise<Uint8Array | null> {
    return createDisk().getBytes(path)
  },
  readStream(path: string, options?: StorageStreamReadOptions): Promise<StorageByteStream | null> {
    return createDisk().readStream(path, options)
  },
  writeStream(path: string, source: StorageByteStream, options?: StorageStreamWriteOptions): Promise<boolean> {
    return createDisk().writeStream(path, source, options)
  },
  json<T>(path: string): Promise<T | null> {
    return createDisk().json<T>(path)
  },
  exists(path: string): Promise<boolean> {
    return createDisk().exists(path)
  },
  missing(path: string): Promise<boolean> {
    return createDisk().missing(path)
  },
  delete(path: string | string[]): Promise<boolean> {
    return createDisk().delete(path)
  },
  copy(from: string, to: string): Promise<boolean> {
    return createDisk().copy(from, to)
  },
  move(from: string, to: string): Promise<boolean> {
    return createDisk().move(from, to)
  },
  listFiles(directory?: string, request?: StorageFileListRequest): Promise<StorageFileListPage> {
    return createDisk().listFiles(directory, request)
  },
  path(path: string): string {
    return createDisk().path(path)
  },
  url(path: string): string {
    return createDisk().url(path)
  },
  temporaryUrl(path: string, options?: TemporaryUrlOptions): string {
    return createDisk().temporaryUrl(path, options)
  },
}
