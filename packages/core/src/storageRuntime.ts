import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LoadedHoloConfig, HoloConfigMap } from '@holo-js/config'

type StorageBackend = {
  getItem<T = unknown>(key: string): Promise<T | null>
  getItemRaw(key: string): Promise<unknown>
  setItem(key: string, value: unknown): Promise<void>
  setItemRaw(key: string, value: string | Uint8Array | ArrayBuffer | Buffer): Promise<void>
  hasItem(key: string): Promise<boolean>
  removeItem(key: string): Promise<void>
  getKeys(base?: string): Promise<string[]>
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

/* v8 ignore next 15 -- optional-package absence is validated in published-package integration, not in this monorepo test graph */
async function importOptionalModule<TModule>(specifier: string): Promise<TModule | undefined> {
  try {
    if (process.env.VITEST) {
      return await import(/* @vite-ignore */ specifier) as TModule
    }

    const indirectEval = globalThis.eval as (source: string) => Promise<TModule>
    return await indirectEval(`import(${JSON.stringify(specifier)})`)
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return undefined
    }

    throw error
  }
}

export function resolveStorageKeyPath(root: string, key: string): string {
  const segments = key.split(':').filter(Boolean)
  if (segments.includes('..')) {
    throw new Error('[Holo Storage] Storage paths must not contain ".." segments.')
  }
  return resolve(root, ...segments)
}

function createFileStorageBackend(root: string): StorageBackend {
  async function listStorageKeys(currentRoot: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(currentRoot, { withFileTypes: true }).catch(() => [])
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
      const targetPath = resolveStorageKeyPath(root, key)
      try {
        return await readFile(targetPath)
      } catch {
        return null
      }
    },

    async setItem(key: string, value: unknown): Promise<void> {
      await this.setItemRaw(key, JSON.stringify(value))
    },

    async setItemRaw(key: string, value: string | Uint8Array | ArrayBuffer | Buffer): Promise<void> {
      const targetPath = resolveStorageKeyPath(root, key)
      await mkdir(dirname(targetPath), { recursive: true })
      await writeFile(
        targetPath,
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      )
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
async function createS3StorageBackend(disk: RuntimeDiskConfig): Promise<StorageBackend> {
  const storageS3 = await importOptionalModule<StorageS3Module>('@holo-js/storage/runtime/drivers/s3')
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
  const storageModule = await importOptionalModule<StorageModule>('@holo-js/storage')
  const storageRuntime = await importOptionalModule<StorageRuntimeModule>('@holo-js/storage/runtime')
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
      ? await createS3StorageBackend(disk)
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
  const storageRuntime = await importOptionalModule<StorageRuntimeModule>('@holo-js/storage/runtime')
  storageRuntime?.resetStorageRuntime()
}
