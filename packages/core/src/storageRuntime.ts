import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { LoadedHoloConfig, HoloConfigMap } from '@holo-js/config'
import { normalizeModuleOptions, type RuntimeDiskConfig } from '@holo-js/storage'
import {
  configureStorageRuntime,
  type StorageBackend,
} from '@holo-js/storage/runtime'
import createS3Driver from '@holo-js/storage/runtime/drivers/s3'

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

      /* v8 ignore next 7 -- readFile() returns Buffer for this file-backed adapter; the alternate branches only complete the backend contract. */
      const serialized = Buffer.isBuffer(value)
        ? value.toString('utf8')
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('utf8')
          : value instanceof ArrayBuffer
            ? Buffer.from(value).toString('utf8')
            : String(value)

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

function createS3StorageBackend(disk: RuntimeDiskConfig): StorageBackend {
  const driver = createS3Driver({
    bucket: disk.bucket,
    region: disk.region,
    endpoint: disk.endpoint,
    accessKeyId: disk.accessKeyId,
    secretAccessKey: disk.secretAccessKey,
    sessionToken: disk.sessionToken,
    forcePathStyleEndpoint: disk.forcePathStyleEndpoint,
  })

  return {
    getItem<T = unknown>(key: string): Promise<T | null> {
      return driver.getItem(key) as Promise<T | null>
    },
    getItemRaw: driver.getItemRaw,
    setItem: driver.setItem,
    setItemRaw: driver.setItemRaw,
    hasItem: driver.hasItem,
    removeItem: driver.removeItem,
    getKeys: driver.getKeys,
    getMeta<T = unknown>(key: string): Promise<T | null> {
      return driver.getMeta(key) as Promise<T | null>
    },
    clear: driver.clear,
  }
}

export function configurePlainNodeStorageRuntime<TCustom extends HoloConfigMap = HoloConfigMap>(
  projectRoot: string,
  loadedConfig: LoadedHoloConfig<TCustom>,
): void {
  const normalizedStorage = normalizeModuleOptions({
    defaultDisk: loadedConfig.storage.defaultDisk,
    routePrefix: loadedConfig.storage.routePrefix,
    disks: loadedConfig.storage.disks,
  })
  const backends = new Map<string, StorageBackend>()

  configureStorageRuntime({
    getRuntimeConfig: () => ({
      holoStorage: normalizedStorage,
      holo: { appUrl: loadedConfig.app.url },
    }),
    getStorage: (base: string) => {
      const diskName = base.replace(/^holo:/, '')
      const disk = normalizedStorage.disks[diskName]
      /* v8 ignore next 3 -- Storage facade validation rejects unknown disks before backend resolution in normal runtime flows. */
      if (!disk) {
        throw new Error(`[Holo Storage] Disk "${diskName}" is not configured.`)
      }

      const existing = backends.get(diskName)
      if (existing) {
        return existing
      }

      const backend = disk.driver === 's3'
        ? createS3StorageBackend(disk as RuntimeDiskConfig)
        : createFileStorageBackend(
            resolve(projectRoot, (disk as RuntimeDiskConfig).root as string),
          )
      backends.set(diskName, backend)
      return backend
    },
  })
}
