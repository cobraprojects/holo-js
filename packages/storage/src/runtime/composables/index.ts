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

export interface TemporaryUrlOptions {
  expiresAt?: Date | number | string
  expiresIn?: number
}

export interface StorageDisk {
  readonly name: string
  readonly driver: RuntimeDiskConfig['driver']
  readonly visibility: StorageVisibility
  put(path: string, contents: StorageContent): Promise<boolean>
  putJson(path: string, value: unknown): Promise<boolean>
  get(path: string): Promise<string | null>
  getBytes(path: string): Promise<Uint8Array | null>
  json<T>(path: string): Promise<T | null>
  exists(path: string): Promise<boolean>
  missing(path: string): Promise<boolean>
  delete(path: string | string[]): Promise<boolean>
  copy(from: string, to: string): Promise<boolean>
  move(from: string, to: string): Promise<boolean>
  files(directory?: string): Promise<string[]>
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

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
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
  return normalizeRelativePath(input)
    .split('/')
    .filter(Boolean)
    .map(encodeStorageSegment)
    .join(':')
}

function normalizeDirectory(input = ''): string {
  const normalized = normalizeKey(input)
  return normalized ? `${normalized}:` : ''
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
  return pathname.replace(/[!'()*]/g, (character) => {
    return `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  })
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
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
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
      await Promise.all(paths.map(item => backend.removeItem(normalizeKey(item))))
      return true
    },

    async copy(from, to) {
      const value = await backend.getItemRaw(normalizeKey(from))
      if (value === null) {
        return false
      }

      await backend.setItemRaw(normalizeKey(to), value)
      return true
    },

    async move(from, to) {
      const copied = await this.copy(from, to)
      if (!copied) {
        return false
      }

      await backend.removeItem(normalizeKey(from))
      return true
    },

    async files(directory = '') {
      const keys = await backend.getKeys(normalizeDirectory(directory))
      return keys
        .filter(key => !key.endsWith('$'))
        .map(keyToPath)
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
  files(directory?: string): Promise<string[]> {
    return createDisk().files(directory)
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
