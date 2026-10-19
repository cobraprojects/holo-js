import { afterEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { Storage, useStorage } from '@holo-js/storage/runtime'
import { createPublicStorageResponse } from '@holo-js/storage'
import '@holo-js/storage/config'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime, storageRuntimeInternals } from '../src/storageRuntime'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'

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

async function configureLocalDisk(visibility: 'private' | 'public' = 'private'): Promise<{ readonly root: string, readonly storage: string, readonly outside: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'holo-storage-local-safety-')))
  tempDirs.push(root)
  const storage = join(root, 'storage')
  const outside = join(root, 'outside')
  await Promise.all([mkdir(join(root, 'config')), mkdir(storage), mkdir(outside)])
  await writeFile(join(root, 'config/storage.mjs'), `export default ${JSON.stringify({
    defaultDisk: 'local',
    disks: { local: { driver: visibility === 'public' ? 'public' : 'local', visibility, root: storage } },
  })}\n`)
  await configurePlainNodeStorageRuntime(root, await loadConfigDirectory(root, { preferCache: false }))
  return { root, storage, outside }
}

describe('@holo-js/core local storage safety', () => {
  afterEach(async () => {
    await resetOptionalStorageRuntime()
  })

  it.skipIf(process.platform === 'win32').each(['private', 'public'] as const)('creates %s storage with Laravel permissions even with a permissive umask', async (visibility) => {
    const { storage } = await configureLocalDisk(visibility)
    await rm(storage, { recursive: true })
    const previousUmask = process.umask(0)
    try {
      await Storage.put('nested/deep/file.txt', 'data')
      await Storage.writeStream('streamed/file.txt', (async function* () {
        yield new TextEncoder().encode('streamed')
      })())

      for (const path of ['', 'nested', 'nested/deep', 'streamed']) {
        expect((await stat(join(storage, path))).mode & 0o777).toBe(visibility === 'private' ? 0o700 : 0o755)
      }
      for (const path of ['nested/deep/file.txt', 'streamed/file.txt']) {
        expect((await stat(join(storage, path))).mode & 0o777).toBe(visibility === 'private' ? 0o600 : 0o644)
      }
      await expect(Storage.get('nested/deep/file.txt')).resolves.toBe('data')
      await rm(storage, { recursive: true })
      await useStorage('local').clear?.()
      expect((await stat(storage)).mode & 0o777).toBe(visibility === 'private' ? 0o700 : 0o755)
    } finally {
      process.umask(previousUmask)
    }
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

describe('local storage name decoding', () => {
  async function createDisk(): Promise<{ readonly root: string, readonly outside: string }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'holo-storage-decode-')))
    tempDirs.push(base)
    const root = join(base, 'disk')
    const outside = join(base, 'outside')
    await Promise.all([mkdir(root), mkdir(outside)])
    return { root, outside }
  }

  it('skips names Windows cannot store, reports why, and renames the rest', async () => {
    const { root } = await createDisk()
    for (const name of ['report%3A2026.txt', 'what%3F.txt', 'NUL%20.txt', 'CON%20', 'trail%2E%2E%2E', 'a%20.', 'a%0Ab.txt', 'plain%20name.txt']) {
      await writeFile(join(root, name), name)
    }

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'win32' })

    expect(result.renamed).toEqual([{ from: 'plain%20name.txt', to: 'plain name.txt' }])
    expect(result.skipped).toEqual(expect.arrayContaining([
      { path: 'report%3A2026.txt', reason: expect.stringContaining('Windows') },
      { path: 'what%3F.txt', reason: expect.stringContaining('Windows') },
      { path: 'NUL%20.txt', reason: expect.stringContaining('device name') },
      { path: 'CON%20', reason: expect.stringContaining('dot or a space') },
      { path: 'a%20.', reason: expect.stringContaining('dot or a space') },
      { path: 'a%0Ab.txt', reason: expect.stringContaining('Windows') },
    ]))
    expect(result.skipped).toHaveLength(6)
    expect((await readdir(root)).sort()).toEqual([
      'CON%20', 'NUL%20.txt', 'a%0Ab.txt', 'a%20.', 'plain name.txt', 'report%3A2026.txt', 'trail%2E%2E%2E', 'what%3F.txt',
    ])
  })

  it('renames names that are valid on POSIX, including ones with a colon', async () => {
    const { root } = await createDisk()
    await writeFile(join(root, 'report%3A2026.txt'), 'colon')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result).toEqual({ renamed: [{ from: 'report%3A2026.txt', to: 'report:2026.txt' }], skipped: [] })
    await expect(readFile(join(root, 'report:2026.txt'), 'utf8')).resolves.toBe('colon')
  })

  it('never follows a symbolic link and skips its metadata sidecar with it', async () => {
    const { root, outside } = await createDisk()
    await writeFile(join(outside, 'secret.txt'), 'private')
    await symlink(join(outside, 'secret.txt'), join(root, 'link%20name.txt'))
    await writeFile(join(root, 'link%20name.txt$'), '{"owner":"ops"}')
    await writeFile(join(root, 'plain%20file.txt'), 'data')
    await writeFile(join(root, 'plain%20file.txt$'), '{"owner":"billing"}')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([
      { from: 'plain%20file.txt', to: 'plain file.txt' },
      { from: 'plain%20file.txt$', to: 'plain file.txt$' },
    ])
    expect(result.skipped).toEqual([
      { path: 'link%20name.txt', reason: expect.stringContaining('symbolic link') },
      { path: 'link%20name.txt$', reason: expect.stringContaining('symbolic link') },
    ])
    expect((await lstat(join(root, 'link%20name.txt'))).isSymbolicLink()).toBe(true)
    await expect(readFile(join(root, 'link%20name.txt$'), 'utf8')).resolves.toBe('{"owner":"ops"}')
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('private')
  })

  it('keeps the file and its metadata together when the metadata is a symbolic link', async () => {
    const { root, outside } = await createDisk()
    await writeFile(join(outside, 'meta.json'), '{"owner":"ops"}')
    await writeFile(join(root, 'report%20one.txt'), 'data')
    await symlink(join(outside, 'meta.json'), join(root, 'report%20one.txt$'))

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'report%20one.txt', reason: expect.stringContaining('metadata is a symbolic link') },
      { path: 'report%20one.txt$', reason: expect.stringContaining('symbolic link') },
    ])
    expect((await readdir(root)).sort()).toEqual(['report%20one.txt', 'report%20one.txt$'])
  })

  it.skipIf(!canRestrictPermissions)('reports a failed rename and keeps renaming the rest', async () => {
    const { root } = await createDisk()
    await mkdir(join(root, 'locked%20dir'))
    await writeFile(join(root, 'locked%20dir', 'inner%20file.txt'), 'inner')
    await writeFile(join(root, 'after%20file.txt'), 'after')
    await chmod(join(root, 'locked%20dir'), 0o555)

    try {
      const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

      expect(result.renamed).toEqual(expect.arrayContaining([
        { from: 'after%20file.txt', to: 'after file.txt' },
        { from: 'locked%20dir', to: 'locked dir' },
      ]))
      expect(result.skipped).toEqual([
        { path: 'locked dir/inner%20file.txt', reason: expect.stringContaining('rename failed') },
      ])
    } finally {
      await chmod(join(root, 'locked dir'), 0o755)
    }
  })
})

