import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { Storage, useStorage } from '@holo-js/storage/runtime'
import { createPublicStorageResponse } from '@holo-js/storage'
import '@holo-js/storage/config'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'

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

const canRestrictPermissions = process.platform !== 'win32' && process.getuid?.() !== 0

async function configureLocalDisk(): Promise<{ readonly root: string, readonly storage: string, readonly outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-storage-local-safety-')))
  tempDirs.push(root)
  const storage = join(root, 'storage')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(join(root, 'config')), mkdir(storage), mkdir(outside)])
  await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
    defaultDisk: 'local',
    disks: { local: { driver: 'local', root: storage } },
  })}\n`)
  await configurePlainNodeStorageRuntime(root, await loadConfigDirectory(root, { preferCache: false }))
  return { root, storage, outside }
}

describe('@holo-js/core local storage safety', () => {
  afterEach(async () => {
    await resetOptionalStorageRuntime()
  })

  it('refuses to delete files through a symlinked directory outside the disk root', async () => {
    const { storage, outside } = await configureLocalDisk()
    await writeFile(join(outside, 'private.txt'), 'private')
    await symlink(outside, join(storage, 'escape'))

    await expect(Storage.delete('escape/private.txt')).rejects.toThrow('Storage paths must stay inside the configured disk root')
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
  })

  it('rejects low-level keys whose decoded names leave the disk root', async () => {
    const { storage, outside } = await configureLocalDisk()
    await writeFile(join(outside, 'private.txt'), 'private')
    const local = useStorage('local')

    for (const key of ['%2E%2E:outside:private.txt', 'reports%2F..%2F..%2Foutside:private.txt', 'private%00.txt', '%2E']) {
      await expect(local.getItemRaw(key)).rejects.toThrow('[Holo Storage]')
      await expect(local.setItemRaw(key, 'overwritten')).rejects.toThrow('[Holo Storage]')
      await expect(local.removeItem(key)).rejects.toThrow('[Holo Storage]')
    }
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
    await expect(readdir(storage)).resolves.toEqual([])
  })

  it('refuses to delete a symlinked file that points outside the disk root', async () => {
    const { storage, outside } = await configureLocalDisk()
    await writeFile(join(outside, 'private.txt'), 'private')
    await symlink(join(outside, 'private.txt'), join(storage, 'link.txt'))

    await expect(Storage.delete('link.txt')).rejects.toThrow('Storage paths must stay inside the configured disk root')
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
  })

  it('deletes a symlink inside the disk root without deleting its target', async () => {
    const { storage } = await configureLocalDisk()
    await Storage.put('target.txt', 'kept')
    await symlink(join(storage, 'target.txt'), join(storage, 'alias.txt'))

    await expect(Storage.delete('alias.txt')).resolves.toBe(true)
    await expect(lstat(join(storage, 'alias.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(Storage.get('target.txt')).resolves.toBe('kept')
  })

  it('refuses to clear a directory that resolves outside the disk root', async () => {
    const { storage, outside } = await configureLocalDisk()
    await writeFile(join(outside, 'private.txt'), 'private')
    await symlink(outside, join(storage, 'escape'))

    await expect(useStorage('local').clear?.('escape')).rejects.toThrow('Storage paths must stay inside the configured disk root')
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
  })

  it('clears everything inside a symlinked disk root and keeps the root', async () => {
    const { root, outside } = await configureLocalDisk()
    const linkedRoot = join(root, 'linked')
    const real = join(root, 'real')
    await mkdir(real)
    await symlink(real, linkedRoot)
    await writeFile(join(outside, 'private.txt'), 'private')
    await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
      defaultDisk: 'local',
      disks: { local: { driver: 'local', root: linkedRoot } },
    })}\n`)
    await configurePlainNodeStorageRuntime(root, await loadConfigDirectory(root, { preferCache: false }))
    await Storage.put('nested/file.txt', 'remove me')
    await symlink(outside, join(real, 'escape'))

    await useStorage('local').clear?.()

    expect((await lstat(linkedRoot)).isSymbolicLink()).toBe(true)
    await expect(readdir(real)).resolves.toEqual([])
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
  })

  it('keeps the file when its sidecar metadata path leads outside the disk root', async () => {
    const { storage, outside } = await configureLocalDisk()
    await writeFile(join(outside, 'private.txt'), 'private')
    await Storage.put('report.txt', 'kept')
    await symlink(join(outside, 'private.txt'), join(storage, 'report.txt$'))

    await expect(Storage.delete('report.txt')).rejects.toThrow('Storage paths must stay inside the configured disk root')
    await expect(Storage.get('report.txt')).resolves.toBe('kept')
    await expect(readFile(join(outside, 'private.txt'), 'utf8')).resolves.toBe('private')
  })

  it('recreates a missing disk root when clearing everything', async () => {
    const { storage } = await configureLocalDisk()
    await rm(storage, { recursive: true })

    await useStorage('local').clear?.()

    expect((await lstat(storage)).isDirectory()).toBe(true)
  })

  it.skipIf(!canRestrictPermissions)('checks existence without reading file contents', async () => {
    const { storage } = await configureLocalDisk()
    await Storage.put('unreadable.txt', 'secret')
    await Storage.put('folder/file.txt', 'nested')
    await chmod(join(storage, 'unreadable.txt'), 0o000)

    await expect(Storage.exists('unreadable.txt')).resolves.toBe(true)
    await expect(Storage.exists('folder')).resolves.toBe(false)
    await expect(Storage.missing('absent.txt')).resolves.toBe(true)
  })

  it.skipIf(!canRestrictPermissions)('lists the next page without rescanning directories before the cursor', async () => {
    const { storage } = await configureLocalDisk()
    await Storage.put('a/first.txt', 'a')
    await Storage.put('b.txt', 'b')
    await Storage.put('c.txt', 'c')
    await Storage.put('d/next.txt', 'd')
    await Storage.put('z/last.txt', 'z')
    const disk = Storage.disk('local')

    const first = await disk.listFiles('', { limit: 2 })
    expect(first.paths).toEqual(['a/first.txt', 'b.txt'])
    await chmod(join(storage, 'a'), 0o000)
    await chmod(join(storage, 'z'), 0o000)
    try {
      const second = await disk.listFiles('', { limit: 1, cursor: first.nextCursor })
      expect(second.paths).toEqual(['c.txt'])
      expect(second.nextCursor).not.toBeNull()
    } finally {
      await chmod(join(storage, 'a'), 0o755)
      await chmod(join(storage, 'z'), 0o755)
    }
  })

  it('lists files in key order across nested directories', async () => {
    await configureLocalDisk()
    for (const path of ['a-b.txt', 'a/x.txt', 'a.txt', 'b/c/d.txt', 'b/c.txt', 'ab.txt']) {
      await Storage.put(path, path)
    }
    const disk = Storage.disk('local')
    const paths: string[] = []
    let cursor: string | null = null
    do {
      const page = await disk.listFiles('', { limit: 2, cursor })
      paths.push(...page.paths)
      cursor = page.nextCursor
    } while (cursor)

    expect(paths).toEqual(['a-b.txt', 'a.txt', 'a/x.txt', 'ab.txt', 'b/c.txt', 'b/c/d.txt'])
  })
})
