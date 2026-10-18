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
  it('reports the local file size with only the requested leading bytes for content inspection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-sample-'))
    tempDirs.push(root)
    const backend = storageRuntimeInternals.createFileStorageBackend(root)
    const contents = await readFile(new URL('../../kernel/tests/fixtures/mime/sample.wav', import.meta.url))
    await backend.setItemRaw('spoofed.png', contents)
    await expect(backend.getItemStat?.('spoofed.png', { sampleBytes: 16 })).resolves.toEqual({
      size: contents.length,
      sample: new Uint8Array(contents.subarray(0, 16)),
    })
    await backend.setItemRaw('empty.bin', new Uint8Array())
    await expect(backend.getItemStat?.('empty.bin', { sampleBytes: 16 })).resolves.toEqual({ size: 0, sample: new Uint8Array() })
  })

  it.each(['private', 'public'] as const)('serves persisted %s local files byte-for-byte through facade URLs', async (visibility) => {
    const root = await mkdtemp(join(tmpdir(), 'holo-storage-signed-local-'))
    tempDirs.push(root)
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/app.mjs'), `export default ${JSON.stringify({ url: 'https://app.test', key: 'native-private-storage-test-key' })}\n`)
    await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
      defaultDisk: 'local',
      disks: { local: { driver: visibility === 'public' ? 'public' : 'local', visibility, root: join(root, 'storage') } },
    })}\n`)
    const loadedConfig = await loadConfigDirectory(root, { preferCache: false })
    try {
      await configurePlainNodeStorageRuntime(resolve(import.meta.dirname, '../../..'), loadedConfig)
      const contents = await readFile(new URL('../../validation/tests/fixtures/images/valid.png', import.meta.url))
      for (const path of ['plain.png', 'Clipboard name.png', 'nested folder/صورة #1%.png', 'literal%20name.png', 'encoded%2Fname.png', 'encoded%5Cname.png', '%2e%2e/secret.png']) {
        await expect(Storage.put(path, contents)).resolves.toBe(true)
        expect(Buffer.from(await Storage.getBytes(path) ?? [])).toEqual(contents)
        if (visibility === 'private') expect(() => Storage.url(path)).toThrow('private')
        const url = Storage.temporaryUrl(path, { expiresIn: 60 })
        const response = await createPublicStorageResponse(root, loadedConfig.storage, new Request(url), loadedConfig.app.key)
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/png')
        expect(Buffer.from(await response.arrayBuffer())).toEqual(contents)
        const unsigned = new URL(url)
        unsigned.search = ''
        const rejected = await createPublicStorageResponse(root, loadedConfig.storage, new Request(unsigned), loadedConfig.app.key)
        expect(rejected.status).toBe(404)
        if (visibility === 'public') {
          const publicResponse = await createPublicStorageResponse(root, loadedConfig.storage, new Request(Storage.url(path)))
          expect(publicResponse.status).toBe(200)
          expect(Buffer.from(await publicResponse.arrayBuffer())).toEqual(contents)
        }
      }
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