describe('local storage name decoding pairs', () => {
  async function createPairDisk(): Promise<string> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'holo-storage-pairs-')))
    tempDirs.push(base)
    const root = join(base, 'disk')
    await mkdir(root)
    return root
  }

  it('keeps a file and its metadata together when only the metadata destination exists', async () => {
    const root = await createPairDisk()
    await writeFile(join(root, 'report%20one.txt'), 'data')
    await writeFile(join(root, 'report%20one.txt$'), '{"owner":"ops"}')
    await writeFile(join(root, 'report one.txt$'), '{"owner":"existing"}')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'report%20one.txt', reason: expect.stringContaining('its metadata was skipped') },
      { path: 'report%20one.txt$', reason: expect.stringContaining('"report one.txt$" already exists') },
    ])
    expect((await readdir(root)).sort()).toEqual(['report one.txt$', 'report%20one.txt', 'report%20one.txt$'])
    await expect(readFile(join(root, 'report%20one.txt$'), 'utf8')).resolves.toBe('{"owner":"ops"}')
  })

  it('keeps a file and its metadata together when only the data destination exists', async () => {
    const root = await createPairDisk()
    await writeFile(join(root, 'report%20two.txt'), 'data')
    await writeFile(join(root, 'report%20two.txt$'), '{"owner":"ops"}')
    await writeFile(join(root, 'report two.txt'), 'existing')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'report%20two.txt', reason: expect.stringContaining('"report two.txt" already exists') },
      { path: 'report%20two.txt$', reason: expect.stringContaining('its file was skipped') },
    ])
    expect((await readdir(root)).sort()).toEqual(['report two.txt', 'report%20two.txt', 'report%20two.txt$'])
  })

  it('decodes files inside folders whose own names are not encoded', async () => {
    const root = await createPairDisk()
    await mkdir(join(root, 'plain folder'))
    await writeFile(join(root, 'plain folder', 'inner%20file.txt'), 'inner')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result).toEqual({
      renamed: [{ from: 'plain folder/inner%20file.txt', to: 'plain folder/inner file.txt' }],
      skipped: [],
    })
    await expect(readFile(join(root, 'plain folder', 'inner file.txt'), 'utf8')).resolves.toBe('inner')
  })

  it('decodes directory names ending in the metadata suffix', async () => {
    const root = await createPairDisk()
    await mkdir(join(root, 'prices%24'))
    await writeFile(join(root, 'prices%24', 'report.txt'), 'data')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result).toEqual({ renamed: [{ from: 'prices%24', to: 'prices$' }], skipped: [] })
    await expect(readFile(join(root, 'prices$', 'report.txt'), 'utf8')).resolves.toBe('data')
  })

  it('renames a pair together when both destinations are free', async () => {
    const root = await createPairDisk()
    await writeFile(join(root, 'report%20three.txt'), 'data')
    await writeFile(join(root, 'report%20three.txt$'), '{"owner":"ops"}')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([
      { from: 'report%20three.txt', to: 'report three.txt' },
      { from: 'report%20three.txt$', to: 'report three.txt$' },
    ])
    expect(result.skipped).toEqual([])
    await expect(readFile(join(root, 'report three.txt$'), 'utf8')).resolves.toBe('{"owner":"ops"}')
  })

  it('reports a failed folder rollback and continues inside its current name', async () => {
    const root = await createPairDisk()
    await mkdir(join(root, 'report%20folder'))
    await writeFile(join(root, 'report%20folder', 'inner%20file.txt'), 'inner')
    await writeFile(join(root, 'report%20folder$'), '{}')
    const { rename } = await import('node:fs/promises')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, {
      platform: 'linux',
      rename: async (from, to) => {
        if (to.endsWith('$') || to.endsWith('report%20folder')) {
          throw Object.assign(new Error('injected'), { code: 'EIO' })
        }
        await rename(from, to)
      },
    })

    expect(result.skipped).toEqual([
      { path: 'report%20folder', reason: expect.stringContaining('could not restore its name: EIO') },
      { path: 'report%20folder$', reason: expect.stringContaining('rename failed: EIO') },
    ])
    expect(result.renamed).toEqual([
      { from: 'report folder/inner%20file.txt', to: 'report folder/inner file.txt' },
    ])
    await expect(readFile(join(root, 'report folder', 'inner file.txt'), 'utf8')).resolves.toBe('inner')
  })

  it('restores the file when the metadata rename fails after it succeeded', async () => {
    const root = await createPairDisk()
    await writeFile(join(root, 'report%20four.txt'), 'data')
    await writeFile(join(root, 'report%20four.txt$'), '{"owner":"ops"}')
    const { rename } = await import('node:fs/promises')

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, {
      platform: 'linux',
      rename: async (from, to) => {
        if (to.endsWith('$')) throw Object.assign(new Error('injected'), { code: 'EIO' })
        await rename(from, to)
      },
    })

    expect(result.renamed).toEqual([])
    expect(result.skipped).toEqual([
      { path: 'report%20four.txt', reason: expect.stringContaining('rename failed: EIO') },
      { path: 'report%20four.txt$', reason: expect.stringContaining('rename failed: EIO') },
    ])
    expect((await readdir(root)).sort()).toEqual(['report%20four.txt', 'report%20four.txt$'])
  })
})

