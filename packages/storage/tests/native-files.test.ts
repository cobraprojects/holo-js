import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import { field, safeParse, schema } from '../../validation/src'
import { normalizeModuleOptions } from '../src/config'
import { configureStorageRuntime, resetStorageRuntime, withStorageFiles } from '../src/runtime/composables'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'holo-native-files-test-'))
  await Promise.all(['originals', 'retained'].map(name => mkdir(join(root, name))))
  const backends = new Map(['originals', 'retained'].map(name => [
    `holo:${name}`, storageRuntimeInternals.createFileStorageBackend(join(root, name)),
  ]))
  configureStorageRuntime({
    getRuntimeConfig: () => ({ holoStorage: normalizeModuleOptions({
      defaultDisk: 'originals',
      disks: Object.fromEntries(['originals', 'retained'].map(name => [name, { driver: 'local', root: join(root, name) }])),
    }) }),
    getStorage: (name) => {
      const backend = backends.get(name)
      if (!backend) throw new Error('Unexpected disk')
      return backend
    },
  })
})

afterEach(async () => {
  resetStorageRuntime()
  await rm(root, { recursive: true, force: true })
})

describe('borrowing native storage files', () => {
  it('validates arrays from multiple disks as native Files with detected MIME and original names', async () => {
    const png = await readFile(new URL('../../validation/tests/fixtures/images/valid.png', import.meta.url))
    await Promise.all([
      writeFile(join(root, 'originals', 'upload.txt'), png),
      writeFile(join(root, 'retained', 'saved.png'), png),
    ])
    const result = await withStorageFiles([
      { path: 'upload.txt', name: 'Original avatar.jpeg' },
      { disk: 'retained', path: 'saved.png' },
    ], async (files) => {
      for (const file of files) {
        expect(file).toBeInstanceOf(File)
        expect(file).toBeInstanceOf(Blob)
        expect(file.type).toBe('image/png')
        expect(file.size).toBe(png.length)
        expect(file.lastModified).toBe(0)
        expect(Buffer.from(await file.bytes())).toEqual(png)
        expect(await file.slice(1, 4).bytes()).toEqual(new Uint8Array(png.subarray(1, 4)))
        expect(Buffer.from(await new Response(file.stream()).arrayBuffer())).toEqual(png)
      }
      const contract = schema({ images: field.array(field.file().image()).customAsync(async (images) => {
        await Promise.resolve()
        return images.every(image => image instanceof File) && images[0]?.name === 'Original avatar.jpeg'
      }) })
      return safeParse({ images: files }, contract)
    })
    expect(result.valid).toBe(true)
    expect(result.data?.images?.map(file => file.name)).toEqual(['Original avatar.jpeg', 'saved.png'])
    expect(await readFile(join(root, 'retained', 'saved.png'))).toEqual(png)
  })

  it('lets the authoritative image validator reject corrupted content', async () => {
    const corrupted = await readFile(new URL('../../validation/tests/fixtures/images/corrupted-pixels.png', import.meta.url))
    await writeFile(join(root, 'originals', 'image.png'), corrupted)
    const result = await withStorageFiles([{ path: 'image.png' }], images => safeParse(
      { images }, schema({ images: field.array(field.file().image()) }),
    ))
    expect(result.valid).toBe(false)
  })

  it('assembles large sparse files without loading the collection into memory', async () => {
    const sources = []
    for (let index = 0; index < 100; index++) {
      const path = `${index}.bin`
      const handle = await open(join(root, 'originals', path), 'wx')
      try {
        await handle.truncate(1024 ** 3)
      } finally {
        await handle.close()
      }
      sources.push({ path })
    }
    await withStorageFiles(sources, async (files) => {
      expect(files).toHaveLength(100)
      expect(files.every(file => file.size === 1024 ** 3)).toBe(true)
      expect(await files[99]?.slice(-4).bytes()).toEqual(new Uint8Array(4))
      await writeFile(join(root, 'originals', '0.bin'), 'changed')
      await expect(files[0]?.arrayBuffer()).rejects.toThrow()
    })
  })

  it('preserves async callback failures and leaves original files intact', async () => {
    await writeFile(join(root, 'originals', 'notes.txt'), 'original')
    const failure = new Error('async validation failed')
    await expect(withStorageFiles([{ path: 'notes.txt' }], async (files) => {
      expect(await files[0]?.text()).toBe('original')
      await Promise.resolve()
      throw failure
    })).rejects.toBe(failure)
    expect(await readFile(join(root, 'originals', 'notes.txt'), 'utf8')).toBe('original')
  })

  it('rejects missing files, traversal, and symlinks escaping the configured root', async () => {
    await writeFile(join(root, 'secret.txt'), 'secret')
    await symlink(join(root, 'secret.txt'), join(root, 'originals', 'escape.txt'))
    for (const path of ['missing.txt', '../secret.txt', 'escape.txt']) {
      await expect(withStorageFiles([{ path }], () => { throw new Error('Callback must not run') })).rejects.not.toThrow('Callback must not run')
    }
  })

  it('handles empty collections and pre-aborted calls', async () => {
    expect(await withStorageFiles([], files => files.length)).toBe(0)
    const reason = new Error('cancelled')
    await expect(withStorageFiles([], () => 'unreachable', { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  })
})
