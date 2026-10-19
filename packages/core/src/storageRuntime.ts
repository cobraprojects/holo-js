import { randomUUID } from 'node:crypto'
import { type Dirent, openAsBlob } from 'node:fs'
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import type { LoadedHoloConfig, HoloConfigMap } from '@holo-js/config'
import type * as StorageFeature from '@holo-js/storage'
import type { RuntimeDiskConfig } from '@holo-js/storage'
import type * as StorageRuntimeFeature from '@holo-js/storage/runtime'
import type { StorageBackend } from '@holo-js/storage/runtime'
import { importOptionalRuntimeModule } from './runtimeModule'

type StorageModule = typeof StorageFeature
type StorageRuntimeModule = typeof StorageRuntimeFeature
type StorageS3Module = {
  default(options: Pick<RuntimeDiskConfig, 'bucket' | 'region' | 'endpoint' | 'accessKeyId' | 'secretAccessKey' | 'sessionToken' | 'forcePathStyleEndpoint'>): StorageBackend
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
    .map(decodeStorageKeySegment)

  if (segments.includes('..')) {
    throw new Error('[Holo Storage] Storage paths must not contain ".." segments.')
  }

  if (segments.some(segment => segment === '.' || /[\\/]/u.test(segment) || segment.includes('\u0000') || (process.platform === 'win32' && segment.includes(':')))) {
    throw new Error('[Holo Storage] Storage path segments must be file or folder names.')
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

function decodeStorageKeySegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function encodeStorageKeySegment(name: string): string {
  return name.replace(/[%:$]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function storageKeySegmentFromEntry(entry: Dirent): string {
  return entry.isFile() && entry.name.endsWith('$')
    ? `${encodeStorageKeySegment(entry.name.slice(0, -1))}$`
    : encodeStorageKeySegment(entry.name)
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
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
}

async function resolveStorageDeletePath(root: string, key: string): Promise<string | null> {
  const rootPath = resolve(root)
  const targetPath = resolveStorageKeyPath(rootPath, key)
  const resolvedRoot = await resolveExistingRealPath(rootPath)
  if (!resolvedRoot) return null
  const resolvedParent = await resolveExistingRealPath(dirname(targetPath))
  if (!resolvedParent) return null
  const resolvedTarget = await resolveExistingRealPath(targetPath)
  if (
    targetPath === rootPath
    || !storagePathIsInside(resolvedRoot, resolvedParent)
    || (resolvedTarget && !storagePathIsInside(resolvedRoot, resolvedTarget))
  ) {
    throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
  }
  return join(resolvedParent, basename(targetPath))
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

export interface DecodedStorageName {
  readonly from: string
  readonly to: string
}

export interface SkippedStorageName {
  readonly path: string
  readonly reason: string
}

export interface StorageNameDecodingResult {
  readonly renamed: readonly DecodedStorageName[]
  readonly skipped: readonly SkippedStorageName[]
}

function decodeLegacyStorageName(name: string): string | null {
  if (!name.includes('%')) return null
  try {
    const decoded = decodeURIComponent(name)
    return decoded !== name && encodeURIComponent(decoded) === name ? decoded : null
  } catch {
    return null
  }
}

function decodeLegacyStorageEntryName(entry: Dirent): string | null {
  if (entry.isFile() && entry.name.endsWith('$')) {
    const decoded = decodeLegacyStorageName(entry.name.slice(0, -1))
    return decoded === null ? null : `${decoded}$`
  }

  return decodeLegacyStorageName(entry.name)
}

const WINDOWS_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
])

function windowsStorageNameProblem(name: string): string | null {
  const hasControlCharacter = Array.from(name).some(character => character.charCodeAt(0) < 32)
  if (hasControlCharacter || /[<>:"|?*]/u.test(name)) {
    return 'Windows file names cannot contain < > : " | ? * or control characters'
  }
  if (/[. ]$/u.test(name)) {
    return 'Windows file names cannot end with a dot or a space'
  }
  const baseName = (name.split('.', 1)[0] ?? '').replace(/ +$/u, '').toUpperCase()
  if (WINDOWS_DEVICE_NAMES.has(baseName)) {
    return 'Windows reserves this device name'
  }

  return null
}

function storageNameDecodingSkipReason(entry: Dirent, decoded: string, platform: NodeJS.Platform): string | null {
  if (decoded === '.' || decoded === '..' || /[\\/]/u.test(decoded) || decoded.includes('\u0000')) {
    return 'the decoded name is not a valid file name'
  }
  if (platform === 'win32') {
    const windowsProblem = windowsStorageNameProblem(decoded)
    if (windowsProblem) return windowsProblem
  }
  const isMetadata = entry.isFile() && entry.name.endsWith('$')
  if (!isMetadata && entry.isFile() && decoded.endsWith('$')) {
    return 'local file names ending in "$" are reserved for metadata'
  }
  if (decodeLegacyStorageName(isMetadata ? decoded.slice(0, -1) : decoded) !== null) {
    return 'the decoded name still looks URL-encoded, so rename it by hand'
  }

  return null
}

async function storagePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function decodeLocalStorageNames(
  root: string,
  options: { readonly platform?: NodeJS.Platform } = {},
): Promise<StorageNameDecodingResult> {
  const platform = options.platform ?? process.platform
  const renamed: DecodedStorageName[] = []
  const skipped: SkippedStorageName[] = []
  const resolvedRoot = await resolveExistingRealPath(resolve(root))
  if (!resolvedRoot) return { renamed, skipped }

  const visit = async (directory: string, segments: readonly string[]): Promise<void> => {
    const resolvedDirectory = await realpath(directory)
    if (!storagePathIsInside(resolvedRoot, resolvedDirectory)) {
      throw new Error('[Holo Storage] Storage paths must stay inside the configured disk root.')
    }

    const entries = (await readdir(resolvedDirectory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() || entry.isFile() || entry.isSymbolicLink())
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    const symbolicLinkNames = new Set(entries.filter(entry => entry.isSymbolicLink()).map(entry => entry.name))
    const skippedNames = new Set<string>()
    for (const entry of entries) {
      let name = entry.name
      if (entry.isSymbolicLink()) {
        if (decodeLegacyStorageName(entry.name.endsWith('$') ? entry.name.slice(0, -1) : entry.name) !== null) {
          skippedNames.add(entry.name)
          skipped.push({ path: [...segments, entry.name].join('/'), reason: 'symbolic links are never followed' })
        }
        continue
      }

      const decoded = decodeLegacyStorageEntryName(entry)
      if (decoded !== null) {
        const from = [...segments, entry.name].join('/')
        const to = [...segments, decoded].join('/')
        const isMetadata = entry.isFile() && entry.name.endsWith('$')
        const reason = storageNameDecodingSkipReason(entry, decoded, platform)
          ?? (isMetadata && symbolicLinkNames.has(entry.name.slice(0, -1)) ? 'its file is a symbolic link' : null)
          ?? (!isMetadata && symbolicLinkNames.has(`${entry.name}$`) ? 'its metadata is a symbolic link' : null)
          ?? (isMetadata && skippedNames.has(entry.name.slice(0, -1)) ? 'its file was skipped' : null)
          ?? (await storagePathExists(join(resolvedDirectory, decoded)) ? `"${to}" already exists` : null)
        if (reason) {
          skippedNames.add(entry.name)
          skipped.push({ path: from, reason })
        } else {
          try {
            await rename(join(resolvedDirectory, entry.name), join(resolvedDirectory, decoded))
            renamed.push({ from, to })
            name = decoded
          } catch (error) {
            skippedNames.add(entry.name)
            skipped.push({ path: from, reason: `rename failed: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}` })
          }
        }
      }
      if (entry.isDirectory()) await visit(join(resolvedDirectory, name), [...segments, name])
    }
  }

  await visit(resolvedRoot, [])
  return { renamed, skipped }
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
      const segment = storageKeySegmentFromEntry(entry)
      const nextPrefix = prefix ? `${prefix}:${segment}` : segment
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
    const collected: string[] = []
    const visit = async (directory: string, keyPrefix: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      const ordered = entries
        .filter(entry => entry.isDirectory() || entry.isFile())
        .map((entry) => {
          const segment = storageKeySegmentFromEntry(entry)
          const key = keyPrefix ? `${keyPrefix}:${segment}` : segment
          return { entry, key, order: entry.isDirectory() ? `${key}:` : key }
        })
        .sort((left, right) => left.order < right.order ? -1 : left.order > right.order ? 1 : 0)
      for (const { entry, key, order } of ordered) {
        if (collected.length > limit) return
        if (entry.isDirectory()) {
          if (!cursor || cursor < order || cursor.startsWith(order)) await visit(join(directory, entry.name), key)
        } else if (!cursor || key > cursor) {
          collected.push(key)
        }
      }
    }

    await visit(currentRoot, prefix)
    const page = collected.slice(0, limit)
    return Object.freeze({
      nextCursor: collected.length > limit ? page.at(-1) ?? null : null,
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
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    },

    async getItemBlob(key) {
      const targetPath = await resolveStorageReadPath(root, key)
      if (!targetPath) return null
      return openAsBlob(targetPath)
    },

    async getItemStat(key, request) {
      try {
        const targetPath = await resolveStorageReadPath(root, key)
        if (!targetPath) return null
        const file = await open(targetPath, 'r')
        try {
          const metadata = await file.stat()
          if (!metadata.isFile()) return null
          const sample = new Uint8Array(Math.min(request.sampleBytes, metadata.size))
          const { bytesRead } = await file.read(sample, 0, sample.length, 0)
          return { size: metadata.size, sample: sample.subarray(0, bytesRead) }
        } finally {
          await file.close()
        }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return null
        throw error
      }
    },

    async getItemStream(key, options) {
      options.signal?.throwIfAborted()
      const targetPath = await resolveStorageReadPath(root, key)
      if (!targetPath) return null
      const chunkBytes = normalizeChunkBytes(options.chunkBytes)

      return (async function* (): AsyncGenerator<Uint8Array> {
        const handle = await open(targetPath, 'r')
        try {
          while (true) {
            options.signal?.throwIfAborted()
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
      const targetPath = await resolveStorageReadPath(root, key)
      if (!targetPath) return false
      try {
        return (await stat(targetPath)).isFile()
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    },

    async removeItem(key: string): Promise<void> {
      const targetPaths = [await resolveStorageDeletePath(root, key), await resolveStorageDeletePath(root, `${key}$`)]
      for (const targetPath of targetPaths) {
        if (targetPath) await rm(targetPath, { force: true })
      }
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
      if (prefix) {
        const targetPath = await resolveStorageDeletePath(root, prefix)
        if (targetPath) await rm(targetPath, { recursive: true, force: true })
        return
      }

      const resolvedRoot = await resolveExistingRealPath(resolve(root))
      if (!resolvedRoot) {
        await mkdir(root, { recursive: true })
        return
      }
      const entries = await readdir(resolvedRoot)
      await Promise.all(entries.map(entry => rm(join(resolvedRoot, entry), { recursive: true, force: true })))
    },
  }
}

/* v8 ignore start -- S3 backend behavior is covered in the split storage-s3 package */
async function createS3StorageBackendFactory(projectRoot: string, disk: RuntimeDiskConfig): Promise<() => StorageBackend> {
  const storageS3 = await importOptionalModule<StorageS3Module>('@holo-js/storage-s3', projectRoot)
  if (!storageS3) {
    throw new Error('[@holo-js/core] Storage config references an s3 disk but @holo-js/storage-s3 is not installed.')
  }

  return () => storageS3.default({
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
  const runtimeStorage = {
    ...normalizedStorage,
    disks: Object.fromEntries(Object.entries(normalizedStorage.disks).map(([name, disk]) => [name,
      disk.driver === 's3' ? disk : { ...disk, root: resolve(projectRoot, disk.root as string) },
    ])),
  }
  const backends = new Map<string, StorageBackend>()
  const factories = new Map<string, () => StorageBackend>()

  for (const [diskName, disk] of Object.entries(runtimeStorage.disks)) {
    const factory = disk.driver === 's3'
      ? await createS3StorageBackendFactory(projectRoot, disk)
      : () => createFileStorageBackend(disk.root as string)
    factories.set(diskName, factory)
  }

  storageRuntime.configureStorageRuntime({
    getRuntimeConfig: () => ({
      holoStorage: runtimeStorage,
      holo: { appUrl: loadedConfig.app.url, appKey: loadedConfig.app.key },
    }),
    getStorage: (base: string) => {
      const diskName = base.replace(/^holo:/, '')
      const backend = backends.get(diskName)
      if (backend) return backend
      const factory = factories.get(diskName)
      /* v8 ignore start -- the public storage runtime rejects unknown disks before reaching this internal guard */
      if (!factory) {
        throw new Error(`[Holo Storage] Disk "${diskName}" backend is not configured.`)
      }
      /* v8 ignore stop */

      const created = factory()
      backends.set(diskName, created)
      return created
    },
  })
}

export async function resetOptionalStorageRuntime(): Promise<void> {
  const storageRuntime = await storageRuntimeInternals.importOptionalModule<StorageRuntimeModule>('@holo-js/storage/runtime')
  storageRuntime?.resetStorageRuntime()
}

export const storageRuntimeInternals = {
  createFileStorageBackend,
  decodeLocalStorageNames,
  importOptionalModule,
  writeCompleteChunk,
}
import type {} from '@holo-js/storage/config'
