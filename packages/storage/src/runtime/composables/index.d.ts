type StorageRuntimeDriver = 'local' | 'public' | 's3'
type StorageVisibility = 'private' | 'public'

interface RuntimeDiskConfig {
  name: string
  driver: StorageRuntimeDriver
  visibility: StorageVisibility
  root?: string
  url?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
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

export declare class StorageStreamingUnsupportedError extends Error {
  constructor()
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

export declare class StoragePaginationError extends Error {
  constructor()
}

export interface StorageBackend {
  getItem<T = unknown>(key: string): Promise<T | null>
  getItemRaw(key: string): Promise<string | Uint8Array | ArrayBuffer | Buffer | null>
  setItem(key: string, value: unknown): Promise<void>
  setItemRaw(key: string, value: string | Uint8Array | ArrayBuffer | Buffer): Promise<void>
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
  getRuntimeConfig(): {
    holoStorage: {
      defaultDisk: string | undefined
      diskNames: string[]
      routePrefix: string
      disks: Record<string, RuntimeDiskConfig>
    }
    holo?: { appUrl?: string }
  }
  getStorage(base: string): StorageBackend
}

export declare function createS3TemporaryUrl(
  disk: RuntimeDiskConfig,
  path: string,
  options?: TemporaryUrlOptions,
): string

export declare function configureStorageRuntime(bindings?: StorageRuntimeBindings): void

export declare function resetStorageRuntime(): void

export declare function useStorage(diskName?: string): StorageInstance

export declare const Storage: {
  disk(diskName?: string): StorageDisk
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