describe('local storage name decoding collisions', () => {
  async function createCollisionDisk(): Promise<string> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'holo-storage-collisions-')))
    tempDirs.push(base)
    const root = join(base, 'disk')
    await mkdir(root)
    return root
  }

  it('skips every unit whose decoded names differ only by case or Unicode normalization', async () => {
    const root = await createCollisionDisk()
    const files = {
      'caf%C3%89.txt': 'upper',
      'caf%C3%A9.txt': 'nfc',
      'cafe%CC%81.txt': 'nfd',
      'plain%20file.txt': 'plain',
    }
    for (const [name, contents] of Object.entries(files)) await writeFile(join(root, name), contents)

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, { platform: 'linux' })

    expect(result.renamed).toEqual([{ from: 'plain%20file.txt', to: 'plain file.txt' }])
    expect(result.skipped).toEqual(expect.arrayContaining(['caf%C3%89.txt', 'caf%C3%A9.txt', 'cafe%CC%81.txt'].map(path => ({
      path,
      reason: expect.stringContaining('another decoded name'),
    }))))
    expect(result.skipped).toHaveLength(3)
    for (const [name, contents] of Object.entries(files)) {
      if (name === 'plain%20file.txt') continue
      await expect(readFile(join(root, name), 'utf8')).resolves.toBe(contents)
    }
  })

  it('checks destinations again right before renaming each unit', async () => {
    const root = await createCollisionDisk()
    await writeFile(join(root, 'a%20one.txt'), 'one')
    await writeFile(join(root, 'b%20two.txt'), 'two')
    await writeFile(join(root, 'b%20two.txt$'), '{"owner":"ops"}')
    const moved: string[] = []

    const result = await storageRuntimeInternals.decodeLocalStorageNames(root, {
      platform: 'linux',
      rename: async (from, to) => {
        moved.push(to)
        await storageRuntimeInternals.moveWithoutReplacing(from, to)
        if (to.endsWith('a one.txt')) await writeFile(join(root, 'b two.txt$'), '{"owner":"intruder"}')
      },
    })

    expect(result.renamed).toEqual([{ from: 'a%20one.txt', to: 'a one.txt' }])
    expect(result.skipped).toEqual([
      { path: 'b%20two.txt', reason: expect.stringContaining('its metadata was skipped') },
      { path: 'b%20two.txt$', reason: '"b two.txt$" already exists' },
    ])
    expect(moved).toEqual([join(root, 'a one.txt')])
    await expect(readFile(join(root, 'b two.txt$'), 'utf8')).resolves.toBe('{"owner":"intruder"}')
    await expect(readFile(join(root, 'b%20two.txt'), 'utf8')).resolves.toBe('two')
  })

  it('never replaces an existing file or folder when moving', async () => {
    const root = await createCollisionDisk()
    await writeFile(join(root, 'source.txt'), 'source')
    await writeFile(join(root, 'target.txt'), 'target')
    await mkdir(join(root, 'source-folder'))
    await mkdir(join(root, 'target-folder'))

    await expect(storageRuntimeInternals.moveWithoutReplacing(join(root, 'source.txt'), join(root, 'target.txt'))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(storageRuntimeInternals.moveWithoutReplacing(join(root, 'source-folder'), join(root, 'target-folder'))).rejects.toMatchObject({ code: 'EEXIST' })
    await expect(readFile(join(root, 'source.txt'), 'utf8')).resolves.toBe('source')
    await expect(readFile(join(root, 'target.txt'), 'utf8')).resolves.toBe('target')
    expect((await readdir(root)).sort()).toEqual(['source-folder', 'source.txt', 'target-folder', 'target.txt'])

    await storageRuntimeInternals.moveWithoutReplacing(join(root, 'source.txt'), join(root, 'moved.txt'))
    await storageRuntimeInternals.moveWithoutReplacing(join(root, 'source-folder'), join(root, 'moved-folder'))
    await expect(readFile(join(root, 'moved.txt'), 'utf8')).resolves.toBe('source')
    expect((await readdir(root)).sort()).toEqual(['moved-folder', 'moved.txt', 'target-folder', 'target.txt'])
  })
})
