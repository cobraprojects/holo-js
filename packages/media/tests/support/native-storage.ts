import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { onTestFinished } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { Storage } from '../../../storage/src/runtime/composables'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../../../core/src/storageRuntime'

const projectRoot = resolve(import.meta.dirname, '../../../../apps/blog-next')
let loadedConfig: ReturnType<typeof loadConfigDirectory> | undefined

export async function createNativeMediaStorage() {
  const root = await mkdtemp(join(tmpdir(), 'holo-media-storage-'))
  const protectedDirectories = new Set<string>()
  loadedConfig ??= loadConfigDirectory(projectRoot, { preferCache: false })
  const config = await loadedConfig
  const storage = { ...config.storage, defaultDisk: 'public', disks: {
    public: { driver: 'public' as const, root: join(root, 'public'), url: 'https://cdn.test/public' },
    local: { driver: 'local' as const, root: join(root, 'local') },
    absolute: { driver: 'public' as const, root: join(root, 'absolute'), url: '/assets' },
    relative: { driver: 'public' as const, root: join(root, 'relative'), url: 'assets' },
    s3: { driver: 's3' as const, visibility: 'public' as const, bucket: 's3', region: 'us-east-1', endpoint: 'https://s3.example.test', accessKeyId: 'test-key', secretAccessKey: 'test-secret', forcePathStyleEndpoint: true },
  } }
  for (const name of ['public', 'local', 'absolute', 'relative']) await mkdir(join(root, name), { recursive: true })
  const configure = () => configurePlainNodeStorageRuntime(projectRoot, { ...config, app: { ...config.app, url: 'https://app.test', key: 'native-media-storage-signing-key' }, storage })
  await configure()
  onTestFinished(async () => {
    for (const path of protectedDirectories) await chmod(path, 0o755)
    await resetOptionalStorageRuntime()
    await rm(root, { recursive: true, force: true })
  })
  return {
    async setDefaultDisk(name: string) { storage.defaultDisk = name; await configure() },
    async failDelete(name: string, path: string) {
      const directory = dirname(Storage.disk(name).path(path))
      await chmod(directory, 0o555)
      protectedDirectories.add(directory)
    },
  }
}

export async function storageFiles(name: string): Promise<string[]> {
  const paths: string[] = []
  let cursor: string | null = null
  do {
    const page = await Storage.disk(name).listFiles('', { cursor, limit: 100 })
    paths.push(...page.paths)
    cursor = page.nextCursor
  } while (cursor)
  return paths
}
