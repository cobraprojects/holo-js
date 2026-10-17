import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { Storage } from '@holo-js/storage/runtime'
import { createPublicStorageResponse } from '@holo-js/storage'
import '@holo-js/storage/config'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createSymlinkedStorageDirectory(): Promise<{
  readonly backend: ReturnType<typeof storageRuntimeInternals.createFileStorageBackend>
  readonly outside: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'holo-storage-symlink-'))
  tempDirs.push(root)
  const storage = join(root, 'storage')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(storage), mkdir(outside)])
  await symlink(outside, join(storage, 'escape'))
  return {
    backend: storageRuntimeInternals.createFileStorageBackend(storage),
    outside,
  }
}

describe('@holo-js/core storage runtime optional imports', () => {
  it('reports MIME metadata from the encoded local file instead of its name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-mime-'))
    tempDirs.push(root)
    const backend = storageRuntimeInternals.createFileStorageBackend(root)
    const contents = await readFile(new URL('../../media/tests/fixtures/mime/sample.wav', import.meta.url))
    await backend.setItemRaw('spoofed.png', contents)
    await expect(backend.getItemStat?.('spoofed.png')).resolves.toEqual({ size: contents.length, mimeType: 'audio/wav' })
  })

  it('serves private local files through facade URLs signed by the discovered application key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-signed-local-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/app.mjs'), `export default ${JSON.stringify({ url: 'https://app.test', key: 'native-private-storage-test-key' })}\n`)
    await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
      defaultDisk: 'local',
      disks: { local: { driver: 'local', visibility: 'private', root: join(root, 'storage') } },
    })}\n`)
    const loadedConfig = await loadConfigDirectory(root, { preferCache: false })
    try {
      await configurePlainNodeStorageRuntime(resolve(import.meta.dirname, '../../..'), loadedConfig)
      await Storage.put('attachment.txt', 'Private persisted attachment')
      expect(() => Storage.url('attachment.txt')).toThrow('private')
      const url = Storage.temporaryUrl('attachment.txt', { expiresIn: 60 })
      const response = await createPublicStorageResponse(root, loadedConfig.storage, new Request(url), loadedConfig.app.key)
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('Private persisted attachment')
      const unsigned = new URL(url)
      unsigned.search = ''
      const rejected = await createPublicStorageResponse(root, loadedConfig.storage, new Request(unsigned), loadedConfig.app.key)
      expect(rejected.status).toBe(404)
    } finally {
      await resetOptionalStorageRuntime()
    }
  })

  it('uses local storage without initializing an unused S3 disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-local-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
      defaultDisk: 'local',
      disks: {
        local: { driver: 'local', root: join(root, 'storage') },
        s3: { driver: 's3' },
      },
    })}\n`)
    const loadedConfig = await loadConfigDirectory(root, { preferCache: false })

    try {
      await configurePlainNodeStorageRuntime(resolve(import.meta.dirname, '../../..'), loadedConfig)
      await Storage.disk('local').put('message.txt', 'Local storage is available')
      await expect(readFile(join(root, 'storage/message.txt'), 'utf8')).resolves.toBe('Local storage is available')
      await expect(Storage.disk('local').get('message.txt')).resolves.toBe('Local storage is available')
      await expect(Storage.disk('s3').put('message.txt', 'Missing credentials')).rejects.toThrow('accessKeyId')
    } finally {
      await resetOptionalStorageRuntime()
    }
  })

  it('rejects streamed writes through a symlinked storage parent', async () => {
    const { backend, outside } = await createSymlinkedStorageDirectory()
    if (!backend.setItemStream) throw new Error('The file storage backend must support streamed writes.')
    const source = (async function* (): AsyncGenerator<Uint8Array> {
      yield new TextEncoder().encode('private')
    })()

    await expect(backend.setItemStream('escape:private.txt', source, { overwrite: true })).rejects.toThrow(
      'Storage paths must stay inside the configured disk root',
    )
    await expect(readFile(join(outside, 'private.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects paginated listings through a symlinked storage directory', async () => {
    const { backend, outside } = await createSymlinkedStorageDirectory()
    if (!backend.getKeysPage) throw new Error('The file storage backend must support paginated listings.')
    await writeFile(join(outside, 'private.txt'), 'private')

    await expect(backend.getKeysPage('escape:', { cursor: null, limit: 10 })).rejects.toThrow(
      'Storage paths must stay inside the configured disk root',
    )
  })

})
