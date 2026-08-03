import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { LoadedHoloConfig, HoloConfigMap } from '@holo-js/config'
import { importOptionalRuntimeModule } from './runtimeModule'

type StorageBackend = {
  getItem<T = unknown>(key: string): Promise<T | null>
  getItemRaw(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  setItemRaw(key: string, value: string | Uint8Array | ArrayBuffer | Buffer): Promise<void>
  hasItem(key: string): Promise<boolean>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
  getKeysPage?(base: string | undefined, request: {
    readonly cursor: string | null
    readonly limit: number
  }): Promise<{
    readonly nextCursor: string | null
    readonly paths: readonly string[]
  }>
  getItemStream?(key: string, options: {
    readonly chunkBytes?: number
  }): Promise<AsyncIterable<Uint8Array> | null>
  setItemStream?(key: string, source: AsyncIterable<Uint8Array>, options: {
    readonly overwrite: boolean
  }): Promise<void>
  getMeta<T = unknown>(key: string): Promise<T | null>
  setMeta?(key: string, value: unknown): Promise<void>
  removeMeta?(key: string): Promise<void>
  clear(base?: string): Promise<void>
}

type RuntimeDiskConfig = {
  name: string
  driver: 'local' | 'public' | 's3'
  visibility: 'private' | 'public'
  root?: string
  bucket?: string
  region?: string
  endpoint?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  forcePathStyleEndpoint?: boolean
}

type StorageModule = {
  normalizeModuleOptions(options: {
    defaultDisk?: string
    routePrefix?: string
    disks?: Record<string, unknown>
  }): {
    defaultDisk: string | undefined
    routePrefix: string
    disks: Record<string, RuntimeDiskConfig>
  }
}

type StorageRuntimeModule = {
  configureStorageRuntime(options: {
    getRuntimeConfig(): {
      holoStorage: unknown
      holo: { appUrl: string }
    }
    getStorage(base: string): StorageBackend | Promise<StorageBackend>
  }): void
  resetStorageRuntime(): void
}

type StorageS3Module = {
  default(options: {
    bucket?: string
    region?: string
    endpoint?: string
    accessKeyId?: string
    secretAccessKey?: string
    sessionToken?: string
    forcePathStyleEndpoint?: boolean
  }): StorageBackend
}

async function importOptionalModule<TModule>(specifier: string, projectRoot?: string): Promise<TModule | undefined> {
  return importOptionalRuntimeModule<TModule>(specifier, projectRoot ? { projectRoot } : {})
}

export function resolveStorageKeyPath(root: string, key: string): string {
  if (isAbsolute(key) || win32.isAbsolute(key)) {
    throw new Error('[Holo Storage] Storage paths must not be absolute.')
  }

  const segments = key
    .replace(/\\/g, '/')
    .split(':')
    .flatMap(segment => segment.split('/'))
    .filter(Boolean)

  if (segments.includes('..')) {
    throw new Error('[Holo Storage] Storage paths must not contain ".." segments.')
  }

  const rootPath = resolve(root)
  const targetPath = resolve(rootPath, ...segments)
  const relativeTarget = relative(rootPath, targetPath)

  /* v8 ignore next -- cross-root relative paths are only reachable on platform-specific path edge cases */
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
  }

  return targetPath
}

async function resolveStorageReadPath(root: string, key: string): Promise<string | null> {
  const rootPath = resolve(root)
  const targetPath = resolveStorageKeyPath(rootPath, key)
  const resolvedRoot = await resolveExistingRealPath(rootPath)
  if (!resolvedRoot) return null
  const resolvedTarget = await resolveExistingRealPath(targetPath)
  if (!resolvedTarget) return null
  const relativeTarget = relative(resolvedRoot, resolvedTarget)
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
    throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
  }
  return resolvedTarget
}

async function resolveExistingRealPath(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function storagePathIsInside(root: string, target: string): boolean {
  const relativeTarget = relative(root, target)
  return relativeTarget === '' || (!relativeTarget.startsWith(`..${sep}`) && relativeTarget !== '..' && !isAbsolute(relativeTarget))
}

async function resolveStorageWritePath(root: string, key: string): Promise<string> {
  const rootPath = resolve(root)
  const unresolvedTarget = resolveStorageKeyPath(rootPath, key)
  await mkdir(rootPath, { recursive: true })
  const resolvedRoot = await realpath(rootPath)
  const targetPath = resolve(resolvedRoot, relative(rootPath, unresolvedTarget))
  if (!storagePathIsInside(resolvedRoot, targetPath)) {
    throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
  }

  const parentPath = dirname(targetPath)
  const parentSegments = relative(resolvedRoot, parentPath).split(sep).filter(Boolean)
  let currentPath = resolvedRoot
  for (const segment of parentSegments) {
    currentPath = join(currentPath, segment)
    try {
      await mkdir(currentPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const pathStats = await lstat(currentPath)
    if (!pathStats.isDirectory() || pathStats.isSymbolicLink()) {
      throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
    }
  }

  return targetPath
}

type StreamWriteHandle = {
  write(buffer: Uint8Array, offset: number, length: number): Promise<{ readonly bytesWritten: number }>
}

async function writeCompleteChunk(handle: StreamWriteHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (bytesWritten < 1) throw new Error('[Holo Storage] Stream write made no progress.')
    offset += bytesWritten
  }
}

function createFileStorageBackend(root: string): StorageBackend {
  const normalizeChunkBytes = (value = 64 * 1024): number => {
    if (!Number.isInteger(value) || value < 4 * 1024 || value > 1024 * 1024) {
      throw new Error('[Holo Storage] Stream chunkBytes must be an integer from 4096 through 1048576.')
    }
    return value
  }
  async function listStorageKeys(currentRoot: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(currentRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const keys: string[] = []

    for (const entry of entries) {
      const nextPrefix = prefix ? `${prefix}:${entry.name}` : entry.name
      const entryPath = join(currentRoot, entry.name)

      if (entry.isDirectory()) {
        keys.push(...await listStorageKeys(entryPath, nextPrefix))
        continue
      }

      if (entry.isFile()) {
        keys.push(nextPrefix)
      }
    }

    return keys
  }

  async function listStorageKeysPage(
    currentRoot: string,
    prefix: string,
    cursor: string | null,
    limit: number,
  ): Promise<{ readonly nextCursor: string | null, readonly paths: readonly string[] }> {
    const retained: string[] = []
    const insert = (key: string): void => {
      let low = 0
      let high = retained.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if ((retained[middle] ?? '') < key) low = middle + 1
        else high = middle
      }
      retained.splice(low, 0, key)
      if (retained.length > limit + 1) retained.pop()
    }
    const visit = async (directory: string, keyPrefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      for (const entry of entries) {
        const key = keyPrefix ? `${keyPrefix}:${entry.name}` : entry.name
        const entryPath = join(directory, entry.name)
        if (entry.isDirectory()) await visit(entryPath, key)
        else if (entry.isFile() && (!cursor || key > cursor)) insert(key)
      }
    }

    await visit(currentRoot, prefix)
    const page = retained.slice(0, limit)
    return Object.freeze({
      nextCursor: retained.length > limit ? page.at(-1) ?? null : null,
      paths: Object.freeze(page),
    })
  }

  return {
    async getItem<T = unknown>(key: string): Promise<T | null> {
      const value = await this.getItemRaw(key)
      if (value === null) {
        return null
      }

      /* v8 ignore start -- equivalent byte-conversion paths are already covered in the storage package itself */
      const serialized = Buffer.isBuffer(value)
        ? value.toString('utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : value instanceof ArrayBuffer
            ? Buffer.from(value).toString('utf8')
            : String(value)
      /* v8 ignore stop */

      return JSON.parse(serialized) as T
    },

    async getItemRaw(key: string) {
      const targetPath = await resolveStorageReadPath(root, key)
      if (!targetPath) return null
      try {
        return await readFile(targetPath)
      } catch {
        return null
      }
    },

    async getItemStream(key, options) {
      const targetPath = await resolveStorageReadPath(root, key)
      if (!targetPath) return null
      const chunkBytes = normalizeChunkBytes(options.chunkBytes)

      return (async function* (): AsyncGenerator<Uint8Array> {
        const handle = await open(targetPath, 'r')
        try {
          while (true) {
            const buffer = new Uint8Array(chunkBytes)
            const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null)
            if (bytesRead === 0) return
            yield buffer.subarray(0, bytesRead)
          }
        } finally {
          await handle.close()
        }
      })()
    },

    async setItem(key: string, value: unknown): Promise<void> {
      await this.setItemRaw(key, JSON.stringify(value))
    },

    async setItemRaw(key: string, value: string | Uint8Array | ArrayBuffer | Buffer): Promise<void> {
      const targetPath = await resolveStorageWritePath(root, key)
      const temporaryPath = `${targetPath}.holo-write-${randomUUID()}.tmp`
      const handle = await open(temporaryPath, 'wx')
      try {
        const contents = typeof value === 'string'
          ? new TextEncoder().encode(value)
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value
        await writeCompleteChunk(handle, contents)
        await handle.sync()
        await handle.close()
        await rename(temporaryPath, targetPath)
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    },

    async setItemStream(key, source, options): Promise<void> {
      const targetPath = await resolveStorageWritePath(root, key)
      const temporaryPath = `${targetPath}.holo-stream-${randomUUID()}.tmp`
      const handle = await open(temporaryPath, 'wx')

      try {
        for await (const chunk of source) {
          await writeCompleteChunk(handle, chunk)
        }
        await handle.sync()
        await handle.close()

        if (options.overwrite) {
          await rename(temporaryPath, targetPath)
          return
        }

        try {
          await link(temporaryPath, targetPath)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            const destinationExists = new Error('[Holo Storage] Stream destination already exists.')
            destinationExists.name = 'StorageDestinationExistsError'
            throw destinationExists
          }
          throw error
        } finally {
          await unlink(temporaryPath).catch(() => undefined)
        }
      } catch (error) {
        await handle.close().catch(() => undefined)
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        throw error
      }
    },

    async hasItem(key: string): Promise<boolean> {
      return (await this.getItemRaw(key)) !== null
    },

    async removeItem(key: string): Promise<void> {
      const targetPath = resolveStorageKeyPath(root, key)
      await rm(targetPath, { force: true })
      await rm(`${targetPath}$`, { force: true })
    },

    async getKeys(base = ''): Promise<string[]> {
      const prefix = base.replace(/:+$/, '')
      const keys = await listStorageKeys(root)
      return keys.filter((key) => {
        if (!prefix) {
          return true
        }

        return key === prefix || key.startsWith(`${prefix}:`)
      })
    },

    async getKeysPage(base = '', request) {
      const prefix = base.replace(/:+$/, '')
      const targetRoot = await resolveStorageReadPath(root, prefix)
      if (!targetRoot) return { nextCursor: null, paths: [] }
      return listStorageKeysPage(targetRoot, prefix, request.cursor, request.limit)
    },

    async getMeta<T = unknown>(key: string): Promise<T | null> {
      return this.getItem<T>(`${key}$`)
    },

    async setMeta(key: string, value: unknown): Promise<void> {
      await this.setItem(`${key}$`, value)
    },

    async removeMeta(key: string): Promise<void> {
      await this.removeItem(`${key}$`)
    },

    async clear(base = ''): Promise<void> {
      const prefix = base.replace(/:+$/, '')
      const targetPath = prefix ? resolveStorageKeyPath(root, prefix) : root
      await rm(targetPath, { recursive: true, force: true })
      if (!prefix) {
        await mkdir(root, { recursive: true })
      }
    },
  }
}

/* v8 ignore start -- S3 backend behavior is covered in the split storage-s3 package */
async function createS3StorageBackend(projectRoot: string, disk: RuntimeDiskConfig): Promise<StorageBackend> {
  const storageS3 = await importOptionalModule<StorageS3Module>('@holo-js/storage-s3', projectRoot)
  if (!storageS3) {
    throw new Error('[@holo-js/core] Storage config references an s3 disk but @holo-js/storage-s3 is not installed.')
  }

  return storageS3.default({
    bucket: disk.bucket,
    region: disk.region,
    endpoint: disk.endpoint,
    accessKeyId: disk.accessKeyId,
    secretAccessKey: disk.secretAccessKey,
    sessionToken: disk.sessionToken,
    forcePathStyleEndpoint: disk.forcePathStyleEndpoint,
  })
}
/* v8 ignore stop */

export async function configurePlainNodeStorageRuntime<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
): Promise<void> {
  const storageModule = await storageRuntimeInternals.importOptionalModule<StorageModule>('@holo-js/storage')
  const storageRuntime = await storageRuntimeInternals.importOptionalModule<StorageRuntimeModule>('@holo-js/storage/runtime')
  /* v8 ignore next 3 -- exercised only when the optional package is absent outside the monorepo test graph */
  if (!storageModule || !storageRuntime) {
    throw new Error('[@holo-js/core] Storage is configured but @holo-js/storage is not installed.')
  }

  const normalizedStorage = storageModule.normalizeModuleOptions({
    defaultDisk: loadedConfig.storage.defaultDisk,
    routePrefix: loadedConfig.storage.routePrefix,
    disks: loadedConfig.storage.disks,
  })
  const backends = new Map<string, StorageBackend>()

  for (const [diskName, disk] of Object.entries(normalizedStorage.disks)) {
    const backend = disk.driver === 's3'
      ? await createS3StorageBackend(projectRoot, disk)
      : createFileStorageBackend(resolve(projectRoot, disk.root as string))
    backends.set(diskName, backend)
  }

  storageRuntime.configureStorageRuntime({
    getRuntimeConfig: () => ({
      holoStorage: normalizedStorage,
      holo: { appUrl: loadedConfig.app.url },
    }),
    getStorage: (base: string) => {
      const diskName = base.replace(/^holo:/, '')
      const backend = backends.get(diskName)
      /* v8 ignore start -- the public storage runtime rejects unknown disks before reaching this internal guard */
      if (!backend) {
        throw new Error(`[Holo Storage] Disk "${diskName}" backend is not configured.`)
      }
      /* v8 ignore stop */

      return backend
    },
  })
}

export async function resetOptionalStorageRuntime(): Promise<void> {
  const storageRuntime = await storageRuntimeInternals.importOptionalModule<StorageRuntimeModule>('@holo-js/storage/runtime')
  storageRuntime?.resetStorageRuntime()
}

export const storageRuntimeInternals = {
  createFileStorageBackend,
  importOptionalModule,
  writeCompleteChunk,
}
import type {} from '@holo-js/storage/config'
